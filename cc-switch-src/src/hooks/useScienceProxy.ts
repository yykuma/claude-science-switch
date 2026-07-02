import { useCallback, useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  SCIENCE_PROXY_CONFIG_STORAGE_KEY,
  createDefaultScienceProxyConfig,
  scienceProxyApi,
  type ManagedScienceProxyProcessStatus,
  type ScienceProxyConfig,
  type ScienceProxyPreflightReport,
} from "@/lib/api/scienceProxy";

const readStoredConfig = (): ScienceProxyConfig => {
  const fallback = createDefaultScienceProxyConfig();

  if (typeof window === "undefined") {
    return fallback;
  }

  try {
    const stored = window.localStorage.getItem(
      SCIENCE_PROXY_CONFIG_STORAGE_KEY,
    );
    if (!stored) return fallback;

    const parsed = JSON.parse(stored) as Partial<ScienceProxyConfig>;
    return {
      ...fallback,
      ...parsed,
      enabled: true,
      baseUrl:
        typeof parsed.baseUrl === "string" && parsed.baseUrl.trim()
          ? parsed.baseUrl
          : fallback.baseUrl,
      adminToken:
        typeof parsed.adminToken === "string"
          ? parsed.adminToken
          : fallback.adminToken,
      selectedProviderId:
        typeof parsed.selectedProviderId === "string" &&
        parsed.selectedProviderId.trim()
          ? parsed.selectedProviderId
          : fallback.selectedProviderId,
    };
  } catch (error) {
    console.warn("[useScienceProxy] Failed to read stored config", error);
    return fallback;
  }
};

const writeStoredConfig = (config: ScienceProxyConfig) => {
  if (typeof window === "undefined") return;

  try {
    window.localStorage.setItem(
      SCIENCE_PROXY_CONFIG_STORAGE_KEY,
      JSON.stringify(config),
    );
  } catch (error) {
    console.warn("[useScienceProxy] Failed to persist config", error);
  }
};

const waitForProxyReachable = async (config: ScienceProxyConfig) => {
  let lastStatus = "offline";
  let lastError = "Proxy unavailable";
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const status = await scienceProxyApi.getStatus(config);
    lastStatus = status.state;
    lastError = status.lastError || lastError;
    if (status.state === "online" || status.state === "unauthorized") {
      return;
    }
    await new Promise((resolve) => window.setTimeout(resolve, 250));
  }
  throw new Error(
    `Proxy did not become reachable (${lastStatus}): ${lastError}`,
  );
};

const sleep = (ms: number) =>
  new Promise((resolve) => window.setTimeout(resolve, ms));

const normalizeComparableUrl = (value: string): string => {
  try {
    const url = new URL(value.trim());
    url.pathname = url.pathname.replace(/\/+$/, "");
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/+$/, "");
  } catch {
    return value.trim().replace(/\/+$/, "");
  }
};

const managedProcessMatchesConfig = (
  status: ManagedScienceProxyProcessStatus | undefined | null,
  config: ScienceProxyConfig,
): boolean => {
  if (!status?.managed || !status.running) return false;
  if (
    normalizeComparableUrl(status.baseUrl) !==
    normalizeComparableUrl(config.baseUrl)
  ) {
    return false;
  }
  if (
    config.selectedProviderId !== "auto" &&
    status.provider !== config.selectedProviderId
  ) {
    return false;
  }
  return true;
};

const waitForManagedProxy = async (
  config: ScienceProxyConfig,
  initialStatus?: ManagedScienceProxyProcessStatus,
) => {
  let lastStatus = initialStatus;
  let lastError = initialStatus?.exitStatus || "Managed proxy did not start";
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const status =
      attempt === 0 && lastStatus
        ? lastStatus
        : await scienceProxyApi.getManagedProcessStatus();
    lastStatus = status;
    if (managedProcessMatchesConfig(status, config)) {
      return status;
    }
    lastError = status.exitStatus || lastError;
    await sleep(250);
  }
  throw new Error(lastError);
};

export function useScienceProxy() {
  const [config, setConfig] = useState<ScienceProxyConfig>(readStoredConfig);
  const [configRevision, setConfigRevision] = useState(0);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const [isSwitchingProvider, setIsSwitchingProvider] = useState(false);
  const [processError, setProcessError] = useState<string | null>(null);
  const [isStartingProxy, setIsStartingProxy] = useState(false);
  const [isStoppingProxy, setIsStoppingProxy] = useState(false);
  const [scienceAppError, setScienceAppError] = useState<string | null>(null);
  const [isLaunchingScienceApp, setIsLaunchingScienceApp] = useState(false);
  const [isStoppingScienceApp, setIsStoppingScienceApp] = useState(false);
  const [preflightReport, setPreflightReport] =
    useState<ScienceProxyPreflightReport | null>(null);
  const [preflightError, setPreflightError] = useState<string | null>(null);
  const [isRunningPreflight, setIsRunningPreflight] = useState(false);

  useEffect(() => {
    writeStoredConfig(config);
  }, [config]);

  const updateConfig = useCallback((updates: Partial<ScienceProxyConfig>) => {
    setConfig((current) => ({
      ...current,
      ...updates,
    }));
    setConfigRevision((current) => current + 1);
  }, []);

  const statusQuery = useQuery({
    queryKey: [
      "scienceProxyStatus",
      config.baseUrl,
      config.adminToken,
      configRevision,
    ],
    queryFn: () => scienceProxyApi.getStatus(config),
    enabled: true,
    refetchInterval: 5000,
    refetchOnWindowFocus: false,
    retry: false,
  });

  const processQuery = useQuery({
    queryKey: ["scienceProxyProcess"],
    queryFn: () => scienceProxyApi.getManagedProcessStatus(),
    refetchInterval: 5000,
    refetchOnWindowFocus: false,
    retry: false,
  });

  const scienceAppQuery = useQuery({
    queryKey: ["scienceAppProcess"],
    queryFn: () => scienceProxyApi.getManagedScienceAppStatus(),
    refetchInterval: 5000,
    refetchOnWindowFocus: false,
    retry: false,
  });

  const selectProvider = useCallback(
    (selectedProviderId: string) => updateConfig({ selectedProviderId }),
    [updateConfig],
  );

  const applyProvider = useCallback(async () => {
    if (config.selectedProviderId === "auto") return;

    setIsSwitchingProvider(true);
    setSwitchError(null);
    try {
      await scienceProxyApi.switchProvider(config, config.selectedProviderId);
      await statusQuery.refetch();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Provider switch failed";
      setSwitchError(message);
      throw error;
    } finally {
      setIsSwitchingProvider(false);
    }
  }, [config, statusQuery]);

  const startManagedProxy = useCallback(async () => {
    setIsStartingProxy(true);
    setProcessError(null);
    try {
      const processStatus = await scienceProxyApi.startManagedProcess(config);
      const effectiveConfig = {
        ...config,
        enabled: true,
        baseUrl: processStatus.baseUrl || config.baseUrl,
        adminToken: processStatus.adminToken || config.adminToken,
      };
      const verifiedProcessStatus = await waitForManagedProxy(
        effectiveConfig,
        processStatus,
      );
      updateConfig({
        enabled: true,
        baseUrl: effectiveConfig.baseUrl,
        adminToken: effectiveConfig.adminToken,
      });
      await waitForProxyReachable(effectiveConfig);
      await processQuery.refetch();
      await statusQuery.refetch();
      return verifiedProcessStatus;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Proxy start failed";
      setProcessError(message);
      throw error;
    } finally {
      setIsStartingProxy(false);
    }
  }, [config, processQuery, statusQuery, updateConfig]);

  const stopManagedProxy = useCallback(async () => {
    setIsStoppingProxy(true);
    setProcessError(null);
    try {
      await scienceProxyApi.stopManagedProcess();
      await processQuery.refetch();
      await statusQuery.refetch();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Proxy stop failed";
      setProcessError(message);
      throw error;
    } finally {
      setIsStoppingProxy(false);
    }
  }, [processQuery, statusQuery]);

  const launchScienceAppWithProxy = useCallback(async () => {
    setIsLaunchingScienceApp(true);
    setScienceAppError(null);
    setProcessError(null);
    try {
      let effectiveConfig = config;
      let currentProcessStatus = processQuery.data;
      try {
        currentProcessStatus = await scienceProxyApi.getManagedProcessStatus();
      } catch {
        currentProcessStatus = processQuery.data;
      }
      const matchingProcessStatus = managedProcessMatchesConfig(
        currentProcessStatus,
        config,
      )
        ? currentProcessStatus
        : null;
      let effectiveClientToken = matchingProcessStatus?.clientToken;
      if (matchingProcessStatus) {
        effectiveConfig = {
          ...config,
          enabled: true,
          baseUrl: matchingProcessStatus.baseUrl || config.baseUrl,
          adminToken: matchingProcessStatus.adminToken || config.adminToken,
        };
        if (
          effectiveConfig.baseUrl !== config.baseUrl ||
          effectiveConfig.adminToken !== config.adminToken
        ) {
          updateConfig({
            enabled: true,
            baseUrl: effectiveConfig.baseUrl,
            adminToken: effectiveConfig.adminToken,
          });
        }
      }
      if (!managedProcessMatchesConfig(currentProcessStatus, effectiveConfig)) {
        const processStatus = await scienceProxyApi.startManagedProcess(config);
        effectiveConfig = {
          ...config,
          enabled: true,
          baseUrl: processStatus.baseUrl || config.baseUrl,
          adminToken: processStatus.adminToken || config.adminToken,
        };
        updateConfig({
          enabled: true,
          baseUrl: effectiveConfig.baseUrl,
          adminToken: effectiveConfig.adminToken,
        });
        currentProcessStatus = await waitForManagedProxy(
          effectiveConfig,
          processStatus,
        );
        effectiveClientToken = currentProcessStatus.clientToken;
        await waitForProxyReachable(effectiveConfig);
      } else {
        await waitForProxyReachable(effectiveConfig);
      }

      const appStatus = await scienceProxyApi.launchScienceAppWithProxy(
        effectiveConfig,
        effectiveClientToken,
      );
      await Promise.all([
        processQuery.refetch(),
        statusQuery.refetch(),
        scienceAppQuery.refetch(),
      ]);
      return appStatus;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Claude Science launch failed";
      setScienceAppError(message);
      throw error;
    } finally {
      setIsLaunchingScienceApp(false);
    }
  }, [config, processQuery, scienceAppQuery, statusQuery, updateConfig]);

  const stopManagedScienceApp = useCallback(async () => {
    setIsStoppingScienceApp(true);
    setScienceAppError(null);
    try {
      await scienceProxyApi.stopManagedScienceApp();
      await scienceAppQuery.refetch();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Claude Science stop failed";
      setScienceAppError(message);
      throw error;
    } finally {
      setIsStoppingScienceApp(false);
    }
  }, [scienceAppQuery]);

  const runPreflight = useCallback(async () => {
    setIsRunningPreflight(true);
    setPreflightError(null);
    try {
      const report = await scienceProxyApi.runPreflight(config);
      setPreflightReport(report);
      return report;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Science proxy preflight failed";
      setPreflightError(message);
      throw error;
    } finally {
      setIsRunningPreflight(false);
    }
  }, [config]);

  return {
    config,
    status: statusQuery.data,
    processStatus: processQuery.data,
    scienceAppStatus: scienceAppQuery.data,
    isLoading: statusQuery.isLoading,
    isFetching: statusQuery.isFetching,
    isSwitchingProvider,
    isStartingProxy,
    isStoppingProxy,
    isLaunchingScienceApp,
    isStoppingScienceApp,
    isRunningPreflight,
    error: statusQuery.error,
    processError: processQuery.error ?? processError,
    scienceAppError: scienceAppQuery.error ?? scienceAppError,
    preflightError,
    switchError,
    preflightReport,
    refresh: statusQuery.refetch,
    refreshProcess: processQuery.refetch,
    refreshScienceApp: scienceAppQuery.refetch,
    updateConfig,
    selectProvider,
    applyProvider,
    startManagedProxy,
    stopManagedProxy,
    launchScienceAppWithProxy,
    stopManagedScienceApp,
    runPreflight,
  };
}
