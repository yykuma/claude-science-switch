import { invoke } from "@tauri-apps/api/core";

export const SCIENCE_PROXY_DEFAULT_BASE_URL = "http://127.0.0.1:17777";
export const SCIENCE_PROXY_CONFIG_STORAGE_KEY =
  "claude-science-switch:science-proxy-config";

export type ScienceProxyConnectionState =
  | "disabled"
  | "online"
  | "offline"
  | "unauthorized"
  | "unknown";

export interface ScienceProxyConfig {
  enabled: boolean;
  baseUrl: string;
  adminToken: string;
  selectedProviderId: string;
}

export interface ScienceProxyProvider {
  id: string;
  name: string;
  appType?: string;
  model?: string;
  enabled?: boolean;
  isCurrent?: boolean;
  status?: string;
}

export interface ScienceProxyStatus {
  ok: boolean;
  state: ScienceProxyConnectionState;
  running: boolean;
  endpoint: string;
  statusCode?: number;
  version?: string;
  uptimeSeconds?: number;
  activeConnections?: number;
  totalRequests?: number;
  successRate?: number;
  currentProvider: ScienceProxyProvider | null;
  providers: ScienceProxyProvider[];
  lastError?: string | null;
  raw?: unknown;
}

export interface ManagedScienceProxyProcessStatus {
  managed: boolean;
  running: boolean;
  pid?: number | null;
  baseUrl: string;
  adminToken: string;
  clientToken: string;
  configPath?: string | null;
  cliPath?: string | null;
  provider?: string | null;
  exitStatus?: string | null;
}

export interface ManagedScienceAppProcessStatus {
  managed: boolean;
  running: boolean;
  pid?: number | null;
  baseUrl: string;
  clientToken: string;
  profileRoot?: string | null;
  dataDir?: string | null;
  configPath?: string | null;
  cliPath?: string | null;
  webUrl?: string | null;
  exitStatus?: string | null;
}

export type ScienceProxyPreflightCheckStatus = "pass" | "warn" | "fail";

export interface ScienceProxyPreflightCheck {
  id: string;
  label: string;
  status: ScienceProxyPreflightCheckStatus;
  detail: string;
  path?: string | null;
}

export interface ScienceProxyPreflightReport {
  ok: boolean;
  warnings: number;
  checks: ScienceProxyPreflightCheck[];
}

const STATUS_ENDPOINTS = [
  "/admin/state",
  "/api/admin/status",
  "/admin/status",
  "/api/status",
  "/status",
  "/health",
];

const PROVIDER_SWITCH_ENDPOINTS = [
  "/admin/use",
  "/api/admin/provider",
  "/admin/provider",
  "/api/provider",
];

class EndpointNotFoundError extends Error {}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const normalizeBaseUrl = (baseUrl: string): string => {
  const trimmed = baseUrl.trim() || SCIENCE_PROXY_DEFAULT_BASE_URL;
  const url = new URL(trimmed);
  if (url.protocol !== "http:") {
    throw new Error("Science proxy URL must use http loopback");
  }
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    throw new Error("Science proxy URL must use a loopback host");
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/+$/, "");
};

export const isHttpLoopbackUrl = (baseUrl: string): boolean => {
  try {
    normalizeBaseUrl(baseUrl);
    return true;
  } catch {
    return false;
  }
};

const getString = (
  record: Record<string, unknown>,
  keys: string[],
): string | undefined => {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number") return String(value);
  }
  return undefined;
};

const getNumber = (
  record: Record<string, unknown>,
  keys: string[],
): number | undefined => {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim()) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
};

const getBoolean = (
  record: Record<string, unknown>,
  keys: string[],
): boolean | undefined => {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "boolean") return value;
    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      if (["true", "running", "online", "ok", "healthy"].includes(normalized)) {
        return true;
      }
      if (["false", "stopped", "offline", "error"].includes(normalized)) {
        return false;
      }
    }
  }
  return undefined;
};

const getFirstValue = (
  record: Record<string, unknown>,
  keys: string[],
): unknown => {
  for (const key of keys) {
    if (record[key] !== undefined) return record[key];
  }
  return undefined;
};

const getPayloadRecord = (raw: unknown): Record<string, unknown> => {
  if (!isRecord(raw)) {
    if (typeof raw === "string") {
      return { status: raw };
    }
    return {};
  }

  const nested = getFirstValue(raw, ["data", "proxy", "server", "status"]);
  if (isRecord(nested)) {
    return { ...raw, ...nested };
  }

  const stats = getFirstValue(raw, ["stats"]);
  if (isRecord(stats)) {
    return { ...raw, ...stats };
  }

  return raw;
};

const normalizeProvider = (
  value: unknown,
  index: number,
  fallbackId?: string,
): ScienceProxyProvider | null => {
  if (typeof value === "string") {
    const id = fallbackId ?? value;
    return {
      id,
      name: value,
    };
  }

  if (!isRecord(value)) return null;

  const id =
    getString(value, ["id", "provider_id", "providerId", "key", "name"]) ??
    fallbackId ??
    `provider-${index + 1}`;
  const name =
    getString(value, [
      "name",
      "provider_name",
      "providerName",
      "label",
      "id",
    ]) ?? id;

  return {
    id,
    name,
    appType: getString(value, ["app_type", "appType", "type"]),
    model: getString(value, [
      "model",
      "model_name",
      "modelName",
      "default_model",
      "defaultModel",
      "mappedModel",
    ]),
    enabled: getBoolean(value, ["enabled", "active"]),
    isCurrent: getBoolean(value, [
      "current",
      "is_current",
      "isCurrent",
      "active",
    ]),
    status: getString(value, ["status", "state", "health"]),
  };
};

const normalizeProviders = (rawProviders: unknown): ScienceProxyProvider[] => {
  if (Array.isArray(rawProviders)) {
    return rawProviders
      .map((provider, index) => normalizeProvider(provider, index))
      .filter(
        (provider): provider is ScienceProxyProvider => provider !== null,
      );
  }

  if (isRecord(rawProviders)) {
    return Object.entries(rawProviders)
      .map(([id, provider], index) => normalizeProvider(provider, index, id))
      .filter(
        (provider): provider is ScienceProxyProvider => provider !== null,
      );
  }

  return [];
};

const getCurrentProvider = (
  payload: Record<string, unknown>,
  providers: ScienceProxyProvider[],
): ScienceProxyProvider | null => {
  const explicit = getFirstValue(payload, [
    "current_provider",
    "currentProvider",
    "active_provider",
    "activeProvider",
    "provider",
  ]);
  if (typeof explicit === "string" && explicit.trim()) {
    const explicitId = explicit.trim();
    return (
      providers.find((provider) => provider.id === explicitId) ?? {
        id: explicitId,
        name: explicitId,
      }
    );
  }

  const normalizedExplicit = normalizeProvider(explicit, 0);
  if (normalizedExplicit) {
    return normalizedExplicit;
  }

  const currentProviderId = getString(payload, [
    "current_provider_id",
    "currentProviderId",
    "active_provider_id",
    "activeProviderId",
    "provider_id",
    "providerId",
  ]);
  if (currentProviderId) {
    return (
      providers.find((provider) => provider.id === currentProviderId) ?? {
        id: currentProviderId,
        name: currentProviderId,
      }
    );
  }

  return providers.find((provider) => provider.isCurrent) ?? null;
};

const getStatusRunning = (
  payload: Record<string, unknown>,
  fallback: boolean,
): boolean => {
  const running = getBoolean(payload, [
    "running",
    "online",
    "ok",
    "healthy",
    "enabled",
  ]);
  if (running !== undefined) return running;

  const statusText = getString(payload, ["status", "state"]);
  if (!statusText) return fallback;

  return ["running", "online", "ok", "healthy", "ready"].includes(
    statusText.toLowerCase(),
  );
};

export const createDefaultScienceProxyConfig = (): ScienceProxyConfig => ({
  enabled: true,
  baseUrl:
    import.meta.env.VITE_SCIENCE_PROXY_URL?.trim() ||
    SCIENCE_PROXY_DEFAULT_BASE_URL,
  adminToken: import.meta.env.VITE_SCIENCE_PROXY_ADMIN_TOKEN?.trim() || "",
  selectedProviderId: "auto",
});

export const normalizeScienceProxyStatus = (
  raw: unknown,
  endpoint: string,
  statusCode?: number,
): ScienceProxyStatus => {
  const payload = getPayloadRecord(raw);
  const providers = normalizeProviders(
    getFirstValue(payload, [
      "providers",
      "provider_list",
      "providerList",
      "targets",
      "active_targets",
      "activeTargets",
      "models",
    ]),
  );
  const currentProvider = getCurrentProvider(payload, providers);
  const running = getStatusRunning(payload, true);

  return {
    ok: running,
    state: running ? "online" : "unknown",
    running,
    endpoint,
    statusCode,
    version: getString(payload, ["version", "build", "commit"]),
    uptimeSeconds: getNumber(payload, [
      "uptime_seconds",
      "uptimeSeconds",
      "uptime",
    ]),
    activeConnections: getNumber(payload, [
      "active_connections",
      "activeConnections",
      "connections",
    ]),
    totalRequests: getNumber(payload, [
      "total_requests",
      "totalRequests",
      "requests",
      "request_count",
      "requestCount",
    ]),
    successRate: getNumber(payload, ["success_rate", "successRate"]),
    currentProvider,
    providers,
    lastError:
      getString(payload, ["last_error", "lastError", "error", "message"]) ??
      null,
    raw,
  };
};

const buildHeaders = (adminToken: string): HeadersInit => {
  const headers: Record<string, string> = {
    Accept: "application/json",
  };
  const token = adminToken.trim();
  if (token) {
    headers.Authorization = `Bearer ${token}`;
    headers["X-Admin-Token"] = token;
    headers["x-cs-switch-admin"] = token;
  }
  return headers;
};

const readResponseBody = async (response: Response): Promise<unknown> => {
  const text = await response.text();
  if (!text) return {};

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { message: text };
  }
};

const fetchWithTimeout = async (
  url: string,
  init: RequestInit,
  timeoutMs = 2500,
): Promise<Response> => {
  const controller = new AbortController();
  const timeout = globalThis.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    globalThis.clearTimeout(timeout);
  }
};

const requestStatusEndpoint = async (
  baseUrl: string,
  path: string,
  adminToken: string,
): Promise<ScienceProxyStatus> => {
  const endpoint = `${normalizeBaseUrl(baseUrl)}${path}`;
  const response = await fetchWithTimeout(endpoint, {
    method: "GET",
    headers: buildHeaders(adminToken),
  });

  if (response.status === 404 || response.status === 405) {
    throw new EndpointNotFoundError(endpoint);
  }

  if (response.status === 401 || response.status === 403) {
    return {
      ok: false,
      state: "unauthorized",
      running: false,
      endpoint,
      statusCode: response.status,
      currentProvider: null,
      providers: [],
      lastError: "Admin token required",
    };
  }

  const body = await readResponseBody(response);
  if (!response.ok) {
    return {
      ok: false,
      state: "unknown",
      running: false,
      endpoint,
      statusCode: response.status,
      currentProvider: null,
      providers: [],
      lastError: isRecord(body)
        ? (getString(body, ["error", "message"]) ?? response.statusText)
        : response.statusText,
      raw: body,
    };
  }

  return normalizeScienceProxyStatus(body, endpoint, response.status);
};

const postProviderEndpoint = async (
  baseUrl: string,
  path: string,
  adminToken: string,
  providerId: string,
): Promise<void> => {
  const endpoint = `${normalizeBaseUrl(baseUrl)}${path}`;
  const response = await fetchWithTimeout(endpoint, {
    method: "POST",
    headers: {
      ...buildHeaders(adminToken),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      provider: providerId,
      providerId,
      persist: true,
    }),
  });

  if (response.status === 404 || response.status === 405) {
    throw new EndpointNotFoundError(endpoint);
  }

  if (!response.ok) {
    const body = await readResponseBody(response);
    const message = isRecord(body)
      ? (getString(body, ["error", "message"]) ?? response.statusText)
      : response.statusText;
    throw new Error(message);
  }
};

export const scienceProxyApi = {
  async getManagedProcessStatus(): Promise<ManagedScienceProxyProcessStatus> {
    return invoke<ManagedScienceProxyProcessStatus>(
      "get_science_proxy_process_status",
    );
  },

  async startManagedProcess(
    config: ScienceProxyConfig,
  ): Promise<ManagedScienceProxyProcessStatus> {
    return invoke<ManagedScienceProxyProcessStatus>(
      "start_science_proxy_process",
      {
        baseUrl: normalizeBaseUrl(config.baseUrl),
        adminToken: config.adminToken.trim() || null,
        provider:
          config.selectedProviderId === "auto"
            ? null
            : config.selectedProviderId,
      },
    );
  },

  async stopManagedProcess(): Promise<ManagedScienceProxyProcessStatus> {
    return invoke<ManagedScienceProxyProcessStatus>(
      "stop_science_proxy_process",
    );
  },

  async runPreflight(
    config: ScienceProxyConfig,
  ): Promise<ScienceProxyPreflightReport> {
    return invoke<ScienceProxyPreflightReport>("run_science_proxy_preflight", {
      baseUrl: normalizeBaseUrl(config.baseUrl),
      configPath: null,
      cliPath: null,
    });
  },

  async getManagedScienceAppStatus(): Promise<ManagedScienceAppProcessStatus> {
    return invoke<ManagedScienceAppProcessStatus>(
      "get_science_app_process_status",
    );
  },

  async launchScienceAppWithProxy(
    config: ScienceProxyConfig,
    clientToken?: string | null,
  ): Promise<ManagedScienceAppProcessStatus> {
    return invoke<ManagedScienceAppProcessStatus>(
      "launch_science_app_with_proxy",
      {
        baseUrl: normalizeBaseUrl(config.baseUrl),
        clientToken: clientToken?.trim() || null,
        openBrowser: true,
      },
    );
  },

  async stopManagedScienceApp(): Promise<ManagedScienceAppProcessStatus> {
    return invoke<ManagedScienceAppProcessStatus>("stop_science_app_process");
  },

  async openProxyConfigFolder(): Promise<void> {
    await invoke("open_science_proxy_config_folder");
  },

  async openScienceAppProfileFolder(): Promise<void> {
    await invoke("open_science_app_profile_folder");
  },

  async getStatus(config: ScienceProxyConfig): Promise<ScienceProxyStatus> {
    const baseUrl = normalizeBaseUrl(config.baseUrl);
    let lastError: unknown;

    for (const path of STATUS_ENDPOINTS) {
      try {
        return await requestStatusEndpoint(baseUrl, path, config.adminToken);
      } catch (error) {
        if (error instanceof EndpointNotFoundError) {
          lastError = error;
          continue;
        }
        lastError = error;
        break;
      }
    }

    return {
      ok: false,
      state: "offline",
      running: false,
      endpoint: baseUrl,
      currentProvider: null,
      providers: [],
      lastError:
        lastError instanceof Error ? lastError.message : "Proxy unavailable",
    };
  },

  async switchProvider(
    config: ScienceProxyConfig,
    providerId: string,
  ): Promise<void> {
    let lastError: unknown;

    for (const path of PROVIDER_SWITCH_ENDPOINTS) {
      try {
        await postProviderEndpoint(
          config.baseUrl,
          path,
          config.adminToken,
          providerId,
        );
        return;
      } catch (error) {
        if (error instanceof EndpointNotFoundError) {
          lastError = error;
          continue;
        }
        throw error;
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new Error("Provider switch endpoint not found");
  },
};
