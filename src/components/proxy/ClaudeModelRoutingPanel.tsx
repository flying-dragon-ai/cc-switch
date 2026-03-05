import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronsUpDown, Route, X } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  useClaudeModelRoutePolicies,
  useClaudeModelRoutingSettings,
  useUpdateClaudeModelRoutingSettings,
  useUpsertClaudeModelRoutePolicy,
} from "@/lib/query/proxy";
import { useFailoverQueueForModel } from "@/lib/query/failover";
import { useProvidersQuery } from "@/lib/query/queries";
import { ModelFailoverQueueManager } from "@/components/proxy/ModelFailoverQueueManager";
import type { ClaudeModelKey, ClaudeModelRoutePolicy } from "@/types/proxy";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";

const MODEL_ROWS: Array<{ key: ClaudeModelKey; label: string }> = [
  { key: "custom", label: "主模型" },
  { key: "opus", label: "Opus" },
  { key: "sonnet", label: "Sonnet" },
  { key: "haiku", label: "Haiku" },
  { key: "unknown", label: "Thinking" },
];

function ProviderCombobox({
  value,
  providers,
  disabled,
  placeholder,
  noneLabel,
  searchPlaceholder,
  emptyLabel,
  onChange,
}: {
  value: string;
  providers: Array<{ id: string; name: string }>;
  disabled?: boolean;
  placeholder: string;
  noneLabel: string;
  searchPlaceholder: string;
  emptyLabel: string;
  onChange: (next: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const selected = providers.find((provider) => provider.id === value);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          className="flex h-8 w-full items-center justify-between rounded-md border border-border-default bg-background px-3 py-1 text-sm disabled:cursor-not-allowed disabled:opacity-50"
        >
          <span className={cn("truncate text-left", !selected && "text-muted-foreground")}>
            {selected?.name ?? placeholder}
          </span>
          <span className="ml-2 flex shrink-0 items-center gap-1">
            {selected && (
              <X
                className="h-3.5 w-3.5 opacity-50 hover:opacity-100"
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  onChange("__none__");
                }}
              />
            )}
            <ChevronsUpDown className="h-3.5 w-3.5 opacity-50" />
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        className="z-[1000] w-[var(--radix-popover-trigger-width)] p-0"
        align="start"
        sideOffset={6}
      >
        <Command>
          <CommandInput placeholder={searchPlaceholder} />
          <CommandList>
            <CommandEmpty>{emptyLabel}</CommandEmpty>
            <CommandGroup>
              <CommandItem
                value="__none__"
                keywords={[noneLabel]}
                onSelect={() => {
                  onChange("__none__");
                  setOpen(false);
                }}
              >
                <Check
                  className={cn("mr-2 h-4 w-4", value === "" ? "opacity-100" : "opacity-0")}
                />
                {noneLabel}
              </CommandItem>
              {providers.map((provider) => (
                <CommandItem
                  key={provider.id}
                  value={provider.id}
                  keywords={[provider.name]}
                  onSelect={() => {
                    onChange(provider.id);
                    setOpen(false);
                  }}
                >
                  <Check
                    className={cn(
                      "mr-2 h-4 w-4",
                      value === provider.id ? "opacity-100" : "opacity-0",
                    )}
                  />
                  {provider.name}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

export function ClaudeModelRoutingPanel() {
  const { t } = useTranslation();
  const [activeModelKey, setActiveModelKey] = useState<ClaudeModelKey>("haiku");
  const upgradedLegacyModeRef = useRef(false);
  const { data: settings } = useClaudeModelRoutingSettings();
  const { data: policies = [] } = useClaudeModelRoutePolicies();
  const updateSettings = useUpdateClaudeModelRoutingSettings();
  const upsertPolicy = useUpsertClaudeModelRoutePolicy();
  const { data: providerData } = useProvidersQuery("claude");

  const providers = useMemo(
    () => Object.values(providerData?.providers ?? {}),
    [providerData?.providers],
  );
  const { data: sonnetQueue } = useFailoverQueueForModel("claude", "sonnet");
  const { data: opusQueue } = useFailoverQueueForModel("claude", "opus");
  const { data: haikuQueue } = useFailoverQueueForModel("claude", "haiku");
  const { data: customQueue } = useFailoverQueueForModel("claude", "custom");
  const { data: unknownQueue } = useFailoverQueueForModel("claude", "unknown");

  const policyMap = useMemo(() => {
    const map = new Map<ClaudeModelKey, ClaudeModelRoutePolicy>();
    for (const policy of policies) {
      map.set(policy.modelKey, policy);
    }
    return map;
  }, [policies]);

  const modelQueueCountMap = useMemo(
    () =>
      new Map<ClaudeModelKey, number>([
        ["sonnet", sonnetQueue?.length ?? 0],
        ["opus", opusQueue?.length ?? 0],
        ["haiku", haikuQueue?.length ?? 0],
        ["custom", customQueue?.length ?? 0],
        ["unknown", unknownQueue?.length ?? 0],
      ]),
    [sonnetQueue, opusQueue, haikuQueue, customQueue, unknownQueue],
  );

  const routeEnabled = settings?.routeEnabled ?? false;

  const savePolicy = async (
    modelKey: ClaudeModelKey,
    patch: Partial<ClaudeModelRoutePolicy>,
  ) => {
    const base =
      policyMap.get(modelKey) ??
      ({
        appType: "claude",
        modelKey,
        enabled: false,
        defaultProviderId: null,
        modelFailoverEnabled: true,
        modelFailoverMode: "random",
        updatedAt: new Date().toISOString(),
      } satisfies ClaudeModelRoutePolicy);

    await upsertPolicy.mutateAsync({
      ...base,
      ...patch,
      appType: "claude",
      modelKey,
      updatedAt: new Date().toISOString(),
    });
  };

  useEffect(() => {
    if (!settings) return;

    if (!settings.routeEnabled || settings.modelFailoverEnabled) {
      upgradedLegacyModeRef.current = false;
      return;
    }

    if (upgradedLegacyModeRef.current) return;
    upgradedLegacyModeRef.current = true;

    updateSettings.mutate({
      routeEnabled: true,
      modelFailoverEnabled: true,
    });
  }, [settings, updateSettings]);

  return (
    <div className="space-y-4 rounded-xl border border-border bg-card/50 p-4">
      <div className="space-y-1">
        <h4 className="text-sm font-semibold flex items-center gap-2">
          <Route className="h-4 w-4 text-cyan-500" />
          {t("proxy.claudeModelRouting.title", {
            defaultValue: "Claude 模型路由（自定义）",
          })}
        </h4>
        <p className="text-xs text-muted-foreground">
          {t("proxy.claudeModelRouting.description", {
            defaultValue:
              "先走模型首选，失败后按模型备用；全部失败再走全局备用。",
          })}
        </p>
      </div>

      <div className="text-xs font-medium text-foreground/90">
        {t("proxy.claudeModelRouting.step2", {
          defaultValue: "每类模型的首选站点",
        })}
      </div>
      <div className="overflow-hidden rounded-lg border border-border/60 bg-muted/10">
        <div className="hidden grid-cols-[110px_minmax(0,1fr)_170px_140px] items-center gap-3 border-b border-border/60 bg-muted/30 px-3 py-2 md:grid">
          <div className="text-xs font-medium text-muted-foreground">
            {t("proxy.claudeModelRouting.modelColumn", {
              defaultValue: "模型",
            })}
          </div>
          <div className="text-xs font-medium text-muted-foreground">
            {t("proxy.claudeModelRouting.defaultProvider", {
              defaultValue: "选择首选站点",
            })}
          </div>
          <div className="text-xs font-medium text-muted-foreground">
            {t("proxy.claudeModelRouting.failoverMode", {
              defaultValue: "模型备用模式",
            })}
          </div>
          <div className="text-xs font-medium text-muted-foreground md:justify-self-end">
            {t("proxy.claudeModelRouting.statusColumn", {
              defaultValue: "状态",
            })}
          </div>
        </div>
        <div className="divide-y divide-border/60">
          {MODEL_ROWS.map(({ key, label }) => {
            const policy = policyMap.get(key);
            const routeRowEnabled = policy?.enabled ?? false;
            const defaultProviderId = policy?.defaultProviderId ?? "";
            const modelFailoverMode = policy?.modelFailoverMode ?? "random";
            const routeActive = routeEnabled && routeRowEnabled && !!defaultProviderId;
            return (
              <div
                key={key}
                className="grid grid-cols-1 gap-2 px-3 py-3 md:grid-cols-[110px_minmax(0,1fr)_170px_140px] md:items-center md:gap-3"
              >
                <div className="text-sm font-medium">{label}</div>
                <div className="space-y-1">
                  <div className="text-[11px] text-muted-foreground md:hidden">
                    {t("proxy.claudeModelRouting.defaultProvider", {
                      defaultValue: "选择首选站点",
                    })}
                  </div>
                  <ProviderCombobox
                    value={defaultProviderId}
                    providers={providers}
                    placeholder={t("proxy.claudeModelRouting.defaultProvider", {
                      defaultValue: "选择首选站点",
                    })}
                    noneLabel={t("proxy.claudeModelRouting.none", {
                      defaultValue: "不固定（使用全局默认）",
                    })}
                    searchPlaceholder={t("proxy.claudeModelRouting.searchProvider", {
                      defaultValue: "输入名称搜索供应商...",
                    })}
                    emptyLabel={t("proxy.claudeModelRouting.providerNotFound", {
                      defaultValue: "未找到匹配供应商",
                    })}
                    onChange={(next) =>
                      savePolicy(key, {
                        defaultProviderId: next === "__none__" ? null : next,
                        enabled: next !== "__none__",
                        modelFailoverEnabled: next === "__none__" ? false : true,
                      })
                    }
                    disabled={
                      !routeEnabled || upsertPolicy.isPending || providers.length === 0
                    }
                  />
                </div>
                <div className="space-y-1">
                  <div className="text-[11px] text-muted-foreground md:hidden">
                    {t("proxy.claudeModelRouting.failoverMode", {
                      defaultValue: "模型备用模式",
                    })}
                  </div>
                  <Select
                    value={modelFailoverMode}
                    onValueChange={(next) =>
                      savePolicy(key, {
                        modelFailoverMode: next as "round_robin" | "random",
                      })
                    }
                    disabled={!routeEnabled || upsertPolicy.isPending}
                  >
                    <SelectTrigger className="h-8">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="round_robin">
                        {t("proxy.claudeModelRouting.failoverModeRoundRobin", {
                          defaultValue: "轮询",
                        })}
                      </SelectItem>
                      <SelectItem value="random">
                        {t("proxy.claudeModelRouting.failoverModeRandom", {
                          defaultValue: "随机",
                        })}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="md:justify-self-end">
                  <span
                    className={cn(
                      "inline-flex rounded px-1.5 py-0.5 text-[10px] font-medium",
                      routeActive
                        ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-200"
                        : "bg-slate-100 text-slate-700 dark:bg-slate-800/80 dark:text-slate-200",
                    )}
                  >
                    {routeActive
                      ? t("proxy.claudeModelRouting.rowRouteActive", {
                          defaultValue: "已固定首选站点",
                        })
                      : t("proxy.claudeModelRouting.rowRouteInactive", {
                          defaultValue: "未固定（使用全局默认）",
                        })}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="space-y-3 border-t border-border/50 pt-4">
        <div className="space-y-1">
          <h5 className="text-xs font-medium text-foreground/90">
            {t("proxy.claudeModelRouting.step3", {
              defaultValue: "模型备用顺序",
            })}
          </h5>
          <h5 className="text-sm font-semibold">
            {t("proxy.claudeModelRouting.modelQueueTitle", {
              defaultValue: "模型备用队列",
            })}
          </h5>
          <p className="text-xs text-muted-foreground">
            {t("proxy.claudeModelRouting.modelQueueDescription", {
              defaultValue:
                "从上到下依次尝试；若该模型未配置备用列表，则回退全局备用队列。",
            })}
          </p>
        </div>

        <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
          {MODEL_ROWS.map(({ key, label }) => (
            <button
              key={key}
              type="button"
              className={
                activeModelKey === key
                  ? "rounded-md border border-primary bg-primary/10 px-2 py-1.5 text-xs font-medium text-primary"
                  : "rounded-md border border-border/60 px-2 py-1.5 text-xs text-muted-foreground hover:text-foreground"
              }
              onClick={() => setActiveModelKey(key)}
            >
              {label} ({modelQueueCountMap.get(key) ?? 0})
            </button>
          ))}
        </div>

        {routeEnabled ? (
          <div className="rounded-lg border border-border/60 p-3">
            <ModelFailoverQueueManager
              appType="claude"
              modelKey={activeModelKey}
              disabled={!routeEnabled}
            />
          </div>
        ) : (
          <div className="rounded-lg border border-dashed border-border/60 bg-muted/20 p-3 text-xs text-muted-foreground">
            {t("proxy.claudeModelRouting.queueDisabledHint", {
              defaultValue:
                "模型路由当前未启用。请先回到供应商列表，启用“Claude 模型路由（模型->供应商）”。",
            })}
          </div>
        )}
      </div>
    </div>
  );
}
