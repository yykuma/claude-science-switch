import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isHttpLoopbackUrl,
  normalizeScienceProxyStatus,
  scienceProxyApi,
  type ScienceProxyConfig,
} from "./scienceProxy";

const createJsonResponse = (body: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });

const createConfig = (
  overrides: Partial<ScienceProxyConfig> = {},
): ScienceProxyConfig => ({
  enabled: true,
  baseUrl: "http://127.0.0.1:17777",
  adminToken: "science-secret",
  selectedProviderId: "auto",
  ...overrides,
});

describe("normalizeScienceProxyStatus", () => {
  it("parses providers, activeProvider, and nested stats from admin state", () => {
    const status = normalizeScienceProxyStatus(
      {
        ok: true,
        providers: {
          claude: {
            id: "claude",
            name: "Claude",
            appType: "claude",
            model: "claude-sonnet-4",
            enabled: true,
          },
          codex: {
            providerName: "Codex",
            app_type: "codex",
            model_name: "gpt-5",
            enabled: false,
          },
        },
        activeProvider: "codex",
        stats: {
          uptimeSeconds: "42",
          activeConnections: 3,
          totalRequests: "120",
          successRate: "0.975",
        },
      },
      "http://127.0.0.1:17777/admin/state",
      200,
    );

    expect(status).toMatchObject({
      ok: true,
      state: "online",
      running: true,
      endpoint: "http://127.0.0.1:17777/admin/state",
      statusCode: 200,
      uptimeSeconds: 42,
      activeConnections: 3,
      totalRequests: 120,
      successRate: 0.975,
      currentProvider: {
        id: "codex",
        name: "Codex",
        model: "gpt-5",
      },
    });
    expect(status.providers).toEqual([
      {
        id: "claude",
        name: "Claude",
        appType: "claude",
        model: "claude-sonnet-4",
        enabled: true,
        isCurrent: undefined,
        status: undefined,
      },
      {
        id: "codex",
        name: "Codex",
        appType: "codex",
        model: "gpt-5",
        enabled: false,
        isCurrent: undefined,
        status: undefined,
      },
    ]);
  });

  it("uses defaultModel from the active provider list entry", () => {
    const status = normalizeScienceProxyStatus(
      {
        activeProvider: "cliproxy-gpt55",
        providers: [
          {
            id: "cliproxy-gpt55",
            name: "cliproxy-gpt55",
            active: true,
            defaultModel: "gpt-5.5",
          },
        ],
      },
      "http://127.0.0.1:17777/admin/state",
      200,
    );

    expect(status.currentProvider).toMatchObject({
      id: "cliproxy-gpt55",
      name: "cliproxy-gpt55",
      model: "gpt-5.5",
    });
    expect(status.providers[0]?.model).toBe("gpt-5.5");
  });
});

describe("scienceProxyApi", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads /admin/state and normalizes root proxy state", async () => {
    fetchMock.mockResolvedValueOnce(
      createJsonResponse({
        running: true,
        providers: [
          { id: "claude", name: "Claude" },
          { id: "kimi", name: "Moonshot", current: true },
        ],
        activeProvider: { id: "kimi", name: "Moonshot" },
        stats: {
          uptime_seconds: 12,
          active_connections: 2,
          total_requests: 8,
          success_rate: 1,
        },
      }),
    );

    const status = await scienceProxyApi.getStatus(
      createConfig({ baseUrl: " http://127.0.0.1:17777/ " }),
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:17777/admin/state",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          Accept: "application/json",
          Authorization: "Bearer science-secret",
          "X-Admin-Token": "science-secret",
          "x-cs-switch-admin": "science-secret",
        }),
      }),
    );
    expect(status).toMatchObject({
      ok: true,
      state: "online",
      endpoint: "http://127.0.0.1:17777/admin/state",
      uptimeSeconds: 12,
      activeConnections: 2,
      totalRequests: 8,
      successRate: 1,
      currentProvider: {
        id: "kimi",
        name: "Moonshot",
      },
    });
    expect(status.providers).toHaveLength(2);
  });

  it("posts provider switch requests to /admin/use with admin headers and body", async () => {
    fetchMock.mockResolvedValueOnce(createJsonResponse({ ok: true }));

    await scienceProxyApi.switchProvider(
      createConfig({
        baseUrl: "http://localhost:17777/",
        adminToken: " science-secret ",
      }),
      "kimi",
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:17777/admin/use",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Accept: "application/json",
          Authorization: "Bearer science-secret",
          "X-Admin-Token": "science-secret",
          "x-cs-switch-admin": "science-secret",
          "Content-Type": "application/json",
        }),
        body: JSON.stringify({
          provider: "kimi",
          providerId: "kimi",
          persist: true,
        }),
      }),
    );
  });

  it("rejects non-loopback proxy URLs before fetching", async () => {
    await expect(
      scienceProxyApi.getStatus(
        createConfig({ baseUrl: "https://api.example.com:17777" }),
      ),
    ).rejects.toThrow("loopback");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(isHttpLoopbackUrl("http://127.0.0.1:17777")).toBe(true);
    expect(isHttpLoopbackUrl("https://api.example.com")).toBe(false);
  });
});
