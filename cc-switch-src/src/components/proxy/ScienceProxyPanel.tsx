import { useMemo } from "react";
import {
  Activity,
  AlertTriangle,
  Check,
  Clipboard,
  ExternalLink,
  FolderOpen,
  KeyRound,
  ListChecks,
  Loader2,
  Microscope,
  Play,
  RefreshCw,
  Route,
  Server,
  Settings,
  Square,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useScienceProxy } from "@/hooks/useScienceProxy";
import { scienceProxyApi, settingsApi } from "@/lib/api";
import type { ScienceProxyConnectionState } from "@/lib/api/scienceProxy";
import { isHttpLoopbackUrl } from "@/lib/api/scienceProxy";
import { copyText } from "@/lib/clipboard";
import { cn } from "@/lib/utils";

interface ProviderOption {
  id: string;
  name: string;
  appType?: string;
  model?: string;
}

const formatUptime = (seconds?: number): string => {
  if (!seconds || seconds < 0) return "-";

  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${Math.floor(seconds)}s`;
};

const formatCompactNumber = (value?: number): string => {
  if (value === undefined) return "-";
  return new Intl.NumberFormat(undefined, {
    maximumFractionDigits: 1,
    notation: value >= 10000 ? "compact" : "standard",
  }).format(value);
};

const normalizeUrl = (value: string): string =>
  (value.trim() || "http://127.0.0.1:17777").replace(/\/+$/, "");

const getErrorMessage = (error: unknown, fallback: string): string => {
  if (error instanceof Error) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  return fallback;
};

const formatProvider = (provider?: ProviderOption | null): string => {
  if (!provider) return "-";
  return provider.model
    ? `${provider.name} -> ${provider.model}`
    : provider.name;
};

export function ScienceProxyPanel() {
  const { t } = useTranslation();
  const {
    config,
    status,
    processStatus,
    scienceAppStatus,
    isLoading,
    isFetching,
    isSwitchingProvider,
    isStartingProxy,
    isStoppingProxy,
    isLaunchingScienceApp,
    isStoppingScienceApp,
    isRunningPreflight,
    preflightReport,
    preflightError,
    switchError,
    processError,
    scienceAppError,
    updateConfig,
    selectProvider,
    applyProvider,
    startManagedProxy,
    stopManagedProxy,
    launchScienceAppWithProxy,
    stopManagedScienceApp,
    runPreflight,
    refresh,
  } = useScienceProxy();

  const state: ScienceProxyConnectionState = isLoading
    ? "unknown"
    : (status?.state ?? "offline");

  const stateLabel = useMemo(() => {
    if (isLoading) {
      return t("scienceProxy.state.checking", { defaultValue: "检测中" });
    }

    const labels: Record<ScienceProxyConnectionState, string> = {
      disabled: t("scienceProxy.state.disabled", { defaultValue: "未启用" }),
      online: t("scienceProxy.state.online", { defaultValue: "在线" }),
      offline: t("scienceProxy.state.offline", { defaultValue: "离线" }),
      unauthorized: t("scienceProxy.state.unauthorized", {
        defaultValue: "需要 Token",
      }),
      unknown: t("scienceProxy.state.unknown", { defaultValue: "未知" }),
    };
    return labels[state];
  }, [isLoading, state, t]);

  const providerOptions = useMemo<ProviderOption[]>(() => {
    const options: ProviderOption[] = [
      {
        id: "auto",
        name: t("scienceProxy.provider.auto", { defaultValue: "自动路由" }),
      },
    ];
    const seen = new Set(options.map((option) => option.id));

    for (const provider of status?.providers ?? []) {
      if (seen.has(provider.id)) continue;
      seen.add(provider.id);
      options.push({
        id: provider.id,
        name: provider.name,
        appType: provider.appType,
        model: provider.model,
      });
    }

    if (
      config.selectedProviderId !== "auto" &&
      !seen.has(config.selectedProviderId)
    ) {
      options.push({
        id: config.selectedProviderId,
        name: config.selectedProviderId,
      });
    }

    return options;
  }, [config.selectedProviderId, status?.providers, t]);

  const selectedProvider =
    providerOptions.find((option) => option.id === config.selectedProviderId) ??
    providerOptions[0];
  const currentProvider = status?.currentProvider ?? selectedProvider;
  const selectedIsCurrent =
    config.selectedProviderId === "auto" ||
    config.selectedProviderId === currentProvider?.id;
  const canApplyProvider =
    config.selectedProviderId !== "auto" &&
    !selectedIsCurrent &&
    state === "online" &&
    !isSwitchingProvider;
  const managedProxyRunning = Boolean(
    processStatus?.managed && processStatus.running,
  );
  const managedScienceRunning = Boolean(
    scienceAppStatus?.managed && scienceAppStatus.running,
  );
  const proxyReachable = state === "online" || state === "unauthorized";
  const externalProxyReachable = proxyReachable && !managedProxyRunning;
  const proxyUrl = normalizeUrl(processStatus?.baseUrl || config.baseUrl);
  const statusEndpoint = status?.endpoint ?? proxyUrl;
  const clientToken =
    processStatus?.clientToken ||
    scienceAppStatus?.clientToken ||
    "<managed-client-token>";
  const smokeCurlSnippet = [
    `curl -sS ${proxyUrl}/v1/messages \\`,
    "  -H 'content-type: application/json' \\",
    "  -H 'anthropic-version: 2023-06-01' \\",
    `  -H 'authorization: Bearer ${clientToken}' \\`,
    `  -d '{"model":"claude-opus-4-8","max_tokens":16,"messages":[{"role":"user","content":"只回复两个字：通了"}]}'`,
  ].join("\n");
  const proxyDetailsSnippet = [
    "Claude Science Switch",
    `Base URL: ${proxyUrl}`,
    `Client token: ${managedProxyRunning ? "managed-random" : "not available until managed proxy starts"}`,
    `Provider: ${formatProvider(currentProvider)}`,
    `Config path: ${processStatus?.configPath ?? "-"}`,
    `CLI path: ${processStatus?.cliPath ?? "-"}`,
    `Science data: ${scienceAppStatus?.dataDir ?? "-"}`,
    `Science URL: ${scienceAppStatus?.webUrl ?? "-"}`,
  ].join("\n");

  const copySnippet = async (text: string, successMessage: string) => {
    try {
      await copyText(text);
      toast.success(successMessage);
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : t("scienceProxy.actions.copyFailed", {
              defaultValue: "复制失败",
            }),
      );
    }
  };

  const openDashboard = async () => {
    try {
      if (!isHttpLoopbackUrl(proxyUrl)) {
        throw new Error("Dashboard 地址必须是本机 loopback HTTP 地址");
      }
      await settingsApi.openExternal(proxyUrl);
    } catch {
      void copySnippet(
        proxyUrl,
        t("scienceProxy.actions.dashboardUrlCopied", {
          defaultValue: "Dashboard 地址已复制",
        }),
      );
    }
  };

  const openConfigFolder = async () => {
    try {
      await scienceProxyApi.openProxyConfigFolder();
    } catch (error) {
      toast.error(
        getErrorMessage(
          error,
          t("scienceProxy.actions.openConfigFailed", {
            defaultValue: "打开配置目录失败",
          }),
        ),
      );
    }
  };

  const openScienceProfileFolder = async () => {
    try {
      await scienceProxyApi.openScienceAppProfileFolder();
    } catch (error) {
      toast.error(
        getErrorMessage(
          error,
          t("scienceProxy.actions.openProfileFailed", {
            defaultValue: "打开隔离目录失败",
          }),
        ),
      );
    }
  };
  const processErrorMessage = processError
    ? getErrorMessage(
        processError,
        t("scienceProxy.errors.process", {
          defaultValue: "代理进程操作失败",
        }),
      )
    : null;
  const scienceAppErrorMessage = scienceAppError
    ? getErrorMessage(
        scienceAppError,
        t("scienceProxy.errors.scienceApp", {
          defaultValue: "Claude Science 启动失败",
        }),
      )
    : null;
  const actionError =
    switchError ||
    status?.lastError ||
    processErrorMessage ||
    scienceAppErrorMessage ||
    preflightError;

  const handleStartProxy = async () => {
    try {
      await startManagedProxy();
      toast.success(
        t("scienceProxy.actions.started", {
          defaultValue: "Claude Science -> GPT-5.5 代理已启动",
        }),
      );
    } catch (error) {
      toast.error(
        getErrorMessage(
          error,
          t("scienceProxy.actions.startFailed", {
            defaultValue: "代理启动失败",
          }),
        ),
      );
    }
  };

  const handleLaunchScience = async () => {
    try {
      await launchScienceAppWithProxy();
      toast.success(
        t("scienceProxy.actions.scienceOpened", {
          defaultValue: "已打开隔离 Claude Science",
        }),
      );
    } catch (error) {
      toast.error(
        getErrorMessage(
          error,
          t("scienceProxy.actions.scienceOpenFailed", {
            defaultValue: "打开 Claude Science 失败",
          }),
        ),
      );
    }
  };

  const handleStopScience = async () => {
    try {
      await stopManagedScienceApp();
    } catch (error) {
      toast.error(
        getErrorMessage(
          error,
          t("scienceProxy.actions.scienceStopFailed", {
            defaultValue: "停止 Claude Science 失败",
          }),
        ),
      );
    }
  };

  const handleStopProxy = async () => {
    try {
      await stopManagedProxy();
    } catch (error) {
      toast.error(
        getErrorMessage(
          error,
          t("scienceProxy.actions.stopFailed", {
            defaultValue: "代理停止失败",
          }),
        ),
      );
    }
  };

  const handleRunPreflight = async () => {
    try {
      const report = await runPreflight();
      if (report.ok && report.warnings === 0) {
        toast.success(
          t("scienceProxy.actions.preflightPassed", {
            defaultValue: "自检通过",
          }),
        );
      } else if (report.ok) {
        toast.warning(
          t("scienceProxy.actions.preflightWarnings", {
            defaultValue: "自检通过，但有警告",
          }),
        );
      } else {
        toast.error(
          t("scienceProxy.actions.preflightFailed", {
            defaultValue: "自检发现阻断项",
          }),
        );
      }
    } catch (error) {
      toast.error(
        getErrorMessage(
          error,
          t("scienceProxy.actions.preflightRunFailed", {
            defaultValue: "自检失败",
          }),
        ),
      );
    }
  };

  const handleApplyProvider = async () => {
    try {
      await applyProvider();
    } catch (error) {
      toast.error(
        getErrorMessage(
          error,
          t("scienceProxy.actions.applyFailed", {
            defaultValue: "切换 Provider 失败",
          }),
        ),
      );
    }
  };

  return (
    <div className="space-y-4 rounded-xl border border-border bg-card/50 p-4 transition-colors hover:bg-muted/50">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-background ring-1 ring-border">
            <Activity
              className={cn(
                "h-4 w-4",
                state === "online"
                  ? "text-emerald-500"
                  : state === "unauthorized"
                    ? "text-yellow-500"
                    : "text-muted-foreground",
              )}
            />
          </div>
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-sm font-medium leading-none">
                {t("scienceProxy.title", {
                  defaultValue: "Claude Science Switch 代理",
                })}
              </p>
              <Badge
                variant={state === "online" ? "default" : "secondary"}
                className={cn(
                  "gap-1.5",
                  state === "online" &&
                    "bg-emerald-500 text-white hover:bg-emerald-600",
                  state === "unauthorized" &&
                    "bg-yellow-500/15 text-yellow-700 hover:bg-yellow-500/20 dark:text-yellow-300",
                )}
              >
                {isFetching ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <span
                    className={cn(
                      "h-2 w-2 rounded-full bg-current",
                      state === "online" && "animate-pulse",
                    )}
                  />
                )}
                {stateLabel}
              </Badge>
            </div>
            <p className="text-xs text-muted-foreground">{statusEndpoint}</p>
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
          <Button
            type="button"
            size="sm"
            onClick={() => void handleLaunchScience()}
            disabled={isLaunchingScienceApp}
            className="w-40"
          >
            {isLaunchingScienceApp ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Microscope className="h-4 w-4" />
            )}
            {t("scienceProxy.actions.launchScience", {
              defaultValue: "启动并打开",
            })}
          </Button>
          <Button
            type="button"
            size="sm"
            variant={managedProxyRunning ? "secondary" : "outline"}
            onClick={() => void handleStartProxy()}
            disabled={isStartingProxy || managedProxyRunning}
            className="w-28"
          >
            {isStartingProxy ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Play className="h-4 w-4" />
            )}
            {t("scienceProxy.actions.start", {
              defaultValue: "启动代理",
            })}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => void handleStopProxy()}
            disabled={isStoppingProxy || !managedProxyRunning}
            className="w-20"
          >
            {isStoppingProxy ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Square className="h-4 w-4" />
            )}
            {t("scienceProxy.actions.stop", { defaultValue: "停止" })}
          </Button>
        </div>
      </div>

      {externalProxyReachable ? (
        <div className="flex items-start gap-2 rounded-md border border-yellow-500/30 bg-yellow-500/10 px-3 py-2 text-xs text-yellow-800 dark:text-yellow-200">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span className="min-w-0">
            {t("scienceProxy.warnings.externalProxy", {
              defaultValue:
                "此地址上有可达代理，但不是本应用托管的进程；启动隔离 Claude Science 前会尝试启动托管代理，若端口被占用请更换端口或停止外部代理。",
            })}
          </span>
        </div>
      ) : null}

      <div className="grid gap-4 md:grid-cols-2">
        <div className="space-y-2">
          <Label
            htmlFor="science-proxy-base-url"
            className="flex items-center gap-2 text-xs"
          >
            <Server className="h-3.5 w-3.5 text-muted-foreground" />
            {t("scienceProxy.fields.baseUrl", { defaultValue: "代理地址" })}
          </Label>
          <Input
            id="science-proxy-base-url"
            value={config.baseUrl}
            onChange={(event) => updateConfig({ baseUrl: event.target.value })}
            placeholder="http://127.0.0.1:17777"
          />
        </div>

        <div className="space-y-2">
          <Label
            htmlFor="science-proxy-admin-token"
            className="flex items-center gap-2 text-xs"
          >
            <KeyRound className="h-3.5 w-3.5 text-muted-foreground" />
            {t("scienceProxy.fields.adminToken", {
              defaultValue: "Admin Token",
            })}
          </Label>
          <Input
            id="science-proxy-admin-token"
            type="password"
            value={config.adminToken}
            onChange={(event) =>
              updateConfig({ adminToken: event.target.value })
            }
            placeholder={t("scienceProxy.fields.adminTokenPlaceholder", {
              defaultValue: "可选",
            })}
          />
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_auto_auto_auto] md:items-end">
        <div className="space-y-2">
          <Label className="flex items-center gap-2 text-xs">
            <Route className="h-3.5 w-3.5 text-muted-foreground" />
            {t("scienceProxy.fields.provider", {
              defaultValue: "Provider 目标",
            })}
          </Label>
          <Select
            value={config.selectedProviderId}
            onValueChange={selectProvider}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {providerOptions.map((provider) => (
                <SelectItem key={provider.id} value={provider.id}>
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="truncate">{provider.name}</span>
                    {provider.appType ? (
                      <span className="text-xs text-muted-foreground">
                        {provider.appType}
                      </span>
                    ) : null}
                    {provider.model ? (
                      <span className="text-xs text-muted-foreground">
                        {provider.model}
                      </span>
                    ) : null}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <Button
          type="button"
          size="sm"
          onClick={() => void handleApplyProvider()}
          disabled={!canApplyProvider}
          className="md:w-24"
        >
          {isSwitchingProvider ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Check className="h-4 w-4" />
          )}
          {t("scienceProxy.actions.apply", { defaultValue: "应用" })}
        </Button>

        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void refresh()}
          disabled={isFetching}
          className="md:w-24"
        >
          {isFetching ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <RefreshCw className="h-4 w-4" />
          )}
          {t("common.refresh", { defaultValue: "刷新" })}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void handleRunPreflight()}
          disabled={isRunningPreflight}
          className="justify-start md:w-28"
        >
          {isRunningPreflight ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <ListChecks className="h-4 w-4" />
          )}
          {t("scienceProxy.actions.preflight", {
            defaultValue: "运行自检",
          })}
        </Button>
      </div>

      {preflightReport ? (
        <div className="space-y-2 rounded-md border border-border bg-background/60 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <Badge
              variant={preflightReport.ok ? "secondary" : "destructive"}
              className={cn(
                preflightReport.ok &&
                  preflightReport.warnings === 0 &&
                  "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
                preflightReport.ok &&
                  preflightReport.warnings > 0 &&
                  "bg-yellow-500/15 text-yellow-700 dark:text-yellow-300",
              )}
            >
              {preflightReport.ok
                ? preflightReport.warnings > 0
                  ? t("scienceProxy.preflight.warning", {
                      defaultValue: "自检有警告",
                    })
                  : t("scienceProxy.preflight.pass", {
                      defaultValue: "自检通过",
                    })
                : t("scienceProxy.preflight.fail", {
                    defaultValue: "自检失败",
                  })}
            </Badge>
            <span className="text-xs text-muted-foreground">
              {t("scienceProxy.preflight.count", {
                defaultValue: "{{total}} 项检查，{{warnings}} 个警告",
                total: preflightReport.checks.length,
                warnings: preflightReport.warnings,
              })}
            </span>
          </div>
          <div className="grid gap-2 md:grid-cols-2">
            {preflightReport.checks.map((check) => (
              <div
                key={check.id}
                className="min-w-0 rounded-md border border-border bg-card/50 px-3 py-2"
              >
                <div className="flex items-center gap-2">
                  {check.status === "pass" ? (
                    <Check className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
                  ) : (
                    <AlertTriangle
                      className={cn(
                        "h-3.5 w-3.5 shrink-0",
                        check.status === "warn"
                          ? "text-yellow-500"
                          : "text-destructive",
                      )}
                    />
                  )}
                  <p className="truncate text-xs font-medium">{check.label}</p>
                </div>
                <p className="mt-1 break-words text-xs text-muted-foreground">
                  {check.detail}
                </p>
                {check.path ? (
                  <p className="mt-1 truncate font-mono text-[11px] text-muted-foreground">
                    {check.path}
                  </p>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      ) : null}

      <div className="grid gap-2 md:grid-cols-3">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void openDashboard()}
          disabled={state === "offline"}
          className="justify-start"
        >
          <ExternalLink className="h-4 w-4" />
          {t("scienceProxy.actions.openDashboard", {
            defaultValue: "打开 Dashboard",
          })}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() =>
            void copySnippet(
              smokeCurlSnippet,
              t("scienceProxy.actions.curlCopied", {
                defaultValue: "最短验证命令已复制",
              }),
            )
          }
          className="justify-start"
        >
          <Clipboard className="h-4 w-4" />
          {t("scienceProxy.actions.copyCurl", {
            defaultValue: "复制最短验证",
          })}
        </Button>
      </div>

      <div className="grid gap-2 md:grid-cols-3">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() =>
            void copySnippet(
              proxyDetailsSnippet,
              t("scienceProxy.actions.detailsCopied", {
                defaultValue: "代理详情已复制",
              }),
            )
          }
          className="justify-start"
        >
          <Clipboard className="h-4 w-4" />
          {t("scienceProxy.actions.copyDetails", {
            defaultValue: "复制代理详情",
          })}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void handleStopScience()}
          disabled={isStoppingScienceApp || !managedScienceRunning}
          className="justify-start"
        >
          {isStoppingScienceApp ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Square className="h-4 w-4" />
          )}
          {t("scienceProxy.actions.stopScience", {
            defaultValue: "停止 Science",
          })}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void openConfigFolder()}
          className="justify-start"
        >
          <Settings className="h-4 w-4" />
          {t("scienceProxy.actions.openConfigFolder", {
            defaultValue: "代理配置",
          })}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void openScienceProfileFolder()}
          className="justify-start"
        >
          <FolderOpen className="h-4 w-4" />
          {t("scienceProxy.actions.openProfileFolder", {
            defaultValue: "隔离目录",
          })}
        </Button>
      </div>

      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-6">
        <ScienceProxyStat
          label={t("scienceProxy.stats.provider", {
            defaultValue: "当前 Provider",
          })}
          value={formatProvider(currentProvider)}
        />
        <ScienceProxyStat
          label={t("scienceProxy.stats.requests", {
            defaultValue: "请求数",
          })}
          value={formatCompactNumber(status?.totalRequests)}
        />
        <ScienceProxyStat
          label={t("scienceProxy.stats.connections", {
            defaultValue: "连接",
          })}
          value={formatCompactNumber(status?.activeConnections)}
        />
        <ScienceProxyStat
          label={t("scienceProxy.stats.uptime", {
            defaultValue: "运行时间",
          })}
          value={formatUptime(status?.uptimeSeconds)}
        />
        <ScienceProxyStat
          label={t("scienceProxy.stats.process", {
            defaultValue: "托管进程",
          })}
          value={
            managedProxyRunning
              ? `PID ${processStatus?.pid ?? "-"}`
              : t("scienceProxy.state.offline", { defaultValue: "离线" })
          }
        />
        <ScienceProxyStat
          label={t("scienceProxy.stats.scienceApp", {
            defaultValue: "Science 实例",
          })}
          value={
            managedScienceRunning
              ? `PID ${scienceAppStatus?.pid ?? "-"}`
              : t("scienceProxy.state.offline", { defaultValue: "离线" })
          }
        />
      </div>

      {actionError ? (
        <p className="whitespace-pre-wrap break-words text-xs text-muted-foreground">
          {actionError}
        </p>
      ) : null}
    </div>
  );
}

function ScienceProxyStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-md border border-border bg-background/60 px-3 py-2">
      <p className="truncate text-xs text-muted-foreground">{label}</p>
      <p className="truncate text-sm font-medium text-foreground">{value}</p>
    </div>
  );
}
