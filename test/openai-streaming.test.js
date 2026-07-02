import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const ROOT = path.resolve(import.meta.dirname, "..");
const CLI = path.join(ROOT, "bin", "claude-science-switch.js");

test("admin token can be supplied for desktop shell control", async () => {
  const adminToken = "test-admin-token-123";
  await withProxy(
    [],
    async ({ proxyUrl }) => {
      const unauthorized = await fetch(`${proxyUrl}/admin/state`);
      assert.equal(unauthorized.status, 401);

      const authorized = await fetch(`${proxyUrl}/admin/state`, {
        headers: { "x-cs-switch-admin": adminToken },
      });
      assert.equal(authorized.status, 200);
      const state = await authorized.json();
      assert.equal(state.ok, true);
      assert.equal(state.activeProvider, "mock-openai");
    },
    { adminToken },
  );
});

test("model routing follows cc-switch default and fable fallback semantics", async () => {
  const fixture = [
    {
      id: "chatcmpl_1",
      model: "gpt-test",
      choices: [{ delta: { content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    },
  ];

  await withProxy(
    fixture,
    async ({ proxyUrl, upstreamRequests }) => {
      await postAnthropicStream(proxyUrl, {
        model: "claude-fable-5[1m]",
        max_tokens: 16,
        stream: true,
        messages: [{ role: "user", content: "ping" }],
      });
      assert.equal(upstreamRequests.at(-1).model, "gpt-opus");

      await postAnthropicStream(proxyUrl, {
        model: "claude-unlisted-experimental",
        max_tokens: 16,
        stream: true,
        messages: [{ role: "user", content: "ping" }],
      });
      assert.equal(upstreamRequests.at(-1).model, "gpt-default");
    },
    {
      models: {
        default: "gpt-default",
        haiku: "gpt-haiku",
        sonnet: "gpt-sonnet",
        opus: "gpt-opus",
        fallbackUnknownToDefault: true,
      },
    },
  );
});

test("cc-switch provider shape normalizes env auth, model mapping, and full URLs", async () => {
  const fixture = [
    {
      id: "chatcmpl_ccswitch",
      model: "gpt-opus",
      choices: [{ delta: { content: "ok" }, finish_reason: "stop" }],
    },
  ];
  const upstream = await startMockOpenAI(fixture, {
    path: "/custom/chat?route=science",
  });

  await withProxyServer({
    apiFormat: "openai_chat",
    upstream,
    fn: async ({ proxyUrl, upstreamRequests }) => {
      await postAnthropicStream(proxyUrl, {
        model: "claude-opus-4-8",
        max_tokens: 16,
        stream: true,
        messages: [{ role: "user", content: "ping" }],
      });

      assert.equal(upstreamRequests[0].url, "/custom/chat?route=science");
      assert.equal(
        upstreamRequests[0].headers.authorization,
        "Bearer cc-switch-token",
      );
      assert.equal(upstreamRequests[0].model, "gpt-opus");
    },
    options: {
      providerName: "cc-switch-provider",
      provider: {
        settingsConfig: {
          env: {
            ANTHROPIC_BASE_URL: `${upstream.url}/custom/chat?route=science`,
            ANTHROPIC_AUTH_TOKEN: "cc-switch-token",
            ANTHROPIC_MODEL: "gpt-default",
            ANTHROPIC_DEFAULT_OPUS_MODEL: "gpt-opus",
          },
        },
        meta: {
          apiFormat: "openai_chat",
          isFullUrl: true,
        },
      },
    },
  });
});

test("cc-switch AppConfig current selects Codex TOML providers and model catalog", async () => {
  const upstream = await startMockOpenAIResponses({
    id: "resp_codex",
    model: "gpt-codex-alt",
    status: "completed",
    output: [
      {
        type: "message",
        content: [{ type: "output_text", text: "codex ok" }],
      },
    ],
    usage: { input_tokens: 3, output_tokens: 2 },
  });

  const provider = {
    providerType: "codex_api",
    settingsConfig: {
      auth: {
        OPENAI_API_KEY: "codex-token",
      },
      config: `
model = "gpt-codex-default"
model_provider = "openai"

[model_providers.openai]
base_url = "${upstream.url}"
wire_api = "responses"
`,
      modelCatalog: {
        models: [{ model: "gpt-codex-default" }, { model: "gpt-codex-alt" }],
      },
    },
    meta: {
      customUserAgent: "ScienceSwitchTest/1.0",
      localProxyRequestOverrides: {
        headers: {
          "X-Custom-Route": "codex",
        },
      },
    },
  };

  await withProxyServer({
    apiFormat: "openai_responses",
    upstream,
    fn: async ({ proxyUrl, upstreamRequests }) => {
      const models = await fetch(`${proxyUrl}/v1/models`, {
        headers: { authorization: "Bearer PROXY_MANAGED" },
      }).then((response) => response.json());
      assert.ok(
        models.data.some((item) => item.display_name === "gpt-codex-alt"),
      );
      assert.ok(models.data.every((item) => item.id.startsWith("claude-")));

      const response = await postAnthropic(proxyUrl, {
        model: "gpt-codex-alt",
        max_tokens: 16,
        messages: [{ role: "user", content: "ping" }],
      });

      assert.equal(response.content[0].text, "codex ok");
      assert.equal(upstreamRequests[0].model, "gpt-codex-alt");
      assert.equal(upstreamRequests[0].headers.authorization, "Bearer codex-token");
      assert.equal(upstreamRequests[0].headers["user-agent"], "ScienceSwitchTest/1.0");
      assert.equal(upstreamRequests[0].headers["x-custom-route"], "codex");
    },
    options: {
      providerName: "codex-provider",
      provider,
      config: ({ proxyPort, providerName, provider }) => ({
        server: {
          host: "127.0.0.1",
          port: proxyPort,
          clientToken: "PROXY_MANAGED",
        },
        current: providerName,
        providers: {
          [providerName]: provider,
        },
      }),
    },
  });
});

test("model display names are exposed without changing routing", async () => {
  const fixture = [
    {
      id: "chatcmpl_display",
      model: "gpt-best",
      choices: [{ delta: { content: "ok" }, finish_reason: "stop" }],
    },
  ];
  await withProxy(
    fixture,
    async ({ proxyUrl, upstreamRequests }) => {
      const models = await fetch(`${proxyUrl}/v1/models`, {
        headers: { authorization: "Bearer PROXY_MANAGED" },
      }).then((response) => response.json());

      assert.equal(
        models.data.find((item) => item.id === "claude-opus-4-8")?.display_name,
        "Best Model via Preset",
      );
      assert.equal(
        models.data.find((item) => item.id === "gpt-best")?.display_name,
        "Native Best Model",
      );
      assert.ok(
        models.data.some((item) => item.display_name === "gpt-default"),
      );

      await postAnthropicStream(proxyUrl, {
        model: "claude-opus-4-8",
        max_tokens: 16,
        stream: true,
        messages: [{ role: "user", content: "ping" }],
      });
      assert.equal(upstreamRequests.at(-1).model, "gpt-best");
    },
    {
      models: {
        default: "gpt-default",
        opus: "gpt-best",
        allowed: ["gpt-best"],
        exposeAliases: true,
        displayNames: {
          "claude-opus-4-8": "Best Model via Preset",
          "gpt-best": "Native Best Model",
        },
      },
    },
  );
});

test("model list shows mapped upstream names for Claude aliases", async () => {
  const fixture = [
    {
      id: "chatcmpl_real_model_display",
      model: "gpt-5.5",
      choices: [{ delta: { content: "ok" }, finish_reason: "stop" }],
    },
  ];
  await withProxy(
    fixture,
    async ({ proxyUrl, upstreamRequests }) => {
      const models = await fetch(`${proxyUrl}/v1/models`, {
        headers: { authorization: "Bearer PROXY_MANAGED" },
      }).then((response) => response.json());
      const onlyModel = models.data[0];

      assert.equal(models.first_id, "claude-opus-4-8");
      assert.deepEqual(
        models.data.map((item) => item.id),
        ["claude-opus-4-8"],
      );
      assert.equal(onlyModel?.display_name, "gpt-5.5");
      assert.equal(onlyModel?.name, "gpt-5.5");
      assert.equal(onlyModel?.label, "gpt-5.5");

      await postAnthropicStream(proxyUrl, {
        model: "claude-opus-4-8",
        max_tokens: 16,
        stream: true,
        messages: [{ role: "user", content: "ping" }],
      });
      assert.equal(upstreamRequests.at(-1).model, "gpt-5.5");
    },
    {
      models: {
        default: "gpt-5.5",
        haiku: "gpt-5.5",
        sonnet: "gpt-5.5",
        opus: "gpt-5.5",
        fable: "gpt-5.5",
      },
    },
  );
});

test("model directory exposes one Claude-compatible id per real upstream model", async () => {
  const fixture = [
    {
      id: "chatcmpl_multi_model_directory",
      model: "qwen-max",
      choices: [{ delta: { content: "ok" }, finish_reason: "stop" }],
    },
  ];
  await withProxy(
    fixture,
    async ({ proxyUrl, upstreamRequests }) => {
      const models = await fetch(`${proxyUrl}/v1/models`, {
        headers: { authorization: "Bearer PROXY_MANAGED" },
      }).then((response) => response.json());

      assert.deepEqual(
        models.data.map((item) => item.display_name),
        [
          "deepseek-chat",
          "qwen-max",
          "deepseek-reasoner",
          "qwen-plus",
          "openrouter/auto",
        ],
      );
      assert.ok(models.data.every((item) => item.id.startsWith("claude-")));
      assert.equal(new Set(models.data.map((item) => item.id)).size, 5);

      for (const item of models.data) {
        await postAnthropicStream(proxyUrl, {
          model: item.id,
          max_tokens: 16,
          stream: true,
          messages: [{ role: "user", content: "ping" }],
        });
        assert.equal(upstreamRequests.at(-1).model, item.display_name);
      }
    },
    {
      models: {
        default: "deepseek-chat",
        opus: "qwen-max",
        sonnet: "deepseek-reasoner",
        haiku: "qwen-plus",
        allowed: ["openrouter/auto", "qwen-plus"],
      },
    },
  );
});

test("unknown models are rejected unless fallback is explicit", async () => {
  const fixture = [
    {
      id: "chatcmpl_unknown_model",
      model: "gpt-default",
      choices: [{ delta: { content: "ok" }, finish_reason: "stop" }],
    },
  ];
  await withProxy(
    fixture,
    async ({ proxyUrl }) => {
      const response = await fetch(`${proxyUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer PROXY_MANAGED",
        },
        body: JSON.stringify({
          model: "not-a-configured-model",
          max_tokens: 16,
          stream: true,
          messages: [{ role: "user", content: "ping" }],
        }),
      });
      const body = await response.json();
      assert.equal(response.status, 400);
      assert.equal(body.error.type, "route_unknown");
    },
    {
      models: {
        default: "gpt-default",
      },
    },
  );
});

test("cc-switch modelCatalog display names are preserved", async () => {
  const upstream = await startMockOpenAIResponses({
    id: "resp_catalog_display",
    model: "catalog-model",
    status: "completed",
    output: [
      {
        type: "message",
        content: [{ type: "output_text", text: "catalog ok" }],
      },
    ],
  });

  await withProxyServer({
    apiFormat: "openai_responses",
    upstream,
    fn: async ({ proxyUrl }) => {
      const models = await fetch(`${proxyUrl}/v1/models`, {
        headers: { authorization: "Bearer PROXY_MANAGED" },
      }).then((response) => response.json());
      assert.equal(
        models.data.find((item) => item.display_name === "Catalog Model Label")
          ?.display_name,
        "Catalog Model Label",
      );
      assert.ok(models.data.every((item) => item.id.startsWith("claude-")));
    },
    options: {
      providerName: "catalog-display-provider",
      provider: {
        settingsConfig: {
          auth: { OPENAI_API_KEY: "catalog-token" },
          env: { OPENAI_BASE_URL: upstream.url },
          apiFormat: "openai_responses",
          modelCatalog: {
            models: [
              { model: "catalog-model", displayName: "Catalog Model Label" },
            ],
          },
        },
      },
    },
  });
});

test("cc-switch Gemini env shape supplies base URL, model, and key", async () => {
  const upstream = await startMockGemini({
    responseId: "gemini_env",
    candidates: [
      {
        finishReason: "STOP",
        content: { parts: [{ text: "gemini ok" }] },
      },
    ],
    usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2 },
  });

  await withProxyServer({
    apiFormat: "gemini_native",
    upstream,
    fn: async ({ proxyUrl, upstreamRequests }) => {
      const response = await postAnthropic(proxyUrl, {
        model: "claude-sonnet-4-6",
        max_tokens: 16,
        messages: [{ role: "user", content: "ping" }],
      });

      assert.equal(response.content[0].text, "gemini ok");
      assert.match(
        upstreamRequests[0].url,
        /\/v1beta\/models\/gpt-test:generateContent$/,
      );
      assert.equal(upstreamRequests[0].headers["x-goog-api-key"], "gemini-token");
    },
    options: {
      providerName: "gemini-provider",
      provider: {
        providerType: "gemini_api",
        settingsConfig: {
          env: {
            GOOGLE_GEMINI_BASE_URL: upstream.url,
            GEMINI_MODEL: "gpt-test",
            GEMINI_API_KEY: "gemini-token",
          },
        },
      },
    },
  });
});

test("openai_chat streaming tool_calls are converted to Anthropic tool_use SSE", async () => {
  const fixture = [
    {
      id: "chatcmpl_1",
      model: "gpt-test",
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call_1",
                type: "function",
                function: { name: "get_weather" },
              },
            ],
          },
        },
      ],
    },
    {
      id: "chatcmpl_1",
      model: "gpt-test",
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                function: { arguments: '{"city":"' },
              },
            ],
          },
        },
      ],
    },
    {
      id: "chatcmpl_1",
      model: "gpt-test",
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                function: { arguments: 'Tokyo"}' },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    },
    {
      id: "chatcmpl_1",
      model: "gpt-test",
      choices: [],
      usage: { prompt_tokens: 12, completion_tokens: 5 },
    },
  ];

  await withProxy(fixture, async ({ proxyUrl }) => {
    const body = await postAnthropicStream(proxyUrl, {
      model: "claude-opus-4-8",
      max_tokens: 128,
      stream: true,
      tools: [
        {
          name: "get_weather",
          description: "Get weather",
          input_schema: {
            type: "object",
            properties: { city: { type: "string" } },
            required: ["city"],
          },
        },
      ],
      tool_choice: { type: "tool", name: "get_weather" },
      messages: [{ role: "user", content: "weather in Tokyo" }],
    });

    assert.match(body, /event: message_start/);
    assert.match(body, /"type":"tool_use"/);
    assert.match(body, /"id":"call_1"/);
    assert.match(body, /"name":"get_weather"/);
    assert.match(body, /"type":"input_json_delta"/);
    assert.match(body, /"partial_json":"\{\\"city\\":\\"Tokyo\\"\}"/);
    assert.match(body, /"stop_reason":"tool_use"/);
    assert.match(body, /"input_tokens":12/);
    assert.match(body, /"output_tokens":5/);
    assert.match(body, /event: message_stop/);
  });
});

test("openai_chat streaming text stays lazy and does not emit empty text blocks for pure tools", async () => {
  const fixture = [
    {
      id: "chatcmpl_2",
      model: "gpt-test",
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call_2",
                type: "function",
                function: { name: "lookup", arguments: '{"q":"science"}' },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    },
  ];

  await withProxy(fixture, async ({ proxyUrl }) => {
    const body = await postAnthropicStream(proxyUrl, {
      model: "claude-opus-4-8",
      max_tokens: 128,
      stream: true,
      tools: [
        {
          name: "lookup",
          input_schema: {
            type: "object",
            properties: { q: { type: "string" } },
          },
        },
      ],
      messages: [{ role: "user", content: "lookup science" }],
    });

    assert.doesNotMatch(body, /"content_block":\{"type":"text","text":""\}/);
    assert.match(body, /"type":"tool_use"/);
    assert.match(body, /"name":"lookup"/);
  });
});

test("openai_chat preserves Anthropic tool_use and tool_result history", async () => {
  const fixture = [
    {
      id: "chatcmpl_3",
      model: "gpt-test",
      choices: [{ delta: { content: "done" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 40, completion_tokens: 2 },
    },
  ];

  await withProxy(fixture, async ({ proxyUrl, upstreamRequests }) => {
    await postAnthropicStream(proxyUrl, {
      model: "claude-opus-4-8",
      max_tokens: 128,
      stream: true,
      tools: [
        {
          name: "get_weather",
          input_schema: {
            type: "object",
            properties: { city: { type: "string" } },
            required: ["city"],
          },
        },
      ],
      messages: [
        { role: "user", content: "weather in Tokyo" },
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_weather",
              name: "get_weather",
              input: { city: "Tokyo" },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_weather",
              content: [{ type: "text", text: "sunny" }],
            },
            { type: "text", text: "Now summarize." },
          ],
        },
      ],
    });

    assert.equal(upstreamRequests.length, 1);
    assert.deepEqual(upstreamRequests[0].messages, [
      { role: "user", content: "weather in Tokyo" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "toolu_weather",
            type: "function",
            function: {
              name: "get_weather",
              arguments: '{"city":"Tokyo"}',
            },
          },
        ],
      },
      { role: "tool", tool_call_id: "toolu_weather", content: "sunny" },
      { role: "user", content: "Now summarize." },
    ]);
  });
});

test("openai_responses converts Anthropic messages to Responses API", async () => {
  const upstream = await startMockOpenAIResponses({
    id: "resp_1",
    model: "gpt-test",
    status: "completed",
    output: [
      {
        type: "message",
        content: [{ type: "output_text", text: "通了" }],
      },
    ],
    usage: { input_tokens: 10, output_tokens: 2 },
  });

  await withProxyServer({
    apiFormat: "openai_responses",
    upstream,
    fn: async ({ proxyUrl, upstreamRequests }) => {
      const response = await postAnthropic(proxyUrl, {
        model: "claude-sonnet-4-6",
        max_tokens: 128,
        system: "Be brief.",
        messages: [{ role: "user", content: "ping" }],
      });

      assert.equal(response.content[0].text, "通了");
      assert.equal(response.usage.input_tokens, 10);
      assert.equal(response.usage.output_tokens, 2);
      assert.equal(upstreamRequests[0].model, "gpt-test");
      assert.equal(upstreamRequests[0].instructions, "Be brief.");
      assert.equal(upstreamRequests[0].input[0].role, "user");
      assert.deepEqual(upstreamRequests[0].input[0].content, [
        { type: "input_text", text: "ping" },
      ]);
    },
  });
});

test("gemini_native converts Anthropic messages to Gemini generateContent", async () => {
  const upstream = await startMockGemini({
    responseId: "gemini_1",
    candidates: [
      {
        finishReason: "STOP",
        content: { parts: [{ text: "通了" }] },
      },
    ],
    usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 2 },
  });

  await withProxyServer({
    apiFormat: "gemini_native",
    upstream,
    fn: async ({ proxyUrl, upstreamRequests }) => {
      const response = await postAnthropic(proxyUrl, {
        model: "claude-haiku-4-5",
        max_tokens: 128,
        system: "只用中文。",
        messages: [{ role: "user", content: "ping" }],
      });

      assert.equal(response.content[0].text, "通了");
      assert.equal(response.usage.input_tokens, 7);
      assert.equal(response.usage.output_tokens, 2);
      assert.match(
        upstreamRequests[0].url,
        /\/v1beta\/models\/gpt-test:generateContent$/,
      );
      assert.equal(
        upstreamRequests[0].body.systemInstruction.parts[0].text,
        "只用中文。",
      );
      assert.deepEqual(upstreamRequests[0].body.contents[0], {
        role: "user",
        parts: [{ text: "ping" }],
      });
    },
  });
});

async function withProxy(openAIChunks, fn, options = {}) {
  const upstream = await startMockOpenAI(openAIChunks);
  await withProxyServer({ apiFormat: "openai_chat", upstream, fn, options });
}

async function withProxyServer({ apiFormat, upstream, fn, options = {} }) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-switch-test-"));
  const proxyPort = await getFreePort();
  const configPath = path.join(tempDir, "config.json");
  const providerName = options.providerName || "mock-openai";
  const provider = options.provider || {
    apiFormat,
    baseUrl: upstream.url,
    authHeader: "none",
    models: {
      default: "gpt-test",
      haiku: "gpt-test",
      sonnet: "gpt-test",
      opus: "gpt-test",
      ...(options.models || {}),
    },
  };
  const config =
    typeof options.config === "function"
      ? options.config({ proxyPort, providerName, provider })
      : options.config || {
          server: {
            host: "127.0.0.1",
            port: proxyPort,
            clientToken: "PROXY_MANAGED",
          },
          activeProvider: providerName,
          providers: {
            [providerName]: provider,
          },
        };
  fs.writeFileSync(
    configPath,
    `${JSON.stringify(config, null, 2)}\n`,
  );

  const child = spawn(
    process.execPath,
    [
      CLI,
      "serve",
      "--config",
      configPath,
      "--port",
      String(proxyPort),
      ...(options.adminToken ? ["--admin-token", options.adminToken] : []),
    ],
    {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  try {
    await waitForOutput(child, /listening on/);
    await fn({
      proxyUrl: `http://127.0.0.1:${proxyPort}`,
      upstreamRequests: upstream.requests,
    });
  } finally {
    await stopChild(child);
    await new Promise((resolve) => upstream.server.close(resolve));
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function startMockOpenAI(chunks, options = {}) {
  const routePath = options.path || "/v1/chat/completions";
  const requests = [];
  const server = http.createServer((req, res) => {
    if (req.method !== "POST" || req.url !== routePath) {
      res.writeHead(404);
      res.end();
      return;
    }
    const bodyChunks = [];
    req.on("data", (chunk) => bodyChunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(bodyChunks).toString("utf8");
      try {
        requests.push({
          url: req.url,
          headers: req.headers,
          ...JSON.parse(raw),
        });
      } catch {
        requests.push({ url: req.url, headers: req.headers, raw });
      }
    });
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
    });
    for (const chunk of chunks) {
      res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    }
    res.write("data: [DONE]\n\n");
    res.end();
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  return { server, url: `http://127.0.0.1:${port}`, requests };
}

async function startMockOpenAIResponses(payload) {
  const requests = [];
  const server = http.createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/v1/responses") {
      res.writeHead(404);
      res.end();
      return;
    }
    collectJsonRequest(req, requests, () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  return { server, url: `http://127.0.0.1:${port}`, requests };
}

async function startMockGemini(payload) {
  const requests = [];
  const server = http.createServer((req, res) => {
    if (
      req.method !== "POST" ||
      !req.url.startsWith("/v1beta/models/gpt-test:generateContent")
    ) {
      res.writeHead(404);
      res.end();
      return;
    }
    collectJsonRequest(
      req,
      requests,
      () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      },
      req.url,
    );
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  return { server, url: `http://127.0.0.1:${port}/v1beta`, requests };
}

function collectJsonRequest(req, requests, onEnd, requestUrl = req.url) {
  const bodyChunks = [];
  req.on("data", (chunk) => bodyChunks.push(chunk));
  req.on("end", () => {
    const raw = Buffer.concat(bodyChunks).toString("utf8");
      try {
        const parsed = JSON.parse(raw);
        requests.push({
          url: requestUrl,
          headers: req.headers,
          body: parsed,
          ...parsed,
        });
    } catch {
      requests.push({ url: requestUrl, raw });
    }
    onEnd();
  });
}

async function postAnthropicStream(proxyUrl, body) {
  const response = await fetch(`${proxyUrl}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer PROXY_MANAGED",
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  assert.equal(response.status, 200, text);
  return text;
}

async function postAnthropic(proxyUrl, body) {
  const response = await fetch(`${proxyUrl}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer PROXY_MANAGED",
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  assert.equal(response.status, 200, text);
  return JSON.parse(text);
}

async function waitForOutput(child, pattern) {
  let output = "";
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`timed out waiting for ${pattern}; output:\n${output}`));
    }, 5000);
    const onData = (chunk) => {
      output += chunk.toString("utf8");
      if (pattern.test(output)) {
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      reject(
        new Error(
          `proxy exited early code=${code} signal=${signal}; output:\n${output}`,
        ),
      );
    });
  });
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  child.kill("SIGTERM");
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
      resolve();
    }, 1500);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function getFreePort() {
  const server = http.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}
