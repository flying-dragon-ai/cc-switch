import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Plus, Trash2, Loader2, Info, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import type { ClaudeModelKey, FailoverQueueItem } from "@/types/proxy";
import type { AppId } from "@/lib/api";
import type { Provider } from "@/types";
import { useProvidersQuery } from "@/lib/query/queries";
import {
  useFailoverQueueForModel,
  useAvailableProvidersForModelFailover,
  useSetFailoverQueueForModel,
} from "@/lib/query/failover";

interface ModelFailoverQueueManagerProps {
  appType: AppId;
  modelKey: ClaudeModelKey;
  disabled?: boolean;
}

function resolveClaudeModelName(provider: Provider | undefined, modelKey: ClaudeModelKey): string {
  if (!provider) return "-";
  const env =
    provider.settingsConfig &&
    typeof provider.settingsConfig === "object" &&
    !Array.isArray(provider.settingsConfig)
      ? (provider.settingsConfig as Record<string, unknown>).env
      : undefined;
  const readEnv = (key: string): string | null => {
    if (!env || typeof env !== "object" || Array.isArray(env)) return null;
    const value = (env as Record<string, unknown>)[key];
    return typeof value === "string" && value.trim() ? value.trim() : null;
  };
  const defaultModel = readEnv("ANTHROPIC_MODEL");
  switch (modelKey) {
    case "haiku":
      return readEnv("ANTHROPIC_DEFAULT_HAIKU_MODEL") ?? defaultModel ?? "-";
    case "sonnet":
      return readEnv("ANTHROPIC_DEFAULT_SONNET_MODEL") ?? defaultModel ?? "-";
    case "opus":
      return readEnv("ANTHROPIC_DEFAULT_OPUS_MODEL") ?? defaultModel ?? "-";
    case "unknown":
      return readEnv("ANTHROPIC_REASONING_MODEL") ?? defaultModel ?? "-";
    case "custom":
    default:
      return defaultModel ?? "-";
  }
}

export function ModelFailoverQueueManager({
  appType,
  modelKey,
  disabled = false,
}: ModelFailoverQueueManagerProps) {
  const { t } = useTranslation();
  const [selectedProviderId, setSelectedProviderId] = useState("");

  const {
    data: queue,
    isLoading: isQueueLoading,
    error: queueError,
  } = useFailoverQueueForModel(appType, modelKey);
  const { data: availableProviders, isLoading: isProvidersLoading } =
    useAvailableProvidersForModelFailover(appType, modelKey);
  const { data: providersData } = useProvidersQuery(appType);

  const setModelQueue = useSetFailoverQueueForModel();
  const providerById = useMemo(
    () => providersData?.providers ?? {},
    [providersData?.providers],
  );

  const handleAddProvider = async () => {
    if (!selectedProviderId) return;

    try {
      const nextIds = [...(queue ?? []).map((item) => item.providerId), selectedProviderId];
      await setModelQueue.mutateAsync({
        appType,
        modelKey,
        providerIds: nextIds,
      });
      setSelectedProviderId("");
      toast.success(
        t("proxy.failoverQueue.addSuccess", "已添加到故障转移队列"),
        { closeButton: true },
      );
    } catch (error) {
      toast.error(
        t("proxy.failoverQueue.addFailed", "添加失败") + ": " + String(error),
      );
    }
  };

  const handleRemoveProvider = async (providerId: string) => {
    try {
      const nextIds = (queue ?? [])
        .map((item) => item.providerId)
        .filter((id) => id !== providerId);
      await setModelQueue.mutateAsync({
        appType,
        modelKey,
        providerIds: nextIds,
      });
      toast.success(
        t("proxy.failoverQueue.removeSuccess", "已从故障转移队列移除"),
        { closeButton: true },
      );
    } catch (error) {
      toast.error(
        t("proxy.failoverQueue.removeFailed", "移除失败") +
          ": " +
          String(error),
      );
    }
  };

  if (isQueueLoading) {
    return (
      <div className="flex items-center justify-center p-8">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (queueError) {
    return (
      <Alert variant="destructive">
        <AlertTriangle className="h-4 w-4" />
        <AlertDescription>{String(queueError)}</AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="space-y-4">
      <Alert className="border-blue-500/40 bg-blue-500/10">
        <Info className="h-4 w-4" />
        <AlertDescription className="text-sm">
          {t(
            "proxy.failoverQueue.modelInfo",
            "这是当前模型族的独立备选队列，仅影响该模型族。若此队列为空，系统会回退到 Claude 通用队列。",
          )}
        </AlertDescription>
      </Alert>

      <div className="flex items-center gap-2">
        <Select
          value={selectedProviderId}
          onValueChange={setSelectedProviderId}
          disabled={disabled || isProvidersLoading}
        >
          <SelectTrigger className="flex-1">
            <SelectValue
              placeholder={t(
                "proxy.failoverQueue.selectProvider",
                "选择供应商添加到队列",
              )}
            />
          </SelectTrigger>
          <SelectContent>
            {availableProviders?.map((provider) => (
              <SelectItem key={provider.id} value={provider.id}>
                {provider.name}
              </SelectItem>
            ))}
            {(!availableProviders || availableProviders.length === 0) && (
              <div className="px-2 py-4 text-center text-sm text-muted-foreground">
                {t(
                  "proxy.failoverQueue.noAvailableProviders",
                  "没有可添加的供应商",
                )}
              </div>
            )}
          </SelectContent>
        </Select>
        <Button
          onClick={handleAddProvider}
          disabled={disabled || !selectedProviderId || setModelQueue.isPending}
          size="icon"
          variant="outline"
        >
          {setModelQueue.isPending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Plus className="h-4 w-4" />
          )}
        </Button>
      </div>

      {!queue || queue.length === 0 ? (
        <div className="rounded-lg border border-dashed border-muted-foreground/40 p-8 text-center">
          <p className="text-sm text-muted-foreground">
            {t(
              "proxy.failoverQueue.empty",
              "故障转移队列为空。添加供应商以启用自动故障转移。",
            )}
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {queue.map((item, index) => (
            <QueueItem
              key={item.providerId}
              item={item}
              index={index}
              modelName={resolveClaudeModelName(providerById[item.providerId], modelKey)}
              disabled={disabled}
              onRemove={handleRemoveProvider}
              isRemoving={setModelQueue.isPending}
            />
          ))}
        </div>
      )}
    </div>
  );
}

interface QueueItemProps {
  item: FailoverQueueItem;
  index: number;
  modelName: string;
  disabled: boolean;
  onRemove: (providerId: string) => void;
  isRemoving: boolean;
}

function QueueItem({
  item,
  index,
  modelName,
  disabled,
  onRemove,
  isRemoving,
}: QueueItemProps) {
  const { t } = useTranslation();

  return (
    <div
      className={cn(
        "flex items-center gap-3 rounded-lg border bg-card p-3 transition-colors",
      )}
    >
      <div className="flex h-6 w-6 items-center justify-center rounded-full bg-muted text-xs font-medium">
        {index + 1}
      </div>

      <div className="flex-1 min-w-0">
        <span className="text-sm font-medium truncate block">
          {item.providerName}
        </span>
        <span className="text-xs text-muted-foreground truncate block">
          {t("proxy.mode.modelNameForProvider", {
            defaultValue: "模型：{{model}}",
            model: modelName,
          })}
        </span>
      </div>

      <Button
        variant="ghost"
        size="icon"
        className="h-8 w-8 text-muted-foreground hover:text-destructive"
        onClick={() => onRemove(item.providerId)}
        disabled={disabled || isRemoving}
        aria-label={t("common.delete", "删除")}
      >
        {isRemoving ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <Trash2 className="h-4 w-4" />
        )}
      </Button>
    </div>
  );
}
