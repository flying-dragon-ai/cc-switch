import { CSS } from "@dnd-kit/utilities";
import { DndContext, closestCenter, type DragEndEvent } from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type CSSProperties,
} from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Check, ChevronsUpDown, Search, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";
import { toast } from "sonner";
import type { Provider } from "@/types";
import type { AppId } from "@/lib/api";
import { providersApi } from "@/lib/api/providers";
import { useDragSort } from "@/hooks/useDragSort";
import { useStreamCheck } from "@/hooks/useStreamCheck";
import {
  useOpenClawLiveProviderIds,
  useOpenClawDefaultModel,
} from "@/hooks/useOpenClaw";
// import { useStreamCheck } from "@/hooks/useStreamCheck"; // 测试功能已隐藏
import { ProviderCard } from "@/components/providers/ProviderCard";
import { ProviderEmptyState } from "@/components/providers/ProviderEmptyState";
import {
  useAutoFailoverEnabled,
  useFailoverQueue,
  useAddToFailoverQueue,
  useRemoveFromFailoverQueue,
} from "@/lib/query/failover";
import {
  useClaudeModelRoutePolicies,
  useClaudeModelRoutingSettings,
  useUpdateClaudeModelRoutingSettings,
  useUpsertClaudeModelRoutePolicy,
} from "@/lib/query/proxy";
import {
  useCurrentOmoProviderId,
  useCurrentOmoSlimProviderId,
} from "@/lib/query/omo";
import { useCallback } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { ClaudeModelKey, ClaudeModelRoutePolicy } from "@/types/proxy";

interface ProviderListProps {
  providers: Record<string, Provider>;
  currentProviderId: string;
  appId: AppId;
  onSwitch: (provider: Provider) => void;
  onEdit: (provider: Provider) => void;
  onDelete: (provider: Provider) => void;
  onRemoveFromConfig?: (provider: Provider) => void;
  onDisableOmo?: () => void;
  onDisableOmoSlim?: () => void;
  onDuplicate: (provider: Provider) => void;
  onConfigureUsage?: (provider: Provider) => void;
  onOpenWebsite: (url: string) => void;
  onOpenTerminal?: (provider: Provider) => void;
  onCreate?: () => void;
  isLoading?: boolean;
  isProxyRunning?: boolean; // 代理服务运行状态
  isProxyTakeover?: boolean; // 代理接管模式（Live配置已被接管）
  activeProviderId?: string; // 代理当前实际使用的供应商 ID（用于故障转移模式下标注绿色边框）
  onSetAsDefault?: (provider: Provider) => void; // OpenClaw: set as default model
  onOpenClaudeRouteSettings?: (target?: "fork") => void;
}

function SearchableProviderCombobox({
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
  const displayLabel =
    value === "__none__" ? noneLabel : (selected?.name ?? placeholder);

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
          <span className={cn("truncate text-left", !value && "text-muted-foreground")}>
            {displayLabel}
          </span>
          <ChevronsUpDown className="ml-2 h-3.5 w-3.5 opacity-50" />
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
                  className={cn("mr-2 h-4 w-4", value === "__none__" ? "opacity-100" : "opacity-0")}
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

export function ProviderList({
  providers,
  currentProviderId,
  appId,
  onSwitch,
  onEdit,
  onDelete,
  onRemoveFromConfig,
  onDisableOmo,
  onDisableOmoSlim,
  onDuplicate,
  onConfigureUsage,
  onOpenWebsite,
  onOpenTerminal,
  onCreate,
  isLoading = false,
  isProxyRunning = false,
  isProxyTakeover = false,
  activeProviderId,
  onSetAsDefault,
  onOpenClaudeRouteSettings,
}: ProviderListProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { sortedProviders, sensors, handleDragEnd } = useDragSort(
    providers,
    appId,
  );
  const [isSortMutating, setIsSortMutating] = useState(false);
  const [contextMenu, setContextMenu] = useState<{
    providerId: string;
    x: number;
    y: number;
  } | null>(null);

  const { data: opencodeLiveIds } = useQuery({
    queryKey: ["opencodeLiveProviderIds"],
    queryFn: () => providersApi.getOpenCodeLiveProviderIds(),
    enabled: appId === "opencode",
  });

  // OpenClaw: 查询 live 配置中的供应商 ID 列表，用于判断 isInConfig
  const { data: openclawLiveIds } = useOpenClawLiveProviderIds(
    appId === "openclaw",
  );

  // 流式健康检查
  const { checkProvider, isChecking } = useStreamCheck(appId);

  // 判断供应商是否已添加到配置（累加模式应用：OpenCode/OpenClaw）
  const isProviderInConfig = useCallback(
    (providerId: string): boolean => {
      if (appId === "opencode") {
        return opencodeLiveIds?.includes(providerId) ?? false;
      }
      if (appId === "openclaw") {
        return openclawLiveIds?.includes(providerId) ?? false;
      }
      return true; // 其他应用始终返回 true
    },
    [appId, opencodeLiveIds, openclawLiveIds],
  );

  // OpenClaw: query default model to determine which provider is default
  const { data: openclawDefaultModel } = useOpenClawDefaultModel(
    appId === "openclaw",
  );

  const isProviderDefaultModel = useCallback(
    (providerId: string): boolean => {
      if (appId !== "openclaw" || !openclawDefaultModel?.primary) return false;
      return openclawDefaultModel.primary.startsWith(providerId + "/");
    },
    [appId, openclawDefaultModel],
  );

  // 故障转移相关
  const { data: isAutoFailoverEnabled } = useAutoFailoverEnabled(appId);
  const { data: failoverQueue } = useFailoverQueue(appId);
  const { data: claudeRoutingSettings } = useClaudeModelRoutingSettings(
    appId === "claude",
  );
  const updateClaudeRoutingSettings = useUpdateClaudeModelRoutingSettings();
  const addToQueue = useAddToFailoverQueue();
  const removeFromQueue = useRemoveFromFailoverQueue();

  const isFailoverModeActive =
    isProxyTakeover === true && isAutoFailoverEnabled === true;
  const isClaudeVirtualMode = appId === "claude";
  const isClaudeRouteModeEnabled =
    claudeRoutingSettings?.routeEnabled === true &&
    claudeRoutingSettings?.modelFailoverEnabled === true;
  const CLAUDE_ROUTE_MODE_NODE_ID = "__claude_route_mode_virtual__";

  const isOpenCode = appId === "opencode";
  const { data: currentOmoId } = useCurrentOmoProviderId(isOpenCode);
  const { data: currentOmoSlimId } = useCurrentOmoSlimProviderId(isOpenCode);

  const getFailoverPriority = useCallback(
    (providerId: string): number | undefined => {
      if (!isFailoverModeActive) return undefined;
      if (!failoverQueue) return undefined;
      const index = failoverQueue.findIndex(
        (item) => item.providerId === providerId,
      );
      return index >= 0 ? index + 1 : undefined;
    },
    [failoverQueue, isFailoverModeActive],
  );

  const isInFailoverQueue = useCallback(
    (providerId: string): boolean => {
      if (!isFailoverModeActive) return false;
      if (!failoverQueue) return false;
      return failoverQueue.some((item) => item.providerId === providerId);
    },
    [failoverQueue, isFailoverModeActive],
  );

  const handleToggleFailover = useCallback(
    (providerId: string, enabled: boolean) => {
      if (enabled) {
        addToQueue.mutate({ appType: appId, providerId });
      } else {
        removeFromQueue.mutate({ appType: appId, providerId });
      }
    },
    [addToQueue, appId, removeFromQueue],
  );

  const handleSwitchProvider = useCallback(
    (provider: Provider) => {
      const run = async () => {
        if (appId === "claude" && isClaudeRouteModeEnabled) {
          try {
            await updateClaudeRoutingSettings.mutateAsync({
              routeEnabled: false,
              modelFailoverEnabled: false,
            });
          } catch {
            return;
          }
        }
        await Promise.resolve(onSwitch(provider));
      };
      void run();
    },
    [
      appId,
      isClaudeRouteModeEnabled,
      onSwitch,
      updateClaudeRoutingSettings,
    ],
  );

  const handleTest = (provider: Provider) => {
    checkProvider(provider.id, provider.name);
  };

  const [searchTerm, setSearchTerm] = useState("");
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Import current live config as default provider
  const importMutation = useMutation({
    mutationFn: async (): Promise<boolean> => {
      if (appId === "opencode") {
        const count = await providersApi.importOpenCodeFromLive();
        return count > 0;
      }
      if (appId === "openclaw") {
        const count = await providersApi.importOpenClawFromLive();
        return count > 0;
      }
      return providersApi.importDefault(appId);
    },
    onSuccess: (imported) => {
      if (imported) {
        queryClient.invalidateQueries({ queryKey: ["providers", appId] });
        toast.success(t("provider.importCurrentDescription"));
      } else {
        toast.info(t("provider.noProviders"));
      }
    },
    onError: (error: Error) => {
      toast.error(error.message);
    },
  });

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      if ((event.metaKey || event.ctrlKey) && key === "f") {
        event.preventDefault();
        setIsSearchOpen(true);
        return;
      }

      if (key === "escape") {
        setIsSearchOpen(false);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  useEffect(() => {
    if (isSearchOpen) {
      const frame = requestAnimationFrame(() => {
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      });
      return () => cancelAnimationFrame(frame);
    }
  }, [isSearchOpen]);

  const filteredProviders = useMemo(() => {
    const keyword = searchTerm.trim().toLowerCase();
    if (!keyword) return sortedProviders;
    return sortedProviders.filter((provider) => {
      const fields = [provider.name, provider.notes, provider.websiteUrl];
      return fields.some((field) =>
        field?.toString().toLowerCase().includes(keyword),
      );
    });
  }, [searchTerm, sortedProviders]);

  const providerById = useMemo(() => {
    const map = new Map<string, Provider>();
    for (const provider of sortedProviders) {
      map.set(provider.id, provider);
    }
    return map;
  }, [sortedProviders]);

  const claudeMixedIds = useMemo(() => {
    if (!isClaudeVirtualMode) return sortedProviders.map((provider) => provider.id);
    return [
      CLAUDE_ROUTE_MODE_NODE_ID,
      ...sortedProviders.map((provider) => provider.id),
    ];
  }, [isClaudeVirtualMode, sortedProviders, CLAUDE_ROUTE_MODE_NODE_ID]);

  const displayIds = useMemo(() => {
    if (!isClaudeVirtualMode) {
      return filteredProviders.map((provider) => provider.id);
    }
    const filteredSet = new Set(filteredProviders.map((provider) => provider.id));
    return claudeMixedIds.filter(
      (id) => id === CLAUDE_ROUTE_MODE_NODE_ID || filteredSet.has(id),
    );
  }, [
    CLAUDE_ROUTE_MODE_NODE_ID,
    claudeMixedIds,
    filteredProviders,
    isClaudeVirtualMode,
  ]);

  const claudeRoutePriority = useMemo(() => {
    return undefined;
  }, []);

  const handleProviderListDragEnd = useCallback(
    async (event: DragEndEvent) => {
      await handleDragEnd(event);
    },
    [handleDragEnd],
  );

  const closeContextMenu = useCallback(() => {
    setContextMenu(null);
  }, []);

  useEffect(() => {
    if (!contextMenu) return;
    const handleWindowPointerDown = () => closeContextMenu();
    const handleWindowResize = () => closeContextMenu();
    const handleWindowScroll = () => closeContextMenu();
    const handleWindowKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closeContextMenu();
      }
    };

    window.addEventListener("pointerdown", handleWindowPointerDown);
    window.addEventListener("resize", handleWindowResize);
    window.addEventListener("scroll", handleWindowScroll, true);
    window.addEventListener("keydown", handleWindowKeyDown);
    return () => {
      window.removeEventListener("pointerdown", handleWindowPointerDown);
      window.removeEventListener("resize", handleWindowResize);
      window.removeEventListener("scroll", handleWindowScroll, true);
      window.removeEventListener("keydown", handleWindowKeyDown);
    };
  }, [closeContextMenu, contextMenu]);

  const applyQuickSort = useCallback(
    async (reordered: Provider[]) => {
      const updates = reordered.map((item, index) => ({
        id: item.id,
        sortIndex: index,
      }));

      try {
        setIsSortMutating(true);
        await providersApi.updateSortOrder(updates, appId);
        await queryClient.invalidateQueries({
          queryKey: ["providers", appId],
        });
        await queryClient.invalidateQueries({
          queryKey: ["failoverQueue", appId],
        });
        try {
          await providersApi.updateTrayMenu();
        } catch (trayError) {
          console.error("Failed to update tray menu after quick sort", trayError);
        }
        toast.success(
          t("provider.sortUpdated", {
            defaultValue: "排序已更新",
          }),
          { closeButton: true },
        );
      } catch (error) {
        console.error("Failed to quick sort providers", error);
        toast.error(
          t("provider.sortUpdateFailed", {
            defaultValue: "排序更新失败",
          }),
        );
      } finally {
        setIsSortMutating(false);
      }
    },
    [appId, queryClient, t],
  );

  const moveProviderToTopQuick = useCallback(
    async (providerId: string) => {
      if (isSortMutating) return;
      const list = [...sortedProviders];
      const currentIndex = list.findIndex((item) => item.id === providerId);
      if (currentIndex < 0) return;

      const targetIndex = 0;
      if (currentIndex === targetIndex) {
        toast.info(
          t("provider.quickMoveAlreadyTop", {
            defaultValue: "该供应商已在目标位置",
          }),
        );
        return;
      }

      const [item] = list.splice(currentIndex, 1);
      list.splice(targetIndex, 0, item);
      await applyQuickSort(list);
    },
    [applyQuickSort, isSortMutating, sortedProviders, t],
  );

  const moveProviderToBottomQuick = useCallback(
    async (providerId: string) => {
      if (isSortMutating) return;
      const list = [...sortedProviders];
      const currentIndex = list.findIndex((item) => item.id === providerId);
      if (currentIndex < 0) return;

      const targetIndex = list.length - 1;
      if (currentIndex === targetIndex) {
        toast.info(
          t("provider.quickMoveAlreadyBottom", {
            defaultValue: "该供应商已在末尾",
          }),
        );
        return;
      }

      const [item] = list.splice(currentIndex, 1);
      list.push(item);
      await applyQuickSort(list);
    },
    [applyQuickSort, isSortMutating, sortedProviders, t],
  );

  const handleProviderContextMenu = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>, providerId: string) => {
      event.preventDefault();
      setContextMenu({
        providerId,
        x: event.clientX,
        y: event.clientY,
      });
    },
    [],
  );

  if (isLoading) {
    return (
      <div className="space-y-3">
        {[0, 1, 2].map((index) => (
          <div
            key={index}
            className="w-full border border-dashed rounded-lg h-28 border-muted-foreground/40 bg-muted/40"
          />
        ))}
      </div>
    );
  }

  if (sortedProviders.length === 0) {
    return (
      <ProviderEmptyState
        onCreate={onCreate}
        onImport={() => importMutation.mutate()}
      />
    );
  }

  const renderProviderList = () => (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={handleProviderListDragEnd}
    >
      <SortableContext
        items={displayIds}
        strategy={verticalListSortingStrategy}
      >
        <div className="space-y-3">
          {displayIds.map((itemId) => {
            if (itemId === CLAUDE_ROUTE_MODE_NODE_ID) {
              return (
                <SortableClaudeVirtualCard
                  key={CLAUDE_ROUTE_MODE_NODE_ID}
                  id={CLAUDE_ROUTE_MODE_NODE_ID}
                  providers={providers}
                  currentProviderId={currentProviderId}
                  activeProviderId={activeProviderId}
                  isProxyRunning={isProxyRunning}
                  isProxyTakeover={isProxyTakeover}
                  isFailoverEnabled={appId === "claude" && isAutoFailoverEnabled === true}
                  onOpenProxySettings={onOpenClaudeRouteSettings}
                  failoverPriority={claudeRoutePriority}
                  showPriority={isFailoverModeActive}
                />
              );
            }
            const provider = providerById.get(itemId);
            if (!provider) return null;
            const isOmo = provider.category === "omo";
            const isOmoSlim = provider.category === "omo-slim";
            const isOmoCurrent = isOmo && provider.id === (currentOmoId || "");
            const isOmoSlimCurrent =
              isOmoSlim && provider.id === (currentOmoSlimId || "");
            const isRegularCurrent =
              appId === "claude" && isClaudeRouteModeEnabled
                ? false
                : provider.id === currentProviderId;
            return (
              <SortableProviderCard
                key={provider.id}
                provider={provider}
                isCurrent={
                  isOmo
                    ? isOmoCurrent
                    : isOmoSlim
                      ? isOmoSlimCurrent
                      : isRegularCurrent
                }
                appId={appId}
                isInConfig={isProviderInConfig(provider.id)}
                isOmo={isOmo}
                isOmoSlim={isOmoSlim}
                onSwitch={handleSwitchProvider}
                onEdit={onEdit}
                onDelete={onDelete}
                onRemoveFromConfig={onRemoveFromConfig}
                onDisableOmo={onDisableOmo}
                onDisableOmoSlim={onDisableOmoSlim}
                onDuplicate={onDuplicate}
                onConfigureUsage={onConfigureUsage}
                onOpenWebsite={onOpenWebsite}
                onOpenTerminal={onOpenTerminal}
                onTest={appId !== "opencode" ? handleTest : undefined}
                isTesting={isChecking(provider.id)}
                isProxyRunning={isProxyRunning}
                isProxyTakeover={isProxyTakeover}
                isAutoFailoverEnabled={isFailoverModeActive}
                failoverPriority={getFailoverPriority(provider.id)}
                isInFailoverQueue={isInFailoverQueue(provider.id)}
                onToggleFailover={(enabled) =>
                  handleToggleFailover(provider.id, enabled)
                }
                activeProviderId={activeProviderId}
                // OpenClaw: default model
                isDefaultModel={isProviderDefaultModel(provider.id)}
                onSetAsDefault={
                  onSetAsDefault ? () => onSetAsDefault(provider) : undefined
                }
                onContextMenu={(event) =>
                  handleProviderContextMenu(event, provider.id)
                }
              />
            );
          })}
        </div>
      </SortableContext>
    </DndContext>
  );

  return (
    <div className="mt-4 space-y-4">
      <AnimatePresence>
        {isSearchOpen && (
          <motion.div
            key="provider-search"
            initial={{ opacity: 0, y: -8, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.98 }}
            transition={{ duration: 0.18, ease: "easeOut" }}
            className="fixed left-1/2 top-[6.5rem] z-40 w-[min(90vw,26rem)] -translate-x-1/2 sm:right-6 sm:left-auto sm:translate-x-0"
          >
            <div className="p-4 space-y-3 border shadow-md rounded-2xl border-white/10 bg-background/95 shadow-black/20 backdrop-blur-md">
              <div className="relative flex items-center gap-2">
                <Search className="absolute w-4 h-4 -translate-y-1/2 pointer-events-none left-3 top-1/2 text-muted-foreground" />
                <Input
                  ref={searchInputRef}
                  value={searchTerm}
                  onChange={(event) => setSearchTerm(event.target.value)}
                  placeholder={t("provider.searchPlaceholder", {
                    defaultValue: "Search name, notes, or URL...",
                  })}
                  aria-label={t("provider.searchAriaLabel", {
                    defaultValue: "Search providers",
                  })}
                  className="pr-16 pl-9"
                />
                {searchTerm && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="absolute text-xs -translate-y-1/2 right-11 top-1/2"
                    onClick={() => setSearchTerm("")}
                  >
                    {t("common.clear", { defaultValue: "Clear" })}
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="icon"
                  className="ml-auto"
                  onClick={() => setIsSearchOpen(false)}
                  aria-label={t("provider.searchCloseAriaLabel", {
                    defaultValue: "Close provider search",
                  })}
                >
                  <X className="w-4 h-4" />
                </Button>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted-foreground">
                <span>
                  {t("provider.searchScopeHint", {
                    defaultValue: "Matches provider name, notes, and URL.",
                  })}
                </span>
                <span>
                  {t("provider.searchCloseHint", {
                    defaultValue: "Press Esc to close",
                  })}
                </span>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {filteredProviders.length === 0 ? (
        <div className="px-6 py-8 text-sm text-center border border-dashed rounded-lg border-border text-muted-foreground">
          {t("provider.noSearchResults", {
            defaultValue: "No providers match your search.",
          })}
        </div>
      ) : (
        renderProviderList()
      )}

      {contextMenu && (
        <div
          className="fixed z-[1200] min-w-[180px] rounded-md border border-border bg-popover p-1 shadow-lg"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            className="flex w-full items-center rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
            disabled={isSortMutating}
            onClick={async () => {
              closeContextMenu();
              await moveProviderToTopQuick(contextMenu.providerId);
            }}
          >
            {t("provider.quickMoveTop", {
              defaultValue: "一键置顶",
            })}
          </button>
          <button
            type="button"
            className="flex w-full items-center rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
            disabled={isSortMutating}
            onClick={async () => {
              closeContextMenu();
              await moveProviderToBottomQuick(contextMenu.providerId);
            }}
          >
            {t("provider.quickMoveBottom", {
              defaultValue: "一键置底",
            })}
          </button>
        </div>
      )}
    </div>
  );
}

interface SortableProviderCardProps {
  provider: Provider;
  isCurrent: boolean;
  appId: AppId;
  isInConfig: boolean;
  isOmo: boolean;
  isOmoSlim: boolean;
  onSwitch: (provider: Provider) => void;
  onEdit: (provider: Provider) => void;
  onDelete: (provider: Provider) => void;
  onRemoveFromConfig?: (provider: Provider) => void;
  onDisableOmo?: () => void;
  onDisableOmoSlim?: () => void;
  onDuplicate: (provider: Provider) => void;
  onConfigureUsage?: (provider: Provider) => void;
  onOpenWebsite: (url: string) => void;
  onOpenTerminal?: (provider: Provider) => void;
  onTest?: (provider: Provider) => void;
  isTesting: boolean;
  isProxyRunning: boolean;
  isProxyTakeover: boolean;
  isAutoFailoverEnabled: boolean;
  failoverPriority?: number;
  isInFailoverQueue: boolean;
  onToggleFailover: (enabled: boolean) => void;
  activeProviderId?: string;
  // OpenClaw: default model
  isDefaultModel?: boolean;
  onSetAsDefault?: () => void;
  onContextMenu?: (event: ReactMouseEvent<HTMLDivElement>) => void;
}

function SortableClaudeVirtualCard({
  id,
  providers,
  currentProviderId,
  activeProviderId,
  isProxyRunning,
  isProxyTakeover,
  isFailoverEnabled,
  onOpenProxySettings,
  failoverPriority,
  showPriority,
}: {
  id: string;
  providers: Record<string, Provider>;
  currentProviderId: string;
  activeProviderId?: string;
  isProxyRunning: boolean;
  isProxyTakeover: boolean;
  isFailoverEnabled: boolean;
  onOpenProxySettings?: (target?: "fork") => void;
  failoverPriority?: number;
  showPriority: boolean;
}) {
  type ProviderSwitchedPayload = {
    appType?: string;
    providerId?: string;
    source?: string;
    modelKey?: ClaudeModelKey;
  };
  type ModelRetryStatusPayload = {
    appType?: string;
    modelKey?: ClaudeModelKey;
    retryCount?: number;
  };

  const MODEL_KEYS: ClaudeModelKey[] = [
    "custom",
    "opus",
    "sonnet",
    "haiku",
    "unknown",
  ];

  const { t } = useTranslation();
  const { data: settings } = useClaudeModelRoutingSettings();
  const updateRoutingSettings = useUpdateClaudeModelRoutingSettings();
  const upsertPolicy = useUpsertClaudeModelRoutePolicy();
  const { data: policies = [] } = useClaudeModelRoutePolicies();
  const [expanded, setExpanded] = useState(false);
  const prevCurrentProviderIdRef = useRef(currentProviderId);
  const [actualProviderByModelKey, setActualProviderByModelKey] = useState<
    Partial<Record<ClaudeModelKey, string>>
  >({});
  const [sourceByModelKey, setSourceByModelKey] = useState<
    Partial<Record<ClaudeModelKey, string>>
  >({});
  const [retryCountByModelKey, setRetryCountByModelKey] = useState<
    Partial<Record<ClaudeModelKey, number>>
  >({});
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id });
  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
  };
  const proxyRequiredHint = t("proxy.failover.proxyRequired", {
    defaultValue: "需要先启动代理服务才能配置故障转移",
  });
  const takeoverRequiredHint = t("proxy.takeover.requiredForClaudeRouting", {
    defaultValue: "需要先开启 Claude 代理接管，才能使用此卡片。",
  });
  const failoverHint = t("proxy.mode.virtualNotInFailoverQueue", {
    defaultValue: "已启用 Claude 自动故障转移：该卡片不参与 P1/P2 队列排序，仅用于路由配置。",
  });
  const isCardEnabled = isProxyRunning && isProxyTakeover;
  const isDimmedByFailover = isFailoverEnabled;
  const routeEnabled = settings?.routeEnabled ?? false;
  const modelFailoverEnabled = settings?.modelFailoverEnabled ?? false;
  const isVirtualModeEnabled = routeEnabled && modelFailoverEnabled;
  const useEnabledStyle = isVirtualModeEnabled;
  const enabledBorderClass = isProxyTakeover
    ? "border-emerald-500/60 shadow-sm shadow-emerald-500/10"
    : "border-blue-500/60 shadow-sm shadow-blue-500/10";
  const enabledBackgroundClass = isProxyTakeover
    ? "bg-emerald-500/[0.04]"
    : "bg-blue-500/[0.04]";

  const policyMap = useMemo(() => {
    const map = new Map<string, (typeof policies)[number]>();
    for (const policy of policies) {
      map.set(policy.modelKey, policy);
    }
    return map;
  }, [policies]);

  const virtualProvider = useMemo<Provider>(
    () => ({
      id,
      name: t("proxy.mode.bannerTitle", {
        defaultValue: "Claude 模型路由（模型->供应商）",
      }),
      settingsConfig: {
        env: {
          ANTHROPIC_MODEL: t("proxy.mode.virtualProvider", {
            defaultValue: "虚拟供应商",
          }),
        },
      },
      websiteUrl: expanded
        ? t("proxy.mode.collapseModelRoutes", {
            defaultValue: "收起模型路由详情",
          })
        : t("proxy.mode.expandModelRoutes", {
            defaultValue: "展开模型路由详情",
          }),
      category: "custom",
      icon: "claude",
    }),
    [expanded, id, t],
  );

  const modelRows = useMemo(
    () => [
      { key: "custom" as ClaudeModelKey, label: "主模型" },
      { key: "opus" as ClaudeModelKey, label: "Opus" },
      { key: "sonnet" as ClaudeModelKey, label: "Sonnet" },
      { key: "haiku" as ClaudeModelKey, label: "Haiku" },
      { key: "unknown" as ClaudeModelKey, label: "Thinking" },
    ],
    [],
  );
  const providerOptions = useMemo(() => Object.values(providers), [providers]);

  useEffect(() => {
    if (!isProxyRunning && expanded) {
      setExpanded(false);
    }
  }, [isProxyRunning, expanded]);

  useEffect(() => {
    if (
      isProxyRunning &&
      expanded &&
      prevCurrentProviderIdRef.current !== currentProviderId
    ) {
      setExpanded(false);
    }
    prevCurrentProviderIdRef.current = currentProviderId;
  }, [currentProviderId, isProxyRunning, expanded]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    const setup = async () => {
      unlisten = await listen<ProviderSwitchedPayload>(
        "provider-switched",
        (event) => {
          const payload = event.payload;
          if (payload?.appType !== "claude" || !payload?.providerId) return;

          if (payload.modelKey) {
            setActualProviderByModelKey((prev) => ({
              ...prev,
              [payload.modelKey as ClaudeModelKey]: payload.providerId as string,
            }));
            if (payload.source) {
              setSourceByModelKey((prev) => ({
                ...prev,
                [payload.modelKey as ClaudeModelKey]: payload.source as string,
              }));
            }
            return;
          }

          setActualProviderByModelKey(() =>
            MODEL_KEYS.reduce(
              (acc, modelKey) => {
                acc[modelKey] = payload.providerId as string;
                return acc;
              },
              {} as Partial<Record<ClaudeModelKey, string>>,
            ),
          );
          if (payload.source) {
            setSourceByModelKey(() =>
              MODEL_KEYS.reduce(
                (acc, modelKey) => {
                  acc[modelKey] = payload.source as string;
                  return acc;
                },
                {} as Partial<Record<ClaudeModelKey, string>>,
              ),
            );
          }
        },
      );
    };

    void setup();
    return () => {
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    const setup = async () => {
      unlisten = await listen<ModelRetryStatusPayload>(
        "model-retry-status",
        (event) => {
          const payload = event.payload;
          if (payload?.appType !== "claude" || !payload?.modelKey) return;
          const retryCount = Number(payload.retryCount ?? 0);
          setRetryCountByModelKey((prev) => ({
            ...prev,
            [payload.modelKey as ClaudeModelKey]: Number.isFinite(retryCount)
              ? Math.max(0, Math.trunc(retryCount))
              : 0,
          }));
        },
      );
    };

    void setup();
    return () => {
      unlisten?.();
    };
  }, []);

  const resolveClaudeModelName = useCallback(
    (providerId: string | null | undefined, modelKey: ClaudeModelKey): string => {
      if (!providerId) return "-";
      const provider = providers[providerId];
      if (!provider) return "-";
      const env =
        provider.settingsConfig &&
        typeof provider.settingsConfig === "object" &&
        !Array.isArray(provider.settingsConfig)
          ? (provider.settingsConfig as Record<string, any>).env
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
    },
    [providers],
  );

  const savePolicy = useCallback(
    async (modelKey: ClaudeModelKey, patch: Partial<ClaudeModelRoutePolicy>) => {
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
    },
    [policyMap, upsertPolicy],
  );

  const showCardDisabledHint = useCallback(() => {
    if (!isProxyRunning) {
      toast.info(proxyRequiredHint);
      return;
    }
    if (!isProxyTakeover) {
      toast.info(takeoverRequiredHint);
    }
  }, [isProxyRunning, isProxyTakeover, proxyRequiredHint, takeoverRequiredHint]);

  const handleUnsupportedAction = useCallback(() => {
    if (!isCardEnabled) {
      showCardDisabledHint();
      return;
    }
    toast.info(
      t("proxy.mode.virtualActionUnsupported", {
        defaultValue: "虚拟供应商仅支持编辑路由设置",
      }),
    );
  }, [isCardEnabled, showCardDisabledHint, t]);

  const handleOpenProxySettings = useCallback(() => {
    if (!isCardEnabled) {
      showCardDisabledHint();
      return;
    }
    onOpenProxySettings?.("fork");
  }, [isCardEnabled, onOpenProxySettings, showCardDisabledHint]);

  const handleEnableRoutingMode = useCallback(() => {
    if (!isCardEnabled) {
      showCardDisabledHint();
      return;
    }
    if (updateRoutingSettings.isPending) {
      return;
    }
    if (isVirtualModeEnabled) {
      toast.info(
        t("proxy.mode.routeModeAlreadyEnabled", {
          defaultValue: "已启用“固定首选 + 自动换备用”，可点击编辑继续调整。",
        }),
      );
      return;
    }
    updateRoutingSettings.mutate({
      routeEnabled: true,
      modelFailoverEnabled: true,
    });
  }, [
    isCardEnabled,
    isVirtualModeEnabled,
    showCardDisabledHint,
    updateRoutingSettings,
    t,
  ]);

  const handleToggleExpanded = useCallback(() => {
    setExpanded((prev) => !prev);
  }, []);

  return (
    <div ref={setNodeRef} style={style} className="relative">
      <div
        className={cn(
          (!isCardEnabled || isDimmedByFailover) && "opacity-60 grayscale",
          useEnabledStyle && "rounded-xl border",
          useEnabledStyle && enabledBorderClass,
          useEnabledStyle && enabledBackgroundClass,
          isDragging && "cursor-grabbing rounded-xl border-primary shadow-lg scale-[1.01] z-10",
        )}
      >
        <ProviderCard
          provider={virtualProvider}
          isCurrent={isVirtualModeEnabled}
          appId="claude"
          onSwitch={handleEnableRoutingMode}
          onEdit={handleOpenProxySettings}
          onDelete={handleUnsupportedAction}
          onDuplicate={handleUnsupportedAction}
          onConfigureUsage={handleUnsupportedAction}
          onOpenWebsite={handleToggleExpanded}
          onTest={handleUnsupportedAction}
          onOpenTerminal={handleUnsupportedAction}
          isTesting={false}
          isProxyRunning={isCardEnabled}
          isProxyTakeover={isProxyTakeover}
          dragHandleProps={{
            attributes,
            listeners,
            isDragging,
          }}
          isAutoFailoverEnabled={showPriority && !isDimmedByFailover}
          isInFailoverQueue={Boolean(showPriority && !isDimmedByFailover && failoverPriority)}
          failoverPriority={isDimmedByFailover ? undefined : failoverPriority}
        />
      </div>
      {isDimmedByFailover && (
        <div className="mt-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-200">
          {failoverHint}
        </div>
      )}
      {expanded && (
        <div className="mt-2 rounded-lg border border-border/60 bg-background/60 px-3 py-2">
          <div className="mb-2 flex items-center justify-between gap-2 rounded-md border border-blue-500/30 bg-blue-500/10 px-2.5 py-1.5 text-xs text-blue-700 dark:text-blue-200">
            <span>
              {t("proxy.mode.modelBackupEditHint", {
                defaultValue: "模型备用站点请点击“编辑”跳转到设置页进行配置。",
              })}
            </span>
            <Button
              type="button"
              variant="link"
              size="sm"
              className="h-auto p-0 text-xs text-blue-700 hover:text-blue-800 dark:text-blue-200 dark:hover:text-blue-100"
              onClick={handleOpenProxySettings}
            >
              {t("common.edit", { defaultValue: "编辑" })}
            </Button>
          </div>
          <div>
            {modelRows.map((row) => {
              const policy = policyMap.get(row.key);
              const preferredId =
                routeEnabled && policy?.enabled ? policy.defaultProviderId : null;
              const actualProviderId =
                actualProviderByModelKey[row.key] ??
                preferredId ??
                activeProviderId ??
                currentProviderId;
              const fallbackProviderName = currentProviderId
                ? providers[currentProviderId]?.name || currentProviderId
                : "-";
              const selectedValue = preferredId ?? "__none__";
              const modelName = resolveClaudeModelName(actualProviderId, row.key);
              const modelSource = sourceByModelKey[row.key];
              const retryCount = retryCountByModelKey[row.key] ?? 0;
              const isFailoverTag =
                !!preferredId &&
                !!actualProviderId &&
                actualProviderId !== preferredId &&
                modelSource === "failover";

              return (
                <div
                  key={row.key}
                  className="flex items-center justify-between gap-3 border-b border-border/50 py-2 last:border-0"
                >
                  <div className="min-w-0 flex-1 text-sm flex items-center gap-2">
                    <span className="inline-block w-[64px] font-medium">{row.label}</span>
                    <span className="mx-1 text-muted-foreground">·</span>
                    <div className="w-[320px] max-w-[70vw]">
                      <SearchableProviderCombobox
                        value={selectedValue}
                        providers={providerOptions.map((provider) => ({
                          id: provider.id,
                          name: provider.name,
                        }))}
                        placeholder={t("proxy.claudeModelRouting.defaultProvider", {
                          defaultValue: "选择首选站点",
                        })}
                        noneLabel={
                          t("proxy.claudeModelRouting.none", {
                            defaultValue: "不固定（使用全局默认）",
                          }) +
                          (fallbackProviderName !== "-" ? `：${fallbackProviderName}` : "")
                        }
                        searchPlaceholder={t("proxy.claudeModelRouting.searchProvider", {
                          defaultValue: "输入名称搜索供应商...",
                        })}
                        emptyLabel={t("proxy.claudeModelRouting.providerNotFound", {
                          defaultValue: "未找到匹配供应商",
                        })}
                        onChange={(next) =>
                          savePolicy(row.key, {
                            defaultProviderId: next === "__none__" ? null : next,
                            enabled: next !== "__none__",
                            modelFailoverEnabled: next === "__none__" ? false : true,
                          })
                        }
                        disabled={!isCardEnabled || isDimmedByFailover || upsertPolicy.isPending}
                      />
                    </div>
                    <span className="min-w-0 max-w-[260px] truncate text-xs text-muted-foreground">
                      {t("proxy.mode.modelNameForProvider", {
                        defaultValue: "模型：{{model}}",
                        model: modelName,
                      })}
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    {retryCount > 0 && (
                      <span className="shrink-0 rounded bg-rose-100 px-1.5 py-0.5 text-[10px] font-medium text-rose-700 dark:bg-rose-900/40 dark:text-rose-200">
                        {t("proxy.mode.retryCount", {
                          defaultValue: "故障转移 {{count}} 次",
                          count: retryCount,
                        })}
                      </span>
                    )}
                    {!preferredId ? (
                      <span className="shrink-0 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-700 dark:bg-slate-800/80 dark:text-slate-200">
                        {t("proxy.mode.globalFallback", {
                          defaultValue: "回退全局模式",
                        })}
                      </span>
                    ) : isFailoverTag ? (
                      <span className="shrink-0 rounded bg-orange-100 px-1.5 py-0.5 text-[10px] font-medium text-orange-700 dark:bg-orange-900/40 dark:text-orange-200">
                        {t("proxy.mode.tagFailover", {
                          defaultValue: "故障切换",
                        })}
                      </span>
                    ) : (
                      <span className="shrink-0 rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-200">
                        {t("proxy.mode.tagDefault", { defaultValue: "默认路由" })}
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function SortableProviderCard({
  provider,
  isCurrent,
  appId,
  isInConfig,
  isOmo,
  isOmoSlim,
  onSwitch,
  onEdit,
  onDelete,
  onRemoveFromConfig,
  onDisableOmo,
  onDisableOmoSlim,
  onDuplicate,
  onConfigureUsage,
  onOpenWebsite,
  onOpenTerminal,
  onTest,
  isTesting,
  isProxyRunning,
  isProxyTakeover,
  isAutoFailoverEnabled,
  failoverPriority,
  isInFailoverQueue,
  onToggleFailover,
  activeProviderId,
  isDefaultModel,
  onSetAsDefault,
  onContextMenu,
}: SortableProviderCardProps) {
  const {
    setNodeRef,
    attributes,
    listeners,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: provider.id });

  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <div ref={setNodeRef} style={style} onContextMenu={onContextMenu}>
      <ProviderCard
        provider={provider}
        isCurrent={isCurrent}
        appId={appId}
        isInConfig={isInConfig}
        isOmo={isOmo}
        isOmoSlim={isOmoSlim}
        onSwitch={onSwitch}
        onEdit={onEdit}
        onDelete={onDelete}
        onRemoveFromConfig={onRemoveFromConfig}
        onDisableOmo={onDisableOmo}
        onDisableOmoSlim={onDisableOmoSlim}
        onDuplicate={onDuplicate}
        onConfigureUsage={
          onConfigureUsage ? (item) => onConfigureUsage(item) : () => undefined
        }
        onOpenWebsite={onOpenWebsite}
        onOpenTerminal={onOpenTerminal}
        onTest={onTest}
        isTesting={isTesting}
        isProxyRunning={isProxyRunning}
        isProxyTakeover={isProxyTakeover}
        dragHandleProps={{
          attributes,
          listeners,
          isDragging,
        }}
        isAutoFailoverEnabled={isAutoFailoverEnabled}
        failoverPriority={failoverPriority}
        isInFailoverQueue={isInFailoverQueue}
        onToggleFailover={onToggleFailover}
        activeProviderId={activeProviderId}
        // OpenClaw: default model
        isDefaultModel={isDefaultModel}
        onSetAsDefault={onSetAsDefault}
      />
    </div>
  );
}
