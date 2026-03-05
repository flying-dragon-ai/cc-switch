import { useEffect, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Cpu } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  useClaudeModelRoutePolicies,
  useClaudeModelRoutingSettings,
  useUpdateClaudeModelRoutingSettings,
} from "@/lib/query/proxy";
import { useTranslation } from "react-i18next";
import type { Provider } from "@/types";
import { Switch } from "@/components/ui/switch";

type FamilyUiKey = "main" | "opus" | "sonnet" | "haiku" | "thinking";
type BackendModelKey = "custom" | "opus" | "sonnet" | "haiku" | "unknown";

interface ClaudeRoutingModeBannerProps {
  providers: Record<string, Provider>;
  currentProviderId: string;
  onOpenProxySettings: (target?: "fork") => void;
}

interface ProviderSwitchedPayload {
  appType?: string;
  providerId?: string;
  source?: string;
  modelKey?: BackendModelKey;
}

const FAMILY_ROWS: Array<{
  key: FamilyUiKey;
  label: string;
  modelKey: BackendModelKey;
}> = [
  { key: "main", label: "主模型", modelKey: "custom" },
  { key: "opus", label: "Opus", modelKey: "opus" },
  { key: "sonnet", label: "Sonnet", modelKey: "sonnet" },
  { key: "haiku", label: "Haiku", modelKey: "haiku" },
  { key: "thinking", label: "Thinking", modelKey: "unknown" },
];

function ModeBadge({
  routeEnabled,
  modelFailoverEnabled,
}: {
  routeEnabled: boolean;
  modelFailoverEnabled: boolean;
}) {
  const { t } = useTranslation();

  let text = t("proxy.mode.global", {
    defaultValue: "全局故障转移模式",
  });
  let className =
    "bg-slate-100 text-slate-700 dark:bg-slate-800/80 dark:text-slate-200";

  if (modelFailoverEnabled && routeEnabled) {
    text = t("proxy.mode.modelRoutingAndFailover", {
      defaultValue: "模型级故障转移 + 模型族定向路由",
    });
    className =
      "bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-200";
  } else if (modelFailoverEnabled) {
    text = t("proxy.mode.modelFailover", {
      defaultValue: "模型级故障转移模式",
    });
    className =
      "bg-cyan-100 text-cyan-700 dark:bg-cyan-900/40 dark:text-cyan-200";
  } else if (routeEnabled) {
    text = t("proxy.mode.modelRouting", {
      defaultValue: "模型族定向路由模式",
    });
    className =
      "bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-200";
  }

  return (
    <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${className}`}>
      {text}
    </span>
  );
}

export function ClaudeRoutingModeBanner({
  providers,
  currentProviderId,
  onOpenProxySettings,
}: ClaudeRoutingModeBannerProps) {
  const { t } = useTranslation();
  const { data: settings } = useClaudeModelRoutingSettings();
  const updateRoutingSettings = useUpdateClaudeModelRoutingSettings();
  const { data: policies = [] } = useClaudeModelRoutePolicies();
  const [recentSwitch, setRecentSwitch] = useState<string>("");
  const [actualProviderByModelKey, setActualProviderByModelKey] = useState<
    Partial<Record<BackendModelKey, string>>
  >({});
  const [sourceByModelKey, setSourceByModelKey] = useState<
    Partial<Record<BackendModelKey, string>>
  >({});

  const routeEnabled = settings?.routeEnabled ?? false;
  const modelFailoverEnabled = settings?.modelFailoverEnabled ?? false;

  const policyByModelKey = useMemo(() => {
    const map = new Map<string, (typeof policies)[number]>();
    for (const policy of policies) {
      map.set(policy.modelKey, policy);
    }
    return map;
  }, [policies]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    const setup = async () => {
      unlisten = await listen<ProviderSwitchedPayload>(
        "provider-switched",
        (event) => {
          const payload = event.payload;
          if (payload?.appType !== "claude") return;
          const providerName =
            providers[payload.providerId ?? ""]?.name ?? payload.providerId ?? "";
          const modelKey = payload.modelKey;
          if (modelKey && payload.providerId) {
            setActualProviderByModelKey((prev) => ({
              ...prev,
              [modelKey]: payload.providerId as string,
            }));
            if (payload.source) {
              setSourceByModelKey((prev) => ({
                ...prev,
                [modelKey]: payload.source as string,
              }));
            }
          }
          const sourceLabel =
            payload.source === "failover"
              ? t("proxy.switchSource.failover", { defaultValue: "故障转移" })
              : payload.source === "failoverEnabled"
                ? t("proxy.switchSource.failoverEnabled", {
                    defaultValue: "开启故障转移",
                  })
                : t("proxy.switchSource.manual", { defaultValue: "手动切换" });

          setRecentSwitch(
            t("proxy.mode.recentSwitch", {
              defaultValue: "最近切换：{{provider}}（{{source}}）",
              provider: providerName || "-",
              source: sourceLabel,
            }),
          );
        },
      );
    };

    setup();
    return () => {
      unlisten?.();
    };
  }, [providers, t]);

  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-xl border border-border p-4 transition-all duration-300",
        "bg-card text-card-foreground group cursor-pointer",
        routeEnabled ? "hover:border-emerald-500/50" : "hover:border-border-active",
        routeEnabled && "border-emerald-500/60 shadow-sm shadow-emerald-500/10",
      )}
      role="button"
      tabIndex={0}
      onClick={() => onOpenProxySettings("fork")}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpenProxySettings("fork");
        }
      }}
    >
      <div
        className={cn(
          "absolute inset-0 bg-gradient-to-r to-transparent transition-opacity duration-500 pointer-events-none",
          routeEnabled ? "from-emerald-500/10 opacity-100" : "from-primary/10 opacity-0",
        )}
      />
      <div
        className="relative flex flex-wrap items-center justify-between gap-2"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2">
          <Cpu className="h-4 w-4 text-orange-500" />
          <span className="text-sm font-semibold">
            {t("proxy.mode.bannerTitle", {
              defaultValue: "Claude 模型路由（模型->供应商）",
            })}
          </span>
          <span className="rounded bg-blue-100 px-1.5 py-0.5 text-[10px] font-medium text-blue-700 dark:bg-blue-900/40 dark:text-blue-200">
            {t("proxy.mode.virtualProvider", {
              defaultValue: "虚拟供应商",
            })}
          </span>
          <ModeBadge
            routeEnabled={routeEnabled}
            modelFailoverEnabled={modelFailoverEnabled}
          />
          <div className="ml-2 flex items-center gap-2 rounded-md border border-border/60 px-2 py-1 text-xs">
            <span className="text-muted-foreground">
              {t("proxy.mode.routeToggle", { defaultValue: "路由模式" })}
            </span>
            <Switch
              checked={routeEnabled}
              onCheckedChange={(checked) => {
                updateRoutingSettings.mutate({
                  routeEnabled: checked,
                  modelFailoverEnabled: checked
                    ? (settings?.modelFailoverEnabled ?? true)
                    : false,
                });
              }}
              disabled={updateRoutingSettings.isPending}
            />
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs"
            onClick={() => onOpenProxySettings("fork")}
          >
            {t("proxy.mode.editForkFailover", {
              defaultValue: "编辑 Claude 路由设置",
            })}
          </Button>
        </div>
      </div>

      <div className="relative mt-3 rounded-lg border border-border/60 bg-background/50">
        {FAMILY_ROWS.map((row) => {
          const policy = policyByModelKey.get(row.modelKey);
          const preferredId =
            routeEnabled && policy?.enabled ? policy.defaultProviderId : null;
          const providerId =
            actualProviderByModelKey[row.modelKey] || preferredId || currentProviderId;
          const providerName = providerId ? providers[providerId]?.name || providerId : "-";
          const modelSource = sourceByModelKey[row.modelKey];
          const isGlobalFallbackTag = !preferredId;
          const isFailoverTag =
            !!preferredId &&
            !!providerId &&
            providerId !== preferredId &&
            modelSource === "failover";
          return (
            <div
              key={row.key}
              className="flex items-center justify-between gap-3 border-b border-border/50 px-3 py-2.5 last:border-b-0"
            >
              <div className="min-w-0 flex-1 text-sm">
                <span className="font-medium">{row.label}</span>
                <span className="mx-1.5 text-muted-foreground">·</span>
                <span className="truncate text-muted-foreground">{providerName}</span>
              </div>
              {isGlobalFallbackTag ? (
                <span className="shrink-0 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-700 dark:bg-slate-800/80 dark:text-slate-200">
                  {t("proxy.mode.globalFallback", {
                    defaultValue: "回退全局模式",
                  })}
                </span>
              ) : isFailoverTag ? (
                <span className="shrink-0 rounded bg-orange-100 px-1.5 py-0.5 text-[10px] font-medium text-orange-700 dark:bg-orange-900/40 dark:text-orange-200">
                  {t("proxy.mode.tagFailover", { defaultValue: "故障切换" })}
                </span>
              ) : (
                <span className="shrink-0 rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-200">
                  {t("proxy.mode.tagDefault", { defaultValue: "默认路由" })}
                </span>
              )}
            </div>
          );
        })}
      </div>

      <div className="relative mt-2 text-xs text-muted-foreground">
        {recentSwitch ||
          t("proxy.mode.recentSwitchEmpty", {
            defaultValue: "最近切换：暂无",
          })}
      </div>
    </div>
  );
}
