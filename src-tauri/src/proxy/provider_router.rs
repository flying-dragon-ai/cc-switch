//! 供应商路由器模块
//!
//! 负责选择和管理代理目标供应商，实现智能故障转移

use crate::app_config::AppType;
use crate::database::Database;
use crate::error::AppError;
use crate::provider::Provider;
use crate::proxy::circuit_breaker::{AllowResult, CircuitBreaker, CircuitBreakerConfig};
use rand::prelude::SliceRandom;
use std::collections::HashMap;
use std::str::FromStr;
use std::sync::Arc;
use tokio::sync::RwLock;

/// 供应商路由器
pub struct ProviderRouter {
    /// 数据库连接
    db: Arc<Database>,
    /// 熔断器管理器 - key 格式: "app_type:provider_id"
    circuit_breakers: Arc<RwLock<HashMap<String, Arc<CircuitBreaker>>>>,
    /// 模型级轮询游标 - key 格式: "app_type:model_key"
    model_failover_cursors: Arc<RwLock<HashMap<String, usize>>>,
}

impl ProviderRouter {
    /// 创建新的供应商路由器
    pub fn new(db: Arc<Database>) -> Self {
        Self {
            db,
            circuit_breakers: Arc::new(RwLock::new(HashMap::new())),
            model_failover_cursors: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    /// 选择可用的供应商（支持故障转移）
    ///
    /// 返回按优先级排序的可用供应商列表：
    /// - 故障转移关闭时：仅返回当前供应商
    /// - 故障转移开启时：仅使用故障转移队列，按队列顺序依次尝试（P1 → P2 → ...）
    pub async fn select_providers(
        &self,
        app_type: &str,
        model_key: Option<&str>,
    ) -> Result<Vec<Provider>, AppError> {
        let mut result = Vec::new();
        let mut circuit_open_count = 0usize;

        let auto_failover_enabled = match self.db.get_proxy_config_for_app(app_type).await {
            Ok(config) => config.auto_failover_enabled,
            Err(e) => {
                log::error!("[{app_type}] 读取 proxy_config 失败: {e}，默认禁用故障转移");
                false
            }
        };
        let routing_settings = self.db.get_claude_model_routing_settings()?;
        let model_key = model_key.map(str::to_string);
        let is_claude_model_context = app_type == "claude" && model_key.is_some();
        let use_model_failover = is_claude_model_context && routing_settings.model_failover_enabled;
        let use_model_routing = is_claude_model_context && routing_settings.route_enabled;

        let all_providers = self.db.get_all_providers(app_type)?;

        let current_id = AppType::from_str(app_type)
            .ok()
            .and_then(|app_enum| {
                crate::settings::get_effective_current_provider(&self.db, &app_enum)
                    .ok()
                    .flatten()
            })
            .or_else(|| self.db.get_current_provider(app_type).ok().flatten());

        let mut ordered_ids: Vec<String> = Vec::new();
        let model_policy = if is_claude_model_context {
            self.db
                .get_claude_model_route_policy(model_key.as_deref().unwrap_or("unknown"))
                .ok()
        } else {
            None
        };

        if use_model_failover {
            ordered_ids = self
                .db
                .get_failover_queue_for_model(app_type, model_key.as_deref().unwrap_or("unknown"))?
                .into_iter()
                .map(|item| item.provider_id)
                .collect();
            if !ordered_ids.is_empty() {
                let mode = model_policy
                    .as_ref()
                    .map(|policy| policy.model_failover_mode.as_str())
                    .unwrap_or("random");
                self.apply_model_failover_mode(
                    app_type,
                    model_key.as_deref().unwrap_or("unknown"),
                    &mut ordered_ids,
                    mode,
                )
                .await;
            }
        }
        if ordered_ids.is_empty() && auto_failover_enabled {
            ordered_ids = self
                .db
                .get_failover_queue(app_type)?
                .into_iter()
                .map(|item| item.provider_id)
                .collect();
        }
        if use_model_routing {
            if let Some(policy) = model_policy {
                if policy.enabled {
                    if let Some(default_id) = policy.default_provider_id {
                        let mut reordered = vec![default_id.clone()];
                        reordered.extend(ordered_ids.into_iter().filter(|id| id != &default_id));
                        ordered_ids = reordered;
                    }

                    if !policy.model_failover_enabled {
                        ordered_ids = ordered_ids.into_iter().take(1).collect();
                    }
                }
            }
        }

        if ordered_ids.is_empty() {
            if let Some(current_id) = current_id {
                ordered_ids.push(current_id);
            }
        }

        if ordered_ids.is_empty() {
            ordered_ids = all_providers.keys().cloned().collect();
            ordered_ids.sort();
        }

        let total_providers = ordered_ids.len();

        for provider_id in ordered_ids {
            let Some(provider) = all_providers.get(&provider_id).cloned() else {
                continue;
            };

            // 统一按 provider 维度熔断：任一模型类别失败后，该 provider 在所有模型备用链中都会被跳过
            let circuit_key = Self::circuit_key(app_type, &provider.id, None);
            let breaker = self.get_or_create_circuit_breaker(&circuit_key).await;

            if breaker.is_available().await {
                result.push(provider);
            } else {
                circuit_open_count += 1;
            }
        }

        if result.is_empty() {
            if total_providers > 0 && circuit_open_count == total_providers {
                log::warn!("[{app_type}] [FO-004] 所有供应商均已熔断");
                return Err(AppError::AllProvidersCircuitOpen);
            } else {
                log::warn!("[{app_type}] [FO-005] 未配置供应商");
                return Err(AppError::NoProvidersConfigured);
            }
        }

        Ok(result)
    }

    async fn apply_model_failover_mode(
        &self,
        app_type: &str,
        model_key: &str,
        ordered_ids: &mut Vec<String>,
        mode: &str,
    ) {
        if ordered_ids.len() <= 1 {
            return;
        }
        match mode {
            "random" => {
                let mut rng = rand::rng();
                ordered_ids.shuffle(&mut rng);
            }
            _ => {
                let cursor_key = format!("{app_type}:{model_key}");
                let mut cursors = self.model_failover_cursors.write().await;
                let cursor = cursors.entry(cursor_key).or_insert(0);
                let shift = *cursor % ordered_ids.len();
                if shift > 0 {
                    ordered_ids.rotate_left(shift);
                }
                *cursor = (*cursor + 1) % ordered_ids.len();
            }
        }
    }

    /// 请求执行前获取熔断器“放行许可”
    ///
    /// - Closed：直接放行
    /// - Open：超时到达后切到 HalfOpen 并放行一次探测
    /// - HalfOpen：按限流规则放行探测
    ///
    /// 注意：调用方必须在请求结束后通过 `record_result()` 释放 HalfOpen 名额，
    /// 否则会导致该 Provider 长时间无法进入探测状态。
    pub async fn allow_provider_request(
        &self,
        provider_id: &str,
        app_type: &str,
        model_key: Option<&str>,
    ) -> AllowResult {
        let circuit_key = Self::circuit_key(app_type, provider_id, model_key);
        let breaker = self.get_or_create_circuit_breaker(&circuit_key).await;
        breaker.allow_request().await
    }

    /// 记录供应商请求结果
    pub async fn record_result(
        &self,
        provider_id: &str,
        app_type: &str,
        model_key: Option<&str>,
        used_half_open_permit: bool,
        success: bool,
        error_msg: Option<String>,
    ) -> Result<(), AppError> {
        // 1. 按应用独立获取熔断器配置
        let failure_threshold = match self.db.get_proxy_config_for_app(app_type).await {
            Ok(app_config) => app_config.circuit_failure_threshold,
            Err(_) => 5, // 默认值
        };

        // 2. 更新熔断器状态
        let circuit_key = Self::circuit_key(app_type, provider_id, model_key);
        let breaker = self.get_or_create_circuit_breaker(&circuit_key).await;

        if success {
            breaker.record_success(used_half_open_permit).await;
        } else {
            breaker.record_failure(used_half_open_permit).await;
        }

        // 3. 更新数据库健康状态（使用配置的阈值）
        if app_type == "claude" {
            if let Some(model_key) = model_key {
                self.db
                    .update_provider_health_for_model_with_threshold(
                        provider_id,
                        app_type,
                        model_key,
                        success,
                        error_msg.clone(),
                        failure_threshold,
                    )
                    .await?;
            } else {
                self.db
                    .update_provider_health_with_threshold(
                        provider_id,
                        app_type,
                        success,
                        error_msg.clone(),
                        failure_threshold,
                    )
                    .await?;
            }
        } else {
            self.db
                .update_provider_health_with_threshold(
                    provider_id,
                    app_type,
                    success,
                    error_msg.clone(),
                    failure_threshold,
                )
                .await?;
        }

        Ok(())
    }

    /// 重置熔断器（手动恢复）
    pub async fn reset_circuit_breaker(&self, circuit_key: &str) {
        let breakers = self.circuit_breakers.read().await;
        if let Some(breaker) = breakers.get(circuit_key) {
            breaker.reset().await;
        }
    }

    /// 重置指定供应商的熔断器
    pub async fn reset_provider_breaker(
        &self,
        provider_id: &str,
        app_type: &str,
        model_key: Option<&str>,
    ) {
        let circuit_key = Self::circuit_key(app_type, provider_id, model_key);
        self.reset_circuit_breaker(&circuit_key).await;
    }

    /// 仅释放 HalfOpen permit，不影响健康统计（neutral 接口）
    ///
    /// 用于整流器等场景：请求结果不应计入 Provider 健康度，
    /// 但仍需释放占用的探测名额，避免 HalfOpen 状态卡死
    pub async fn release_permit_neutral(
        &self,
        provider_id: &str,
        app_type: &str,
        model_key: Option<&str>,
        used_half_open_permit: bool,
    ) {
        if !used_half_open_permit {
            return;
        }
        let circuit_key = Self::circuit_key(app_type, provider_id, model_key);
        let breaker = self.get_or_create_circuit_breaker(&circuit_key).await;
        breaker.release_half_open_permit();
    }

    /// 更新所有熔断器的配置（热更新）
    pub async fn update_all_configs(&self, config: CircuitBreakerConfig) {
        let breakers = self.circuit_breakers.read().await;
        for breaker in breakers.values() {
            breaker.update_config(config.clone()).await;
        }
    }

    /// 获取熔断器状态
    #[allow(dead_code)]
    pub async fn get_circuit_breaker_stats(
        &self,
        provider_id: &str,
        app_type: &str,
        model_key: Option<&str>,
    ) -> Option<crate::proxy::circuit_breaker::CircuitBreakerStats> {
        let circuit_key = Self::circuit_key(app_type, provider_id, model_key);
        let breakers = self.circuit_breakers.read().await;

        if let Some(breaker) = breakers.get(&circuit_key) {
            Some(breaker.get_stats().await)
        } else {
            None
        }
    }

    /// 获取或创建熔断器
    async fn get_or_create_circuit_breaker(&self, key: &str) -> Arc<CircuitBreaker> {
        // 先尝试读锁获取
        {
            let breakers = self.circuit_breakers.read().await;
            if let Some(breaker) = breakers.get(key) {
                return breaker.clone();
            }
        }

        // 如果不存在，获取写锁创建
        let mut breakers = self.circuit_breakers.write().await;

        // 双重检查，防止竞争条件
        if let Some(breaker) = breakers.get(key) {
            return breaker.clone();
        }

        // 从 key 中提取 app_type (格式: "app_type:provider_id")
        let app_type = key.split(':').next().unwrap_or("claude");

        // 按应用独立读取熔断器配置
        let config = match self.db.get_proxy_config_for_app(app_type).await {
            Ok(app_config) => crate::proxy::circuit_breaker::CircuitBreakerConfig {
                failure_threshold: app_config.circuit_failure_threshold,
                success_threshold: app_config.circuit_success_threshold,
                timeout_seconds: app_config.circuit_timeout_seconds as u64,
                error_rate_threshold: app_config.circuit_error_rate_threshold,
                min_requests: app_config.circuit_min_requests,
            },
            Err(_) => crate::proxy::circuit_breaker::CircuitBreakerConfig::default(),
        };

        let breaker = Arc::new(CircuitBreaker::new(config));
        breakers.insert(key.to_string(), breaker.clone());

        breaker
    }

    fn circuit_key(app_type: &str, provider_id: &str, _model_key: Option<&str>) -> String {
        format!("{app_type}:{provider_id}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::database::Database;
    use serde_json::json;
    use serial_test::serial;
    use std::env;
    use tempfile::TempDir;

    struct TempHome {
        #[allow(dead_code)]
        dir: TempDir,
        original_home: Option<String>,
        original_userprofile: Option<String>,
    }

    impl TempHome {
        fn new() -> Self {
            let dir = TempDir::new().expect("failed to create temp home");
            let original_home = env::var("HOME").ok();
            let original_userprofile = env::var("USERPROFILE").ok();

            env::set_var("HOME", dir.path());
            env::set_var("USERPROFILE", dir.path());
            crate::settings::reload_settings().expect("reload settings");

            Self {
                dir,
                original_home,
                original_userprofile,
            }
        }
    }

    impl Drop for TempHome {
        fn drop(&mut self) {
            match &self.original_home {
                Some(value) => env::set_var("HOME", value),
                None => env::remove_var("HOME"),
            }

            match &self.original_userprofile {
                Some(value) => env::set_var("USERPROFILE", value),
                None => env::remove_var("USERPROFILE"),
            }
        }
    }

    #[tokio::test]
    #[serial]
    async fn test_provider_router_creation() {
        let _home = TempHome::new();
        let db = Arc::new(Database::memory().unwrap());
        let router = ProviderRouter::new(db);

        let breaker = router.get_or_create_circuit_breaker("claude:test").await;
        assert!(breaker.allow_request().await.allowed);
    }

    #[tokio::test]
    #[serial]
    async fn test_failover_disabled_uses_current_provider() {
        let _home = TempHome::new();
        let db = Arc::new(Database::memory().unwrap());

        let provider_a =
            Provider::with_id("a".to_string(), "Provider A".to_string(), json!({}), None);
        let provider_b =
            Provider::with_id("b".to_string(), "Provider B".to_string(), json!({}), None);

        db.save_provider("claude", &provider_a).unwrap();
        db.save_provider("claude", &provider_b).unwrap();
        db.set_current_provider("claude", "a").unwrap();
        db.add_to_failover_queue("claude", "b").unwrap();

        let router = ProviderRouter::new(db.clone());
        let providers = router.select_providers("claude", None).await.unwrap();

        assert_eq!(providers.len(), 1);
        assert_eq!(providers[0].id, "a");
    }

    #[tokio::test]
    #[serial]
    async fn test_failover_enabled_uses_queue_order_ignoring_current() {
        let _home = TempHome::new();
        let db = Arc::new(Database::memory().unwrap());

        // 设置 sort_index 来控制顺序：b=1, a=2
        let mut provider_a =
            Provider::with_id("a".to_string(), "Provider A".to_string(), json!({}), None);
        provider_a.sort_index = Some(2);
        let mut provider_b =
            Provider::with_id("b".to_string(), "Provider B".to_string(), json!({}), None);
        provider_b.sort_index = Some(1);

        db.save_provider("claude", &provider_a).unwrap();
        db.save_provider("claude", &provider_b).unwrap();
        db.set_current_provider("claude", "a").unwrap();

        db.add_to_failover_queue("claude", "b").unwrap();
        db.add_to_failover_queue("claude", "a").unwrap();

        // 启用自动故障转移（使用新的 proxy_config API）
        let mut config = db.get_proxy_config_for_app("claude").await.unwrap();
        config.auto_failover_enabled = true;
        db.update_proxy_config_for_app(config).await.unwrap();

        let router = ProviderRouter::new(db.clone());
        let providers = router.select_providers("claude", None).await.unwrap();

        assert_eq!(providers.len(), 2);
        // 故障转移开启时：仅按队列顺序选择（忽略当前供应商）
        assert_eq!(providers[0].id, "b");
        assert_eq!(providers[1].id, "a");
    }

    #[tokio::test]
    #[serial]
    async fn test_failover_enabled_uses_queue_only_even_if_current_not_in_queue() {
        let _home = TempHome::new();
        let db = Arc::new(Database::memory().unwrap());

        let provider_a =
            Provider::with_id("a".to_string(), "Provider A".to_string(), json!({}), None);
        let mut provider_b =
            Provider::with_id("b".to_string(), "Provider B".to_string(), json!({}), None);
        provider_b.sort_index = Some(1);

        db.save_provider("claude", &provider_a).unwrap();
        db.save_provider("claude", &provider_b).unwrap();
        db.set_current_provider("claude", "a").unwrap();

        // 只把 b 加入故障转移队列（模拟“当前供应商不在队列里”的常见配置）
        db.add_to_failover_queue("claude", "b").unwrap();

        let mut config = db.get_proxy_config_for_app("claude").await.unwrap();
        config.auto_failover_enabled = true;
        db.update_proxy_config_for_app(config).await.unwrap();

        let router = ProviderRouter::new(db.clone());
        let providers = router.select_providers("claude", None).await.unwrap();

        assert_eq!(providers.len(), 1);
        assert_eq!(providers[0].id, "b");
    }

    #[tokio::test]
    #[serial]
    async fn test_select_providers_does_not_consume_half_open_permit() {
        let _home = TempHome::new();
        let db = Arc::new(Database::memory().unwrap());

        db.update_circuit_breaker_config(&CircuitBreakerConfig {
            failure_threshold: 1,
            timeout_seconds: 0,
            ..Default::default()
        })
        .await
        .unwrap();

        let provider_a =
            Provider::with_id("a".to_string(), "Provider A".to_string(), json!({}), None);
        let provider_b =
            Provider::with_id("b".to_string(), "Provider B".to_string(), json!({}), None);

        db.save_provider("claude", &provider_a).unwrap();
        db.save_provider("claude", &provider_b).unwrap();

        db.add_to_failover_queue("claude", "a").unwrap();
        db.add_to_failover_queue("claude", "b").unwrap();

        // 启用自动故障转移（使用新的 proxy_config API）
        let mut config = db.get_proxy_config_for_app("claude").await.unwrap();
        config.auto_failover_enabled = true;
        db.update_proxy_config_for_app(config).await.unwrap();

        let router = ProviderRouter::new(db.clone());

        router
            .record_result("b", "claude", None, false, false, Some("fail".to_string()))
            .await
            .unwrap();

        let providers = router.select_providers("claude", None).await.unwrap();
        assert_eq!(providers.len(), 2);

        assert!(router.allow_provider_request("b", "claude", None).await.allowed);
    }

    #[tokio::test]
    #[serial]
    async fn test_release_permit_neutral_frees_half_open_slot() {
        let _home = TempHome::new();
        let db = Arc::new(Database::memory().unwrap());

        // 配置熔断器：1 次失败即熔断，0 秒超时立即进入 HalfOpen
        db.update_circuit_breaker_config(&CircuitBreakerConfig {
            failure_threshold: 1,
            timeout_seconds: 0,
            ..Default::default()
        })
        .await
        .unwrap();

        let provider_a =
            Provider::with_id("a".to_string(), "Provider A".to_string(), json!({}), None);
        db.save_provider("claude", &provider_a).unwrap();
        db.add_to_failover_queue("claude", "a").unwrap();

        // 启用自动故障转移
        let mut config = db.get_proxy_config_for_app("claude").await.unwrap();
        config.auto_failover_enabled = true;
        db.update_proxy_config_for_app(config).await.unwrap();

        let router = ProviderRouter::new(db.clone());

        // 触发熔断：1 次失败
        router
            .record_result("a", "claude", None, false, false, Some("fail".to_string()))
            .await
            .unwrap();

        // 第一次请求：获取 HalfOpen 探测名额
        let first = router.allow_provider_request("a", "claude", None).await;
        assert!(first.allowed);
        assert!(first.used_half_open_permit);

        // 第二次请求应被拒绝（名额已被占用）
        let second = router.allow_provider_request("a", "claude", None).await;
        assert!(!second.allowed);

        // 使用 release_permit_neutral 释放名额（不影响健康统计）
        router
            .release_permit_neutral("a", "claude", None, first.used_half_open_permit)
            .await;

        // 第三次请求应被允许（名额已释放）
        let third = router.allow_provider_request("a", "claude", None).await;
        assert!(third.allowed);
        assert!(third.used_half_open_permit);
    }

    #[tokio::test]
    #[serial]
    async fn test_model_queue_preferred_when_model_failover_enabled() {
        let _home = TempHome::new();
        let db = Arc::new(Database::memory().unwrap());

        let provider_a =
            Provider::with_id("a".to_string(), "Provider A".to_string(), json!({}), None);
        let provider_b =
            Provider::with_id("b".to_string(), "Provider B".to_string(), json!({}), None);
        let provider_c =
            Provider::with_id("c".to_string(), "Provider C".to_string(), json!({}), None);

        db.save_provider("claude", &provider_a).unwrap();
        db.save_provider("claude", &provider_b).unwrap();
        db.save_provider("claude", &provider_c).unwrap();

        // 通用队列: a -> b
        db.set_failover_queue_for_model("claude", "haiku", &["b".to_string(), "c".to_string()])
            .unwrap();
        db.add_to_failover_queue("claude", "a").unwrap();
        db.add_to_failover_queue("claude", "b").unwrap();

        // 开启模型级故障转移
        db.set_claude_model_routing_settings(&crate::proxy::types::ClaudeModelRoutingSettings {
            route_enabled: true,
            model_failover_enabled: true,
        })
        .unwrap();

        let router = ProviderRouter::new(db.clone());
        let providers = router
            .select_providers("claude", Some("haiku"))
            .await
            .unwrap();

        assert_eq!(providers.len(), 2);
        assert_eq!(providers[0].id, "b");
        assert_eq!(providers[1].id, "c");
    }

    #[tokio::test]
    #[serial]
    async fn test_claude_model_context_circuit_shared_across_model_keys() {
        let _home = TempHome::new();
        let db = Arc::new(Database::memory().unwrap());

        let provider_a =
            Provider::with_id("a".to_string(), "Provider A".to_string(), json!({}), None);
        let provider_b =
            Provider::with_id("b".to_string(), "Provider B".to_string(), json!({}), None);

        db.save_provider("claude", &provider_a).unwrap();
        db.save_provider("claude", &provider_b).unwrap();
        db.add_to_failover_queue("claude", "a").unwrap();
        db.add_to_failover_queue("claude", "b").unwrap();

        let mut config = db.get_proxy_config_for_app("claude").await.unwrap();
        config.auto_failover_enabled = true;
        config.circuit_failure_threshold = 1;
        config.circuit_timeout_seconds = 600;
        db.update_proxy_config_for_app(config).await.unwrap();

        // 只开启模型路由（不启用模型级故障转移）
        db.set_claude_model_routing_settings(&crate::proxy::types::ClaudeModelRoutingSettings {
            route_enabled: true,
            model_failover_enabled: false,
        })
        .unwrap();

        let router = ProviderRouter::new(db.clone());

        // 让 provider a 在 sonnet 维度失败
        router
            .record_result(
                "a",
                "claude",
                Some("sonnet"),
                false,
                false,
                Some("sonnet failed".to_string()),
            )
            .await
            .unwrap();

        let sonnet_providers = router
            .select_providers("claude", Some("sonnet"))
            .await
            .unwrap();
        assert_eq!(
            sonnet_providers
                .iter()
                .map(|p| p.id.as_str())
                .collect::<Vec<_>>(),
            vec!["b"]
        );

        // 同一 provider 的其它模型（haiku）也会被跳过
        let haiku_providers = router
            .select_providers("claude", Some("haiku"))
            .await
            .unwrap();
        assert_eq!(
            haiku_providers
                .iter()
                .map(|p| p.id.as_str())
                .collect::<Vec<_>>(),
            vec!["b"]
        );
    }

    #[tokio::test]
    #[serial]
    async fn test_model_failover_round_robin_mode_rotates_order() {
        let _home = TempHome::new();
        let db = Arc::new(Database::memory().unwrap());

        let provider_a =
            Provider::with_id("a".to_string(), "Provider A".to_string(), json!({}), None);
        let provider_b =
            Provider::with_id("b".to_string(), "Provider B".to_string(), json!({}), None);
        let provider_c =
            Provider::with_id("c".to_string(), "Provider C".to_string(), json!({}), None);

        db.save_provider("claude", &provider_a).unwrap();
        db.save_provider("claude", &provider_b).unwrap();
        db.save_provider("claude", &provider_c).unwrap();
        db.set_failover_queue_for_model(
            "claude",
            "haiku",
            &["a".to_string(), "b".to_string(), "c".to_string()],
        )
        .unwrap();
        db.set_claude_model_routing_settings(&crate::proxy::types::ClaudeModelRoutingSettings {
            route_enabled: true,
            model_failover_enabled: true,
        })
        .unwrap();
        db.upsert_claude_model_route_policy(&crate::proxy::types::ClaudeModelRoutePolicy {
            app_type: "claude".to_string(),
            model_key: "haiku".to_string(),
            enabled: true,
            default_provider_id: None,
            model_failover_enabled: true,
            model_failover_mode: "round_robin".to_string(),
            updated_at: chrono::Utc::now().to_rfc3339(),
        })
        .unwrap();

        let router = ProviderRouter::new(db.clone());
        let first = router.select_providers("claude", Some("haiku")).await.unwrap();
        let second = router.select_providers("claude", Some("haiku")).await.unwrap();
        let third = router.select_providers("claude", Some("haiku")).await.unwrap();

        assert_eq!(
            first.iter().map(|p| p.id.as_str()).collect::<Vec<_>>(),
            vec!["a", "b", "c"]
        );
        assert_eq!(
            second.iter().map(|p| p.id.as_str()).collect::<Vec<_>>(),
            vec!["b", "c", "a"]
        );
        assert_eq!(
            third.iter().map(|p| p.id.as_str()).collect::<Vec<_>>(),
            vec!["c", "a", "b"]
        );
    }

    #[tokio::test]
    #[serial]
    async fn test_model_failover_random_mode_shuffles_order() {
        let _home = TempHome::new();
        let db = Arc::new(Database::memory().unwrap());

        let provider_a =
            Provider::with_id("a".to_string(), "Provider A".to_string(), json!({}), None);
        let provider_b =
            Provider::with_id("b".to_string(), "Provider B".to_string(), json!({}), None);
        let provider_c =
            Provider::with_id("c".to_string(), "Provider C".to_string(), json!({}), None);

        db.save_provider("claude", &provider_a).unwrap();
        db.save_provider("claude", &provider_b).unwrap();
        db.save_provider("claude", &provider_c).unwrap();
        db.set_failover_queue_for_model(
            "claude",
            "haiku",
            &["a".to_string(), "b".to_string(), "c".to_string()],
        )
        .unwrap();
        db.set_claude_model_routing_settings(&crate::proxy::types::ClaudeModelRoutingSettings {
            route_enabled: true,
            model_failover_enabled: true,
        })
        .unwrap();
        db.upsert_claude_model_route_policy(&crate::proxy::types::ClaudeModelRoutePolicy {
            app_type: "claude".to_string(),
            model_key: "haiku".to_string(),
            enabled: true,
            default_provider_id: None,
            model_failover_enabled: true,
            model_failover_mode: "random".to_string(),
            updated_at: chrono::Utc::now().to_rfc3339(),
        })
        .unwrap();

        let router = ProviderRouter::new(db.clone());
        let mut seen_orders = std::collections::HashSet::new();

        for _ in 0..20 {
            let providers = router.select_providers("claude", Some("haiku")).await.unwrap();
            let order = providers.iter().map(|p| p.id.clone()).collect::<Vec<_>>();
            let mut sorted = order.clone();
            sorted.sort();
            assert_eq!(sorted, vec!["a".to_string(), "b".to_string(), "c".to_string()]);
            seen_orders.insert(order.join(","));
        }

        assert!(seen_orders.len() > 1);
    }

    #[tokio::test]
    #[serial]
    async fn test_model_routing_policy_prioritizes_default_provider() {
        let _home = TempHome::new();
        let db = Arc::new(Database::memory().unwrap());

        let provider_a =
            Provider::with_id("a".to_string(), "Provider A".to_string(), json!({}), None);
        let provider_b =
            Provider::with_id("b".to_string(), "Provider B".to_string(), json!({}), None);

        db.save_provider("claude", &provider_a).unwrap();
        db.save_provider("claude", &provider_b).unwrap();

        db.add_to_failover_queue("claude", "a").unwrap();
        db.add_to_failover_queue("claude", "b").unwrap();

        let mut config = db.get_proxy_config_for_app("claude").await.unwrap();
        config.auto_failover_enabled = true;
        db.update_proxy_config_for_app(config).await.unwrap();

        db.set_claude_model_routing_settings(&crate::proxy::types::ClaudeModelRoutingSettings {
            route_enabled: true,
            model_failover_enabled: true,
        })
        .unwrap();

        db.upsert_claude_model_route_policy(&crate::proxy::types::ClaudeModelRoutePolicy {
            app_type: "claude".to_string(),
            model_key: "sonnet".to_string(),
            enabled: true,
            default_provider_id: Some("b".to_string()),
            model_failover_enabled: true,
            model_failover_mode: "round_robin".to_string(),
            updated_at: chrono::Utc::now().to_rfc3339(),
        })
        .unwrap();

        let router = ProviderRouter::new(db.clone());
        let providers = router
            .select_providers("claude", Some("sonnet"))
            .await
            .unwrap();

        assert_eq!(providers.len(), 2);
        assert_eq!(providers[0].id, "b");
        assert_eq!(providers[1].id, "a");
    }

    #[tokio::test]
    #[serial]
    async fn test_model_queue_falls_back_to_upstream() {
        let _home = TempHome::new();
        let db = Arc::new(Database::memory().unwrap());

        let provider_a =
            Provider::with_id("a".to_string(), "Provider A".to_string(), json!({}), None);
        let provider_b =
            Provider::with_id("b".to_string(), "Provider B".to_string(), json!({}), None);

        db.save_provider("claude", &provider_a).unwrap();
        db.save_provider("claude", &provider_b).unwrap();

        // 模型队列为空时，回退到上游全局队列 b
        db.add_to_failover_queue("claude", "b").unwrap();
        let mut config = db.get_proxy_config_for_app("claude").await.unwrap();
        config.auto_failover_enabled = true;
        db.update_proxy_config_for_app(config).await.unwrap();

        db.set_claude_model_routing_settings(&crate::proxy::types::ClaudeModelRoutingSettings {
            route_enabled: true,
            model_failover_enabled: true,
        })
        .unwrap();

        let router = ProviderRouter::new(db.clone());
        let providers = router
            .select_providers("claude", Some("haiku"))
            .await
            .unwrap();

        assert_eq!(providers.len(), 1);
        assert_eq!(providers[0].id, "b");
    }

    #[tokio::test]
    #[serial]
    async fn test_mixed_chain_ignored_even_when_auto_failover_enabled() {
        let _home = TempHome::new();
        let db = Arc::new(Database::memory().unwrap());

        let provider_a =
            Provider::with_id("a".to_string(), "Provider A".to_string(), json!({}), None);
        let provider_b =
            Provider::with_id("b".to_string(), "Provider B".to_string(), json!({}), None);
        let provider_c =
            Provider::with_id("c".to_string(), "Provider C".to_string(), json!({}), None);

        db.save_provider("claude", &provider_a).unwrap();
        db.save_provider("claude", &provider_b).unwrap();
        db.save_provider("claude", &provider_c).unwrap();

        // route_mode 展开结果使用模型队列：b
        db.set_claude_model_routing_settings(&crate::proxy::types::ClaudeModelRoutingSettings {
            route_enabled: true,
            model_failover_enabled: true,
        })
        .unwrap();
        db.set_failover_queue_for_model("claude", "haiku", &["b".to_string()])
            .unwrap();

        // 混合链：P1=a, P2=route_mode, P3=c
        db.set_fork_failover_chain(
            "claude",
            &[
                crate::database::ForkFailoverChainItem {
                    node_type: "provider".to_string(),
                    node_id: "a".to_string(),
                    provider_name: None,
                    sort_index: Some(0),
                },
                crate::database::ForkFailoverChainItem {
                    node_type: "route_mode".to_string(),
                    node_id: "route_mode".to_string(),
                    provider_name: None,
                    sort_index: Some(1),
                },
                crate::database::ForkFailoverChainItem {
                    node_type: "provider".to_string(),
                    node_id: "c".to_string(),
                    provider_name: None,
                    sort_index: Some(2),
                },
            ],
        )
        .unwrap();
        let mut config = db.get_proxy_config_for_app("claude").await.unwrap();
        config.auto_failover_enabled = true;
        db.update_proxy_config_for_app(config).await.unwrap();

        let router = ProviderRouter::new(db.clone());
        let providers = router
            .select_providers("claude", Some("haiku"))
            .await
            .unwrap();

        assert_eq!(providers.len(), 1);
        assert_eq!(providers[0].id, "b");
    }

    #[tokio::test]
    #[serial]
    async fn test_mixed_chain_ignored_when_auto_failover_disabled() {
        let _home = TempHome::new();
        let db = Arc::new(Database::memory().unwrap());

        let provider_a =
            Provider::with_id("a".to_string(), "Provider A".to_string(), json!({}), None);
        let provider_b =
            Provider::with_id("b".to_string(), "Provider B".to_string(), json!({}), None);

        db.save_provider("claude", &provider_a).unwrap();
        db.save_provider("claude", &provider_b).unwrap();
        db.set_current_provider("claude", "a").unwrap();

        db.set_fork_failover_chain(
            "claude",
            &[crate::database::ForkFailoverChainItem {
                node_type: "provider".to_string(),
                node_id: "b".to_string(),
                provider_name: None,
                sort_index: Some(0),
            }],
        )
        .unwrap();

        // 自动故障转移关闭时，混合链不应生效
        let mut config = db.get_proxy_config_for_app("claude").await.unwrap();
        config.auto_failover_enabled = false;
        db.update_proxy_config_for_app(config).await.unwrap();

        let router = ProviderRouter::new(db.clone());
        let providers = router.select_providers("claude", None).await.unwrap();

        assert_eq!(providers.len(), 1);
        assert_eq!(providers[0].id, "a");
    }
}

