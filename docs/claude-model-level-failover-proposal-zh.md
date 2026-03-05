# Claude 模型族定向路由 + 模型级故障转移方案（Fork 可维护版）

## 1. 文档目的

本文定义 Claude 代理增强方案，覆盖两类诉求：

1. 模型族定向路由：例如 `sonnet/opus` 固定走供应商 A，`haiku` 固定走供应商 B
2. 模型级故障转移：某模型族失败时，仅该模型族切换到备选供应商，不影响其它模型族

同时明确如何以最小冲突方式在 Fork 中实现，并保证后续同步上游可持续。

---

## 2. 一句话需求

把当前“Claude 一处失败全局切换”改成“先按模型族定向分流，哪条模型族坏了就只切那条”。

---

## 3. 背景与现状

### 3.1 当前行为

当前 Claude 故障转移是应用级（`app_type=claude`）粒度：

- 健康状态共享
- 熔断状态共享
- 当前目标供应商共享

因此，当 Haiku 失败时，可能导致 Sonnet/Opus 也一起切到 P2。

### 3.2 新增痛点

除了“故障影响面过大”，还存在“主动分流需求”：

- 用户希望 Sonnet 走 A（质量/稳定性更好）
- 用户希望 Haiku 走 B（便宜/快）

当前系统无法表达“不同模型族默认走不同供应商”。

---

## 4. 痛点分析

### 4.1 主动策略无法表达

系统只有“当前 Claude 供应商”，没有“Claude 各模型族默认供应商”。

### 4.2 局部故障被放大

一个模型族故障会拖动全局切换，影响其它本来可用的模型族。

### 4.3 成本与质量不可控

缺乏模型族分流后，低价模型与高质量模型无法各自走最优线路。

### 4.4 可观测性不匹配

日志有模型信息，但路由与健康维度仍是应用级，定位成本高。

---

## 5. 目标与非目标

### 5.1 目标

1. 支持 Claude 模型族级默认路由（A/B 分流）
2. 支持 Claude 模型族级故障转移（互不影响）
3. 默认兼容现有行为（开关关闭时不变）
4. Fork 实现对上游最小入侵，易于长期同步

### 5.2 非目标

1. 本期不改 Codex/Gemini 逻辑
2. 本期不做复杂策略引擎（权重、时间窗、地域策略）
3. 本期不改上游现有数据表语义，仅新增 Fork 扩展结构

---

## 6. 方案总览

## 6.1 核心模型

每个 Claude 请求先归类 `model_key`（模型族）：

- `haiku`
- `sonnet`
- `opus`
- `custom`
- `unknown`

再按以下顺序选路：

1. 查该 `model_key` 的“默认供应商”（定向路由）
2. 若默认供应商不可用，按该 `model_key` 自己的备选队列故障转移
3. 不影响其它 `model_key` 的当前目标

## 6.2 关键行为示例

- 规则：`sonnet -> A`，`haiku -> B`
- 运行中：A 的 Sonnet 正常，B 的 Haiku 正常
- 若 Haiku(B)故障：仅 Haiku 切到其备选（例如 C），Sonnet 仍走 A

---

## 7. 详细设计

## 7.1 模型归类规则

建议按关键词稳定归类（避免完整模型名版本漂移）：

- 包含 `haiku` -> `haiku`
- 包含 `sonnet` -> `sonnet`
- 包含 `opus` -> `opus`
- 其它非空 -> `custom`
- 缺失/解析失败 -> `unknown`

## 7.2 新增数据结构（Fork 独立）

为降低上游冲突，新增 `fork_` 前缀表：

1. `fork_model_route_policy`
- 主键：`(app_type, model_key)`
- 字段：`default_provider_id`, `enabled`, `updated_at`

2. `fork_provider_health_model`
- 主键：`(provider_id, app_type, model_key)`
- 字段：`is_healthy`, `consecutive_failures`, `last_error`, `updated_at` 等

3. `fork_active_target_model`（可选，便于 UI 展示）
- 主键：`(app_type, model_key)`
- 字段：`provider_id`, `provider_name`, `updated_at`

说明：不改上游 `provider_health` 原结构，避免高冲突迁移。

## 7.3 熔断器维度

当前键：`app_type:provider_id`  
目标键：`app_type:model_key:provider_id`

每个模型族独立熔断、独立恢复。

## 7.4 路由流程

1. Claude 请求进入 handler
2. 提取请求 `model` 并归类 `model_key`
3. 根据 `model_key` 获取默认供应商
4. 若不可用，按该 `model_key` 备选链路尝试（P1->P2->...）
5. 成功后更新该 `model_key` 的 active target
6. 失败/成功统计仅写入该 `model_key` 健康状态

## 7.5 向后兼容开关

新增功能开关（默认关闭）：

1. `claude_model_route_enabled`
2. `claude_model_level_failover_enabled`

行为：

- 都关闭：完全维持现有应用级逻辑
- 仅开路由：按模型族默认供应商分流，但仍可回落应用级故障策略
- 都开启：完整模型族定向路由 + 模型级故障转移

---

## 8. UI 与交互建议

## 8.1 配置入口

在 Claude 代理设置增加“模型族路由策略”区块：

- Haiku 默认供应商
- Sonnet 默认供应商
- Opus 默认供应商
- Custom/Unknown 兜底供应商

## 8.2 状态展示

代理状态展示从单行升级为多行：

- Claude/Sonnet -> A
- Claude/Haiku -> B 或 C（故障时）
- Claude/Opus -> A

---

## 9. 上游同步低冲突策略（重点）

## 9.1 原则

1. 新增模块优先，不在上游核心文件堆大逻辑
2. 仅在固定入口“薄接线”
3. 新表/新命令用 `fork_` 前缀隔离
4. 默认关闭，保证上游行为等价

## 9.2 代码组织建议

新增目录：

- `src-tauri/src/fork/model_routing/`

建议模块：

- `model_key.rs`：模型归类
- `policy_repo.rs`：路由策略 DAO
- `health_repo.rs`：模型级健康 DAO
- `router_ext.rs`：模型级选路
- `breaker_ext.rs`：模型级熔断封装

## 9.3 最小接线文件

仅修改以下文件的少量入口代码：

1. `src-tauri/src/proxy/handler_context.rs`（传递 `model_key`）
2. `src-tauri/src/proxy/provider_router.rs`（调用模型级选路扩展）
3. `src-tauri/src/proxy/forwarder.rs`（调用模型级健康/熔断写入）
4. `src-tauri/src/database/schema.rs`（增加 `fork_` 扩展表）

## 9.4 同步上游操作建议

1. rebase 上游后先检查上述 4 个接线文件
2. `fork/model_routing` 模块通常可原样保留
3. 维护 `FORK_CHANGES.md` 的“接线点清单”，降低人工排查成本

---

## 10. 分阶段实施计划

## Phase 1：后端 MVP（无 UI）

1. 模型归类
2. 路由策略表 + 健康表
3. Claude 选路和故障转移接入模型族维度
4. 双开关接入（默认关闭）

验收：

- `sonnet -> A`, `haiku -> B` 可生效
- Haiku 故障不影响 Sonnet
- 开关关闭与当前行为一致

## Phase 2：UI 与可观测性

1. 新增模型族策略配置界面
2. 新增模型族级 active target 展示
3. 日志补充 `model_key`

## Phase 3：灰度上线

1. 小范围开启
2. 观察错误率、切换率、成本变化
3. 达标后决定默认开启策略

---

## 11. 预期收益

### 11.1 用户收益

1. 可主动设定模型族最优供应商（质量/成本分层）
2. 单模型族故障不再影响全局
3. 体验更稳定、行为更符合直觉

### 11.2 业务收益

1. 降低不必要切换导致的成本上升
2. 提升请求成功率与稳定性

### 11.3 工程收益

1. 低侵入 Fork 架构，长期维护压力可控
2. 为后续 Codex/Gemini 精细路由提供可复用框架

---

## 12. 风险与应对

## 12.1 归类误判风险

应对：`unknown` 兜底 + 可配置默认供应商。

## 12.2 状态复杂度提升

应对：按模型族而非完整模型名建模，控制状态规模。

## 12.3 与上游变更冲突

应对：模块隔离、薄接线、`fork_` 命名、默认关闭。

---

## 13. 测试与验收清单

1. 回归：开关关闭时行为与当前版本一致
2. 路由：`sonnet -> A`、`haiku -> B` 实际生效
3. 故障：仅 Haiku 失败时只切 Haiku
4. 恢复：Haiku 上游恢复后仅 Haiku 回切
5. 边界：`model` 缺失时走 `unknown` 兜底策略
6. 并发：不同模型族并发请求互不串扰

---

## 14. 结论

该方案不仅解决“单模型故障导致 Claude 全局切换”的问题，还新增“按模型族定向路由”能力；通过 Fork 独立模块和最小接线策略，可以在不破坏上游同步能力的前提下落地。
