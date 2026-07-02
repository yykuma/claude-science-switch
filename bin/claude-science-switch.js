#!/usr/bin/env node
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const VERSION = "0.1.0";
const DEFAULT_CONFIG = "examples/cliproxy-gpt55.json";
const DEFAULT_ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_CLIENT_TOKEN = "PROXY_MANAGED";
const DEFAULT_TIMEOUT_MS = 120000;
const DEFAULT_MAX_BODY_BYTES = 20 * 1024 * 1024;
const DEFAULT_HOLD_MS = 2 * 60 * 60 * 1000;
const CLAUDE_ALIASES = [
  "claude-haiku-4-5",
  "claude-haiku-4-5-20251001",
  "claude-sonnet-4-6",
  "claude-sonnet-4-6-20251101",
  "claude-opus-4-8",
  "claude-opus-4-8-20251201",
  "claude-fable-5",
  "claude-fable-5-20260609",
];
const SCIENCE_ALIAS_PRIORITY = [
  "claude-opus-4-8",
  "claude-sonnet-4-6",
  "claude-haiku-4-5",
  "claude-fable-5",
  "claude-opus-4-8-20251201",
  "claude-sonnet-4-6-20251101",
  "claude-haiku-4-5-20251001",
  "claude-fable-5-20260609",
];
const SCIENCE_EXTRA_ALIAS_PRIORITY = [
  "claude-opus-4-8-20251201",
  "claude-sonnet-4-6-20251101",
  "claude-haiku-4-5-20251001",
  "claude-fable-5-20260609",
  ...SCIENCE_ALIAS_PRIORITY,
];
const SCIENCE_ROLE_ALIAS = {
  default: "claude-opus-4-8",
  opus: "claude-opus-4-8",
  sonnet: "claude-sonnet-4-6",
  haiku: "claude-haiku-4-5",
  fable: "claude-fable-5",
};

main().catch((error) => {
  console.error(`error: ${error.message}`);
  process.exitCode = 1;
});

async function main() {
  const argv = process.argv.slice(2);
  const command = argv[0] && !argv[0].startsWith("-") ? argv.shift() : "help";
  const flags = parseFlags(argv);

  if (flags.help || command === "help") {
    printHelp();
    return;
  }
  if (flags.version || command === "version") {
    console.log(VERSION);
    return;
  }

  if (command === "serve") {
    const loaded = loadRuntime(flags);
    await serve(loaded, flags);
    return;
  }

  if (command === "doctor") {
    const loaded = loadRuntime(flags);
    await doctor(loaded, flags);
    return;
  }

  if (command === "providers" || command === "provider-list") {
    const bundle = loadConfigBundle(flags);
    printProviders(bundle, flags);
    return;
  }

  if (command === "use" || command === "switch") {
    useProvider(flags);
    return;
  }

  if (
    command === "print-env" ||
    command === "print-science-env" ||
    command === "science-env"
  ) {
    const loaded = loadRuntime(flags, { resolveApiKey: false });
    printScienceEnv(loaded, flags);
    return;
  }

  if (command === "science-smoke" || command === "smoke") {
    if (!flags.port) {
      flags.port = await findAvailablePort(String(flags.host || "127.0.0.1"));
    }
    const loaded = loadRuntime(flags);
    await scienceSmoke(loaded, flags);
    return;
  }

  throw new Error(`unknown command "${command}". Try --help.`);
}

function printHelp() {
  console.log(`claude-science-switch ${VERSION}

Usage:
  claude-science-switch serve --config examples/cliproxy-gpt55.json
  claude-science-switch doctor --config examples/cliproxy-gpt55.json
  claude-science-switch providers --config examples/multi-provider.json
  claude-science-switch use cliproxy-gpt55 --config examples/multi-provider.json
  claude-science-switch print-env --config examples/cliproxy-gpt55.json
  claude-science-switch science-smoke --config examples/cliproxy-gpt55.json

Commands:
  serve              Start a local proxy with the switch dashboard at /.
  doctor             Check the configured upstream without printing secrets.
  providers          List providers in the config.
  use NAME           Set config.activeProvider in this tool's JSON config.
  print-env          Print an isolated Claude Science launch recipe.
  science-smoke      Start proxy plus isolated Claude Science briefly, then stop both.

Options:
  --config FILE      JSON config file. Defaults to $CLAUDE_SCIENCE_SWITCH_CONFIG or ${DEFAULT_CONFIG}.
  --host HOST        Override listen host. Defaults to config/server host.
  --port PORT        Override listen port. Defaults to config/server port.
  --provider NAME    Override active provider from config.
  --model MODEL      Model used by doctor. Defaults to claude-opus-4-8.
  --client-token TOK Token expected from Claude Science. Defaults to PROXY_MANAGED.
  --admin-token TOK  Token for /admin/* APIs. Defaults to a random in-memory token.
  --timeout-ms N     Upstream request timeout. Defaults to ${DEFAULT_TIMEOUT_MS}.
  --max-body-bytes N Maximum JSON request body size. Defaults to ${DEFAULT_MAX_BODY_BYTES}.
  --science-bin BIN  Claude Science CLI path. Defaults to /Users/cai/.claude-science/bin/claude-science.
  --smoke-ms N       How long science-smoke waits. Defaults to 15000.
  --hold             Keep science-smoke's proxy and Claude Science running.
  --hold-ms N        Max --hold duration. Defaults to ${DEFAULT_HOLD_MS}; use 0 for no TTL.
  --keep-temp        Keep science-smoke's isolated temp profile for inspection.
  --preload-trace    Trace preload fetch/fs path access during science-smoke.
  --temp-oauth-token Write a temp encrypted OAuth token for science-smoke only.
  --probe-message    During science-smoke, create a temp frame and require /v1/messages.
  --allow-smoke-external
                     Allow isolated smoke to reach Claude public OAuth/analytics/MCP services.
  --verbose          Print request routing details, never auth secrets.
`);
}

function parseFlags(args) {
  const flags = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) {
      (flags._ ??= []).push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    let key;
    let value;
    if (eq >= 0) {
      key = arg.slice(2, eq);
      value = arg.slice(eq + 1);
    } else {
      key = arg.slice(2);
      const next = args[index + 1];
      if (next && !next.startsWith("--")) {
        value = next;
        index += 1;
      } else {
        value = true;
      }
    }
    flags[toCamel(key)] = value;
  }
  return flags;
}

function toCamel(key) {
  return key.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
}

function loadRuntime(flags, options = {}) {
  const bundle = loadConfigBundle(flags);
  const { configPath, config } = bundle;
  const providerNames = Object.keys(config.providers || {});
  const providerName = String(
    flags.provider || config.activeProvider || providerNames[0] || "",
  );
  const rawProvider = config.providers?.[providerName];
  const provider = normalizeProviderConfig(rawProvider, providerName);
  if (!providerName || !provider) {
    throw new Error(
      `provider "${providerName || "(missing)"}" not found in ${configPath}`,
    );
  }

  const server = {
    host: String(flags.host || config.server?.host || "127.0.0.1"),
    port: Number(flags.port || config.server?.port || 17777),
    clientToken: String(
      flags.clientToken ||
        process.env.CLAUDE_SCIENCE_SWITCH_CLIENT_TOKEN ||
        config.server?.clientToken ||
        DEFAULT_CLIENT_TOKEN,
    ),
    timeoutMs: Number(
      flags.timeoutMs || config.server?.timeoutMs || DEFAULT_TIMEOUT_MS,
    ),
    maxBodyBytes: Number(
      flags.maxBodyBytes ||
        config.server?.maxBodyBytes ||
        DEFAULT_MAX_BODY_BYTES,
    ),
  };
  if (
    !Number.isInteger(server.port) ||
    server.port <= 0 ||
    server.port > 65535
  ) {
    throw new Error(`invalid port: ${server.port}`);
  }
  if (!Number.isInteger(server.timeoutMs) || server.timeoutMs < 1000) {
    throw new Error(`invalid timeoutMs: ${server.timeoutMs}`);
  }
  if (!Number.isInteger(server.maxBodyBytes) || server.maxBodyBytes < 1024) {
    throw new Error(`invalid maxBodyBytes: ${server.maxBodyBytes}`);
  }
  if (!isLoopbackHost(server.host)) {
    throw new Error(`refusing to listen on non-loopback host "${server.host}"`);
  }

  rejectInlineSecrets(rawProvider);
  rejectManagedAccountProvider(provider);
  rejectOfficialAnthropicProvider(provider);
  const apiKeyInfo =
    options.resolveApiKey === false
      ? { value: "", source: "not-read" }
      : resolveApiKey(provider);
  const normalizedProvider = {
    ...provider,
    name: providerName,
    apiFormat: provider.apiFormat || "anthropic",
    authHeader: provider.authHeader || "authorization-bearer",
    apiKey: apiKeyInfo.value,
    apiKeySource: apiKeyInfo.source,
    models: provider.models || {},
    timeoutMs: Number(provider.timeoutMs || server.timeoutMs),
  };

  return { configPath, config, provider: normalizedProvider, server };
}

function loadConfigBundle(flags) {
  const configPath = path.resolve(
    process.cwd(),
    String(
      flags.config ||
        process.env.CLAUDE_SCIENCE_SWITCH_CONFIG ||
        DEFAULT_CONFIG,
    ),
  );
  const config = normalizeConfigBundle(readJson(configPath), configPath);
  if (
    !config ||
    typeof config !== "object" ||
    !config.providers ||
    typeof config.providers !== "object"
  ) {
    throw new Error(`config ${configPath} must contain a providers object`);
  }
  return { configPath, config };
}

function normalizeConfigBundle(config, configPath) {
  if (!config || typeof config !== "object") {
    return config;
  }
  if (config.providers && typeof config.providers === "object") {
    const activeProvider = nonEmptyString(config.activeProvider, config.current);
    return activeProvider ? { ...config, activeProvider } : config;
  }
  if (isCcSwitchProviderShape(config)) {
    const name = String(
      config.name || config.id || config.title || "cc-switch-provider",
    );
    return {
      server: config.server || {},
      activeProvider: name,
      providers: {
        [name]: config,
      },
    };
  }
  return config;
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`failed to read ${filePath}: ${error.message}`);
  }
}

function resolveApiKey(provider) {
  if (provider.apiKeyEnv) {
    const value = process.env[provider.apiKeyEnv];
    if (!value) {
      throw new Error(`env var ${provider.apiKeyEnv} is not set`);
    }
    return { value, source: `env:${provider.apiKeyEnv}` };
  }
  if (provider.apiKeyFromCliproxyConfig) {
    const value = readFirstCliproxyKey(provider.apiKeyFromCliproxyConfig);
    return {
      value,
      source: `cliproxy-config:${provider.apiKeyFromCliproxyConfig}`,
    };
  }
  if (provider.apiKeyLiteral) {
    return {
      value: provider.apiKeyLiteral,
      source: provider.apiKeyLiteralSource || "cc-switch-provider",
    };
  }
  if (provider.authHeader === "none") {
    return { value: "", source: "none" };
  }
  throw new Error(
    "provider must set apiKeyEnv, apiKeyFromCliproxyConfig, or authHeader:none",
  );
}

function describeApiKeySource(provider) {
  if (provider.apiKeyEnv) {
    return `env:${provider.apiKeyEnv}`;
  }
  if (provider.apiKeyFromCliproxyConfig) {
    return `cliproxy-config:${provider.apiKeyFromCliproxyConfig}`;
  }
  if (provider.apiKeyLiteral) {
    return provider.apiKeyLiteralSource || "cc-switch-provider";
  }
  if (provider.authHeader === "none") {
    return "none";
  }
  return "missing";
}

function rejectInlineSecrets(provider) {
  for (const key of ["apiKey", "token", "secret", "password"]) {
    if (Object.hasOwn(provider, key)) {
      throw new Error(
        `refusing inline secret-like config field "${key}"; use apiKeyEnv instead`,
      );
    }
  }
}

function rejectOfficialAnthropicProvider(provider) {
  if (provider.allowOfficialAnthropic) {
    return;
  }
  const baseUrl = String(provider.baseUrl || "");
  let hostname = "";
  try {
    hostname = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    throw new Error(`invalid provider baseUrl: ${baseUrl}`);
  }
  if (hostname === "anthropic.com" || hostname.endsWith(".anthropic.com")) {
    throw new Error(
      "refusing official Anthropic upstream by default; use a loopback or non-Claude provider",
    );
  }
}

function rejectManagedAccountProvider(provider) {
  if (provider.allowManagedAccountProvider) {
    return;
  }
  const providerType = String(provider.providerType || "").toLowerCase();
  if (["codex_oauth", "github_copilot", "gemini_cli"].includes(providerType)) {
    throw new Error(
      `refusing managed-account providerType "${providerType}" in Claude Science Switch proxy`,
    );
  }
}

function normalizeProviderConfig(provider, providerName = "") {
  if (!provider || typeof provider !== "object") {
    return provider;
  }
  const settings =
    provider.settingsConfig && typeof provider.settingsConfig === "object"
      ? provider.settingsConfig
      : {};
  const env =
    settings.env && typeof settings.env === "object" ? settings.env : {};
  const codex = normalizeCcSwitchCodexConfig(provider, settings);
  const meta =
    provider.meta && typeof provider.meta === "object" ? provider.meta : {};
  const providerType = nonEmptyString(
    provider.providerType,
    meta.providerType,
    settings.providerType,
    settings.provider_type,
  );
  const apiFormat =
    nonEmptyString(
      provider.apiFormat,
      meta.apiFormat,
      settings.apiFormat,
      settings.api_format,
      codex.apiFormat,
      inferCcSwitchApiFormat(providerType, env),
    ) || "anthropic";
  const baseUrl = nonEmptyString(
    provider.baseUrl,
    codex.baseUrl,
    env.ANTHROPIC_BASE_URL,
    env.OPENAI_BASE_URL,
    env.GOOGLE_GEMINI_BASE_URL,
    settings.base_url,
    settings.baseURL,
    settings.apiEndpoint,
    settings.endpoint,
    settings.url,
  );
  const isFullUrl = booleanish(
    provider.isFullUrl,
    meta.isFullUrl,
    settings.isFullUrl,
    settings.is_full_url,
  );
  const auth = normalizeCcSwitchAuth(provider, settings, env);
  const models = {
    ...modelsFromCcSwitchCatalog(settings.modelCatalog || provider.modelCatalog),
    ...modelsFromCcSwitchEnv(env, settings),
    ...codex.models,
    ...(provider.models || {}),
  };
  const headerOverrides = normalizeCcSwitchHeaderOverrides(provider, settings, meta);

  return {
    ...provider,
    ...auth,
    name: providerName || provider.name || provider.id || provider.title || "",
    providerType,
    apiFormat,
    baseUrl,
    isFullUrl,
    models,
    customUserAgent: nonEmptyString(
      provider.customUserAgent,
      meta.customUserAgent,
      settings.customUserAgent,
      settings.custom_user_agent,
    ),
    headerOverrides,
  };
}

function isCcSwitchProviderShape(value) {
  return Boolean(
    value &&
      typeof value === "object" &&
      value.settingsConfig &&
      typeof value.settingsConfig === "object",
  );
}

function inferCcSwitchApiFormat(providerType, env) {
  const type = String(providerType || "").toLowerCase();
  if (type.includes("gemini") || nonEmptyString(env.GEMINI_API_KEY)) {
    return "gemini_native";
  }
  if (
    type.includes("openrouter") ||
    nonEmptyString(env.OPENROUTER_API_KEY, env.OPENAI_API_KEY)
  ) {
    return "openai_chat";
  }
  return "";
}

function normalizeCcSwitchCodexConfig(provider, settings) {
  const configText = nonEmptyString(
    settings.config,
    settings.toml,
    settings.codexConfig,
    provider.codexConfig,
  );
  if (!configText) {
    return { apiFormat: "", baseUrl: "", models: {} };
  }

  const parsed = parseSimpleToml(configText);
  const providerId = nonEmptyString(
    parsed.root.model_provider,
    parsed.root.modelProvider,
    parsed.root.provider,
  );
  const modelProvider = findCodexModelProvider(parsed.sections, providerId);
  const wireApi = nonEmptyString(
    modelProvider.wire_api,
    modelProvider.wireApi,
    modelProvider.protocol,
  ).toLowerCase();
  const apiFormat = wireApi.includes("response")
    ? "openai_responses"
    : wireApi.includes("chat")
      ? "openai_chat"
      : "";
  const defaultModel = nonEmptyString(
    parsed.root.model,
    modelProvider.model,
    settings.model,
    settings.defaultModel,
  );
  return {
    apiFormat,
    baseUrl: nonEmptyString(
      modelProvider.base_url,
      modelProvider.baseURL,
      modelProvider.baseUrl,
    ),
    models: removeEmptyEntries({
      default: defaultModel,
    }),
  };
}

function findCodexModelProvider(sections, providerId) {
  if (providerId) {
    const direct = sections[`model_providers.${providerId}`];
    if (direct) {
      return direct;
    }
  }
  const candidates = Object.entries(sections).filter(([name]) =>
    name.startsWith("model_providers."),
  );
  return candidates[0]?.[1] || {};
}

function parseSimpleToml(text) {
  const root = {};
  const sections = {};
  let current = root;
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = stripTomlComment(rawLine).trim();
    if (!line) {
      continue;
    }
    const section = line.match(/^\[([^\]]+)\]$/);
    if (section) {
      current = sections[section[1].trim()] ||= {};
      continue;
    }
    const assignment = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/);
    if (!assignment) {
      continue;
    }
    current[assignment[1].trim()] = parseSimpleTomlValue(assignment[2].trim());
  }
  return { root, sections };
}

function stripTomlComment(line) {
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"') {
      quoted = !quoted;
      continue;
    }
    if (char === "#" && !quoted) {
      return line.slice(0, index);
    }
  }
  return line;
}

function parseSimpleTomlValue(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  return value;
}

function normalizeCcSwitchAuth(provider, settings, env) {
  if (
    provider.apiKeyEnv ||
    provider.apiKeyFromCliproxyConfig ||
    provider.authHeader === "none"
  ) {
    return {};
  }
  const apiKeyField = nonEmptyString(
    provider.apiKeyField,
    provider.meta?.apiKeyField,
    settings.apiKeyField,
  );
  const auth =
    settings.auth && typeof settings.auth === "object" ? settings.auth : {};
  const keyedSources = [
    ["ANTHROPIC_AUTH_TOKEN", "authorization-bearer"],
    ["ANTHROPIC_API_KEY", "x-api-key"],
    ["OPENROUTER_API_KEY", "authorization-bearer"],
    ["OPENAI_API_KEY", "authorization-bearer"],
    ["GEMINI_API_KEY", "x-goog-api-key"],
    ["GOOGLE_API_KEY", "x-goog-api-key"],
  ];
  if (apiKeyField) {
    const item = keyedSources.find(([key]) => key === apiKeyField);
    const value = item && nonEmptyString(env[item[0]], auth[item[0]]);
    if (item && value) {
      return {
        authHeader: item[1],
        apiKeyLiteral: value,
        apiKeyLiteralSource: apiKeySourceLabel(item[0], env, auth),
      };
    }
  }
  for (const [key, authHeader] of keyedSources) {
    const value = nonEmptyString(env[key], auth[key]);
    if (value) {
      return {
        authHeader,
        apiKeyLiteral: value,
        apiKeyLiteralSource: apiKeySourceLabel(key, env, auth),
      };
    }
  }
  const directKey = nonEmptyString(settings.apiKey, settings.api_key);
  if (directKey) {
    return {
      authHeader: "authorization-bearer",
      apiKeyLiteral: directKey,
      apiKeyLiteralSource: "cc-switch-field:apiKey",
    };
  }
  return {};
}

function apiKeySourceLabel(key, env, auth) {
  return nonEmptyString(env[key]) ? `cc-switch-env:${key}` : `cc-switch-auth:${key}`;
}

function modelsFromCcSwitchEnv(env, settings) {
  const defaultModel = nonEmptyString(
    env.ANTHROPIC_MODEL,
    env.GEMINI_MODEL,
    settings.model,
    settings.defaultModel,
    settings.default_model,
  );
  return removeEmptyEntries({
    default: defaultModel,
    haiku: nonEmptyString(env.ANTHROPIC_DEFAULT_HAIKU_MODEL),
    sonnet: nonEmptyString(env.ANTHROPIC_DEFAULT_SONNET_MODEL),
    opus: nonEmptyString(env.ANTHROPIC_DEFAULT_OPUS_MODEL),
    fable: nonEmptyString(env.ANTHROPIC_DEFAULT_FABLE_MODEL),
  });
}

function modelsFromCcSwitchCatalog(catalog) {
  if (!catalog || typeof catalog !== "object" || !Array.isArray(catalog.models)) {
    return {};
  }
  const allowed = [];
  const displayNames = {};
  for (const item of catalog.models) {
    const model = nonEmptyString(item?.model, item?.id, item?.name);
    if (model) {
      allowed.push(model);
      const displayName = nonEmptyString(
        item?.display_name,
        item?.displayName,
        item?.label,
        item?.title,
      );
      if (displayName) {
        displayNames[model] = displayName;
      }
    }
  }
  return removeEmptyEntries({
    allowed: allowed.length ? allowed : undefined,
    displayNames: Object.keys(displayNames).length ? displayNames : undefined,
  });
}

function normalizeCcSwitchHeaderOverrides(provider, settings, meta) {
  const headers = {
    ...(plainObject(settings.headers) || {}),
    ...(plainObject(meta.headers) || {}),
    ...(plainObject(provider.headers) || {}),
    ...(plainObject(meta.localProxyRequestOverrides?.headers) || {}),
    ...(plainObject(settings.localProxyRequestOverrides?.headers) || {}),
  };
  return removeEmptyEntries(headers);
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : null;
}

function removeEmptyEntries(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => Boolean(item)),
  );
}

function nonEmptyString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
}

function booleanish(...values) {
  for (const value of values) {
    if (typeof value === "boolean") {
      return value;
    }
    if (typeof value === "string") {
      const lower = value.trim().toLowerCase();
      if (["true", "1", "yes"].includes(lower)) {
        return true;
      }
      if (["false", "0", "no"].includes(lower)) {
        return false;
      }
    }
  }
  return false;
}

function readFirstCliproxyKey(filePath) {
  let text;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    throw new Error(
      `failed to read cliproxyapi config ${filePath}: ${error.message}`,
    );
  }

  const lines = text.split(/\r?\n/);
  let inApiKeys = false;
  for (const line of lines) {
    if (/^api-keys\s*:/.test(line)) {
      inApiKeys = true;
      continue;
    }
    if (inApiKeys && /^[^\s-]/.test(line)) {
      break;
    }
    if (inApiKeys) {
      const match = line.match(/^\s*-\s*["']?([^"'\s#]+)["']?/);
      if (match?.[1]) {
        return match[1];
      }
    }
  }
  throw new Error(`no api-keys entry found in ${filePath}`);
}

function isLoopbackHost(host) {
  return (
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "[::1]" ||
    host === "localhost"
  );
}

async function findAvailablePort(host) {
  const listenHost =
    host === "localhost" || host === "[::1]"
      ? host.replace(/^\[|\]$/g, "")
      : host;
  if (!isLoopbackHost(host)) {
    throw new Error(
      `refusing to bind science-smoke on non-loopback host "${host}"`,
    );
  }
  return await new Promise((resolve, reject) => {
    const probe = http.createServer();
    probe.once("error", reject);
    probe.listen(0, listenHost, () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close((error) => {
        if (error) {
          reject(error);
        } else {
          resolve(port);
        }
      });
    });
  });
}

function requireAdmin(req, res, adminToken) {
  if (req.headers["x-cs-switch-admin"] === adminToken) {
    return true;
  }
  sendJson(res, 401, {
    error: {
      type: "auth_error",
      message: "missing or invalid admin token",
    },
  });
  return false;
}

function requireClientAuth(req, res, clientToken) {
  const authorization = String(req.headers.authorization || "");
  const bearer = authorization.match(/^Bearer\s+(.+)$/i)?.[1] || "";
  const apiKey = String(
    req.headers["x-api-key"] || req.headers["anthropic-api-key"] || "",
  );
  if (clientToken && (bearer === clientToken || apiKey === clientToken)) {
    return true;
  }
  sendJson(res, 401, {
    error: {
      type: "auth_error",
      message: "missing or invalid proxy client token",
    },
  });
  return false;
}

function printProviders(bundle) {
  const { configPath, config } = bundle;
  console.log(`config: ${configPath}`);
  console.log(`activeProvider: ${config.activeProvider || "(missing)"}`);
  for (const [name, rawProvider] of Object.entries(config.providers)) {
    rejectInlineSecrets(rawProvider);
    const provider = normalizeProviderConfig(rawProvider, name);
    const marker = name === config.activeProvider ? "*" : " ";
    console.log(`${marker} ${name}`);
    console.log(`    apiFormat: ${provider.apiFormat || "anthropic"}`);
    console.log(`    baseUrl: ${provider.baseUrl || "(missing)"}`);
    console.log(`    auth: ${describeApiKeySource(provider)}`);
    console.log(`    defaultModel: ${provider.models?.default || "(missing)"}`);
  }
}

function useProvider(flags) {
  const providerName = String(flags._?.[0] || flags.provider || "");
  if (!providerName) {
    throw new Error(
      "usage: claude-science-switch use <provider> --config FILE",
    );
  }
  const bundle = loadConfigBundle(flags);
  setActiveProvider(bundle, providerName);
  console.log(`activeProvider set to ${providerName}`);
  console.log(`config: ${bundle.configPath}`);
}

function setActiveProvider(bundle, providerName) {
  const { configPath, config } = bundle;
  if (!config.providers[providerName]) {
    throw new Error(`provider "${providerName}" not found in ${configPath}`);
  }
  rejectInlineSecrets(config.providers[providerName]);
  config.activeProvider = providerName;
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
}

async function serve(initialRuntime, flags) {
  let runtime = initialRuntime;
  const { server } = runtime;
  const adminToken = resolveAdminToken(flags);
  const startedAt = Date.now();
  const stats = { requests: 0, upstreamErrors: 0, switches: 0, doctorRuns: 0 };
  const requestLog = [];

  const httpServer = http.createServer(async (req, res) => {
    stats.requests += 1;
    setCors(req, res);
    const requestId = crypto.randomUUID();
    const requestStarted = Date.now();
    try {
      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }
      const url = new URL(
        req.url || "/",
        `http://${req.headers.host || "127.0.0.1"}`,
      );
      const baseLog = {
        requestId,
        method: req.method,
        path: url.pathname,
        time: new Date().toISOString(),
      };
      if (
        req.method === "GET" &&
        (url.pathname === "/" || url.pathname === "/admin")
      ) {
        sendHtml(res, dashboardHtml(adminToken));
        return;
      }
      if (req.method === "GET" && url.pathname === "/admin/state") {
        if (!requireAdmin(req, res, adminToken)) return;
        sendJson(
          res,
          200,
          adminStatePayload(runtime, stats, startedAt, requestLog),
        );
        return;
      }
      if (req.method === "GET" && url.pathname === "/admin/logs") {
        if (!requireAdmin(req, res, adminToken)) return;
        sendJson(res, 200, {
          ok: true,
          logs: requestLog.slice(-100).reverse(),
        });
        return;
      }
      if (req.method === "GET" && url.pathname === "/admin/science-env") {
        if (!requireAdmin(req, res, adminToken)) return;
        sendText(res, 200, buildScienceEnv(runtime, flags));
        return;
      }
      if (req.method === "POST" && url.pathname === "/admin/use") {
        if (!requireAdmin(req, res, adminToken)) return;
        const body = await readJsonBody(req, runtime.server.maxBodyBytes);
        const providerName = String(body.provider || "");
        if (!providerName) {
          sendJson(res, 400, { ok: false, error: "provider is required" });
          return;
        }
        const bundle = loadConfigBundle(flags);
        if (body.persist !== false) {
          setActiveProvider(bundle, providerName);
        } else if (!bundle.config.providers[providerName]) {
          throw new Error(
            `provider "${providerName}" not found in ${bundle.configPath}`,
          );
        }
        runtime = loadRuntime({ ...flags, provider: providerName });
        stats.switches += 1;
        appendRequestLog(requestLog, {
          ...baseLog,
          kind: "switch",
          provider: runtime.provider.name,
          apiFormat: runtime.provider.apiFormat,
          status: 200,
          latencyMs: 0,
          detail: body.persist !== false ? "persisted" : "temporary",
        });
        sendJson(
          res,
          200,
          adminStatePayload(runtime, stats, startedAt, requestLog),
        );
        return;
      }
      if (req.method === "POST" && url.pathname === "/admin/reload") {
        if (!requireAdmin(req, res, adminToken)) return;
        runtime = loadRuntime(flags);
        sendJson(
          res,
          200,
          adminStatePayload(runtime, stats, startedAt, requestLog),
        );
        return;
      }
      if (req.method === "POST" && url.pathname === "/admin/doctor") {
        if (!requireAdmin(req, res, adminToken)) return;
        const body = await readJsonBody(req, runtime.server.maxBodyBytes);
        const doctorRuntime = body.provider
          ? loadRuntime({ ...flags, provider: body.provider })
          : runtime;
        const result = await doctorDetails(doctorRuntime, {
          ...flags,
          model: body.model || flags.model,
        });
        stats.doctorRuns += 1;
        appendRequestLog(requestLog, {
          ...baseLog,
          kind: "doctor",
          provider: doctorRuntime.provider.name,
          apiFormat: doctorRuntime.provider.apiFormat,
          model: result.model.requested,
          mappedModel: result.model.mapped,
          status: 200,
          latencyMs: result.latencyMs,
          detail: result.reply,
        });
        sendJson(res, 200, result);
        return;
      }
      if (req.method === "GET" && url.pathname === "/health") {
        sendJson(res, 200, { ok: true });
        return;
      }
      if (req.method === "GET" && url.pathname === "/status") {
        sendJson(res, 200, statusPayload(runtime, stats, startedAt));
        return;
      }
      if (req.method === "GET" && url.pathname === "/ready") {
        const ready = readyPayload(runtime);
        sendJson(res, ready.ok ? 200 : 503, ready);
        return;
      }
      if (req.method === "GET" && isModelsPath(url.pathname)) {
        if (!requireClientAuth(req, res, runtime.server.clientToken)) {
          appendRequestLog(requestLog, {
            ...baseLog,
            kind: "auth",
            provider: runtime.provider.name,
            apiFormat: runtime.provider.apiFormat,
            status: 401,
            latencyMs: Date.now() - requestStarted,
            error: "invalid proxy client token",
          });
          return;
        }
        sendJson(res, 200, localModelsPayload(runtime.provider));
        appendRequestLog(requestLog, {
          ...baseLog,
          kind: "models",
          provider: runtime.provider.name,
          apiFormat: runtime.provider.apiFormat,
          status: res.statusCode,
          latencyMs: Date.now() - requestStarted,
        });
        return;
      }
      if (req.method === "POST" && isCountTokensPath(url.pathname)) {
        if (!requireClientAuth(req, res, runtime.server.clientToken)) {
          appendRequestLog(requestLog, {
            ...baseLog,
            kind: "auth",
            provider: runtime.provider.name,
            apiFormat: runtime.provider.apiFormat,
            status: 401,
            latencyMs: Date.now() - requestStarted,
            error: "invalid proxy client token",
          });
          return;
        }
        const body = await readJsonBody(req, runtime.server.maxBodyBytes);
        sendJson(res, 200, estimateTokenCount(body));
        appendRequestLog(requestLog, {
          ...baseLog,
          kind: "count_tokens",
          provider: runtime.provider.name,
          apiFormat: runtime.provider.apiFormat,
          model: body.model || "",
          status: res.statusCode,
          latencyMs: Date.now() - requestStarted,
        });
        return;
      }
      if (req.method === "POST" && isMessagesPath(url.pathname)) {
        if (!requireClientAuth(req, res, runtime.server.clientToken)) {
          appendRequestLog(requestLog, {
            ...baseLog,
            kind: "auth",
            provider: runtime.provider.name,
            apiFormat: runtime.provider.apiFormat,
            status: 401,
            latencyMs: Date.now() - requestStarted,
            error: "invalid proxy client token",
          });
          return;
        }
        const body = await readJsonBody(req, runtime.server.maxBodyBytes);
        const route = await handleMessages(runtime, flags, req, res, body);
        appendRequestLog(requestLog, {
          ...baseLog,
          kind: "messages",
          provider: runtime.provider.name,
          apiFormat: runtime.provider.apiFormat,
          model: body.model || "",
          mappedModel: route?.mappedModel || "",
          stream: Boolean(body.stream),
          status: res.statusCode,
          latencyMs: Date.now() - requestStarted,
          detail: route?.routeReason || "",
        });
        return;
      }

      sendJson(res, 404, {
        error: {
          type: "not_found_error",
          message: `unsupported route ${req.method} ${url.pathname}`,
        },
      });
    } catch (error) {
      stats.upstreamErrors += 1;
      appendRequestLog(requestLog, {
        requestId,
        method: req.method,
        path: req.url || "",
        time: new Date().toISOString(),
        kind: "error",
        provider: runtime.provider.name,
        apiFormat: runtime.provider.apiFormat,
        status: error.statusCode || 500,
        latencyMs: Date.now() - requestStarted,
        error: redact(error.message, [
          runtime.provider.apiKey,
          runtime.server.clientToken,
          adminToken,
        ]),
      });
      sendJson(res, error.statusCode || 500, {
        error: {
          type: "proxy_error",
          message: redact(error.message, [
            runtime.provider.apiKey,
            runtime.server.clientToken,
            adminToken,
          ]),
        },
      });
    }
  });

  await new Promise((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(server.port, server.host, resolve);
  });

  console.log(
    `claude-science-switch listening on http://${server.host}:${server.port}`,
  );
  console.log(`dashboard: http://${server.host}:${server.port}/`);
  console.log(
    `active provider: ${runtime.provider.name} (${runtime.provider.apiFormat})`,
  );
  console.log(`api key source: ${runtime.provider.apiKeySource}`);
  console.log("safe Science base URL: http://127.0.0.1:" + server.port);
  return httpServer;
}

function resolveAdminToken(flags) {
  const explicit =
    flags.adminToken || process.env.CLAUDE_SCIENCE_SWITCH_ADMIN_TOKEN;
  if (!explicit) {
    return crypto.randomBytes(24).toString("hex");
  }
  const token = String(explicit);
  if (token.length < 16) {
    throw new Error("admin token must be at least 16 characters");
  }
  return token;
}

async function handleMessages(runtime, flags, req, res, body) {
  const { provider } = runtime;
  const originalModel = String(body.model || "");
  const route = resolveModel(originalModel, provider.models);
  if (!route.ok) {
    sendJson(res, 400, {
      error: {
        type: "route_unknown",
        message: `model "${originalModel || "(missing)"}" is not allowed by this proxy config`,
      },
    });
    return { originalModel, mappedModel: "", routeReason: "route_unknown" };
  }
  const mappedModel = route.model;
  const upstreamBody = { ...body, model: mappedModel };
  if (flags.verbose) {
    console.error(
      `route /v1/messages: ${originalModel || "(missing)"} -> ${mappedModel}`,
    );
  }

  if (provider.apiFormat === "anthropic") {
    await forwardAnthropic(provider, req, res, "/v1/messages", upstreamBody);
    return { originalModel, mappedModel, routeReason: route.reason };
  }

  if (provider.apiFormat === "openai_chat") {
    if (upstreamBody.stream) {
      await forwardOpenAIChatStream(
        provider,
        req,
        res,
        upstreamBody,
        originalModel || mappedModel,
      );
      return { originalModel, mappedModel, routeReason: route.reason };
    }
    await forwardOpenAIChat(
      provider,
      req,
      res,
      upstreamBody,
      originalModel || mappedModel,
    );
    return { originalModel, mappedModel, routeReason: route.reason };
  }

  if (provider.apiFormat === "openai_responses") {
    if (upstreamBody.stream) {
      await forwardOpenAIResponsesStream(
        provider,
        req,
        res,
        upstreamBody,
        originalModel || mappedModel,
      );
      return { originalModel, mappedModel, routeReason: route.reason };
    }
    await forwardOpenAIResponses(
      provider,
      req,
      res,
      upstreamBody,
      originalModel || mappedModel,
    );
    return { originalModel, mappedModel, routeReason: route.reason };
  }

  if (provider.apiFormat === "gemini_native") {
    if (upstreamBody.stream) {
      await forwardGeminiNativeStream(
        provider,
        req,
        res,
        upstreamBody,
        originalModel || mappedModel,
      );
      return { originalModel, mappedModel, routeReason: route.reason };
    }
    await forwardGeminiNative(
      provider,
      req,
      res,
      upstreamBody,
      originalModel || mappedModel,
    );
    return { originalModel, mappedModel, routeReason: route.reason };
  }

  sendJson(res, 500, {
    error: {
      type: "configuration_error",
      message: `unsupported apiFormat "${provider.apiFormat}"`,
    },
  });
  return { originalModel, mappedModel, routeReason: "unsupported_api_format" };
}

async function forwardAnthropic(provider, req, res, targetPath, body) {
  const upstreamUrl = providerUpstreamUrl(provider, targetPath);
  const upstream = await fetchWithTimeout(
    upstreamUrl,
    {
      method: "POST",
      headers: buildAnthropicHeaders(provider, req.headers),
      body: JSON.stringify(body),
    },
    provider.timeoutMs,
  );
  await pipeResponse(upstream, res);
}

async function forwardOpenAIChat(provider, req, res, body, responseModel) {
  const upstreamUrl = providerUpstreamUrl(provider, "/v1/chat/completions");
  const upstream = await fetchWithTimeout(
    upstreamUrl,
    {
      method: "POST",
      headers: buildOpenAIHeaders(provider, req.headers),
      body: JSON.stringify(anthropicToOpenAIChat(body, { stream: false })),
    },
    provider.timeoutMs,
  );

  const text = await upstream.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    res.writeHead(upstream.status, {
      "content-type": upstream.headers.get("content-type") || "text/plain",
    });
    res.end(text);
    return;
  }

  if (!upstream.ok) {
    sendJson(res, upstream.status, json);
    return;
  }
  sendJson(res, 200, openAIChatToAnthropic(json, responseModel));
}

async function forwardOpenAIChatStream(
  provider,
  req,
  res,
  body,
  responseModel,
) {
  const upstreamUrl = providerUpstreamUrl(provider, "/v1/chat/completions");
  const upstream = await fetchWithTimeout(
    upstreamUrl,
    {
      method: "POST",
      headers: buildOpenAIHeaders(provider, req.headers),
      body: JSON.stringify(anthropicToOpenAIChat(body, { stream: true })),
    },
    provider.timeoutMs,
  );

  if (!upstream.ok) {
    const text = await upstream.text();
    sendJson(res, upstream.status, parseJsonOrError(text));
    return;
  }

  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
  });

  let stopReason = "end_turn";
  let usage = { input_tokens: 0, output_tokens: 0 };
  let nextBlockIndex = 0;
  let textBlockIndex = null;
  let textBlockOpen = false;
  let emittedAnyBlock = false;
  const toolCalls = new Map();

  const ensureTextBlock = () => {
    if (textBlockOpen) {
      return;
    }
    textBlockIndex = nextBlockIndex;
    nextBlockIndex += 1;
    textBlockOpen = true;
    emittedAnyBlock = true;
    sseWrite(res, "content_block_start", {
      type: "content_block_start",
      index: textBlockIndex,
      content_block: { type: "text", text: "" },
    });
  };

  const closeTextBlock = () => {
    if (!textBlockOpen) {
      return;
    }
    sseWrite(res, "content_block_stop", {
      type: "content_block_stop",
      index: textBlockIndex,
    });
    textBlockOpen = false;
  };

  sseWrite(res, "message_start", {
    type: "message_start",
    message: {
      id: `msg_${randomId()}`,
      type: "message",
      role: "assistant",
      model: responseModel,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage,
    },
  });

  for await (const data of iterSseData(upstream.body)) {
    if (data === "[DONE]") {
      break;
    }
    const json = parseJsonObjectLoose(data);
    if (!json) {
      continue;
    }
    if (json.usage) {
      usage = {
        input_tokens: json.usage.prompt_tokens || 0,
        output_tokens: json.usage.completion_tokens || 0,
      };
    }
    const choice = json.choices?.[0];
    const delta = choice?.delta || {};
    if (choice?.finish_reason) {
      stopReason =
        choice.finish_reason === "tool_calls"
          ? "tool_use"
          : mapStopReason(choice.finish_reason);
    }
    if (typeof delta.content === "string" && delta.content.length > 0) {
      ensureTextBlock();
      sseWrite(res, "content_block_delta", {
        type: "content_block_delta",
        index: textBlockIndex,
        delta: { type: "text_delta", text: delta.content },
      });
    }
    collectOpenAIToolCallDeltas(toolCalls, delta.tool_calls);
  }

  closeTextBlock();
  if (toolCalls.size > 0) {
    stopReason = "tool_use";
    for (const toolCall of [...toolCalls.values()].sort(
      (a, b) => a.index - b.index,
    )) {
      const blockIndex = nextBlockIndex;
      nextBlockIndex += 1;
      emittedAnyBlock = true;
      sseWrite(res, "content_block_start", {
        type: "content_block_start",
        index: blockIndex,
        content_block: {
          type: "tool_use",
          id: toolCall.id || `toolu_${randomId()}`,
          name: toolCall.name || "tool",
          input: {},
        },
      });
      const partialJson = toolCall.argumentsParts.join("");
      if (partialJson) {
        sseWrite(res, "content_block_delta", {
          type: "content_block_delta",
          index: blockIndex,
          delta: { type: "input_json_delta", partial_json: partialJson },
        });
      }
      sseWrite(res, "content_block_stop", {
        type: "content_block_stop",
        index: blockIndex,
      });
    }
  }

  if (!emittedAnyBlock) {
    sseWrite(res, "content_block_start", {
      type: "content_block_start",
      index: nextBlockIndex,
      content_block: { type: "text", text: "" },
    });
    sseWrite(res, "content_block_stop", {
      type: "content_block_stop",
      index: nextBlockIndex,
    });
  }

  sseWrite(res, "message_delta", {
    type: "message_delta",
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage,
  });
  sseWrite(res, "message_stop", { type: "message_stop" });
  res.end();
}

async function forwardOpenAIResponses(provider, req, res, body, responseModel) {
  const upstreamUrl = providerUpstreamUrl(provider, "/v1/responses");
  const upstream = await fetchWithTimeout(
    upstreamUrl,
    {
      method: "POST",
      headers: buildOpenAIHeaders(provider, req.headers),
      body: JSON.stringify(anthropicToOpenAIResponses(body, { stream: false })),
    },
    provider.timeoutMs,
  );

  const text = await upstream.text();
  const json = parseJsonObjectLoose(text);
  if (!json) {
    res.writeHead(upstream.status, {
      "content-type": upstream.headers.get("content-type") || "text/plain",
    });
    res.end(text);
    return;
  }
  if (!upstream.ok) {
    sendJson(res, upstream.status, json);
    return;
  }
  sendJson(res, 200, openAIResponsesToAnthropic(json, responseModel));
}

async function forwardOpenAIResponsesStream(
  provider,
  req,
  res,
  body,
  responseModel,
) {
  const upstreamUrl = providerUpstreamUrl(provider, "/v1/responses");
  const upstream = await fetchWithTimeout(
    upstreamUrl,
    {
      method: "POST",
      headers: buildOpenAIHeaders(provider, req.headers),
      body: JSON.stringify(anthropicToOpenAIResponses(body, { stream: true })),
    },
    provider.timeoutMs,
  );

  if (!upstream.ok) {
    const text = await upstream.text();
    sendJson(res, upstream.status, parseJsonOrError(text));
    return;
  }

  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
  });

  const state = startAnthropicSse(res, responseModel);
  const pendingToolCalls = new Map();

  for await (const data of iterSseData(upstream.body)) {
    if (data === "[DONE]") {
      break;
    }
    const event = parseJsonObjectLoose(data);
    if (!event) {
      continue;
    }
    handleOpenAIResponsesStreamEvent(res, state, event, pendingToolCalls);
  }

  closeAnthropicSse(res, state, [...pendingToolCalls.values()]);
}

async function forwardGeminiNative(provider, req, res, body, responseModel) {
  const upstreamUrl = geminiGenerateContentUrl(
    provider.baseUrl,
    body.model,
    false,
  );
  const upstream = await fetchWithTimeout(
    upstreamUrl,
    {
      method: "POST",
      headers: buildGeminiHeaders(provider),
      body: JSON.stringify(anthropicToGemini(body)),
    },
    provider.timeoutMs,
  );

  const text = await upstream.text();
  const json = parseJsonObjectLoose(text);
  if (!json) {
    res.writeHead(upstream.status, {
      "content-type": upstream.headers.get("content-type") || "text/plain",
    });
    res.end(text);
    return;
  }
  if (!upstream.ok) {
    sendJson(res, upstream.status, json);
    return;
  }
  sendJson(res, 200, geminiToAnthropic(json, responseModel));
}

async function forwardGeminiNativeStream(
  provider,
  req,
  res,
  body,
  responseModel,
) {
  const upstreamUrl = geminiGenerateContentUrl(
    provider.baseUrl,
    body.model,
    true,
  );
  const upstream = await fetchWithTimeout(
    upstreamUrl,
    {
      method: "POST",
      headers: buildGeminiHeaders(provider),
      body: JSON.stringify(anthropicToGemini(body)),
    },
    provider.timeoutMs,
  );

  if (!upstream.ok) {
    const text = await upstream.text();
    sendJson(res, upstream.status, parseJsonOrError(text));
    return;
  }

  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
  });

  const state = startAnthropicSse(res, responseModel);
  const pendingToolCalls = [];
  for await (const data of iterSseData(upstream.body)) {
    const chunk = parseJsonObjectLoose(data);
    if (!chunk) {
      continue;
    }
    handleGeminiStreamChunk(res, state, chunk, pendingToolCalls);
  }
  closeAnthropicSse(res, state, pendingToolCalls);
}

function collectOpenAIToolCallDeltas(toolCalls, deltas) {
  if (!Array.isArray(deltas)) {
    return;
  }
  for (const delta of deltas) {
    const index = Number.isInteger(delta.index) ? delta.index : toolCalls.size;
    let item = toolCalls.get(index);
    if (!item) {
      item = {
        index,
        id: "",
        name: "",
        argumentsParts: [],
      };
      toolCalls.set(index, item);
    }
    if (delta.id) {
      item.id = delta.id;
    }
    if (delta.function?.name) {
      item.name = delta.function.name;
    }
    if (typeof delta.function?.arguments === "string") {
      item.argumentsParts.push(delta.function.arguments);
    }
  }
}

function buildAnthropicHeaders(provider, inboundHeaders) {
  const headers = {
    "content-type": "application/json",
    "anthropic-version":
      inboundHeaders["anthropic-version"] || DEFAULT_ANTHROPIC_VERSION,
  };
  if (inboundHeaders["anthropic-beta"]) {
    headers["anthropic-beta"] = inboundHeaders["anthropic-beta"];
  }
  applyProviderHeaderOverrides(headers, provider);
  applyAuthHeader(headers, provider);
  return headers;
}

function buildOpenAIHeaders(provider) {
  const headers = { "content-type": "application/json" };
  applyProviderHeaderOverrides(headers, provider);
  applyAuthHeader(headers, provider);
  return headers;
}

function buildGeminiHeaders(provider) {
  const headers = { "content-type": "application/json" };
  applyProviderHeaderOverrides(headers, provider);
  if (provider.authHeader === "authorization-bearer") {
    headers.authorization = `Bearer ${provider.apiKey}`;
    return headers;
  }
  if (provider.authHeader === "none") {
    return headers;
  }
  headers["x-goog-api-key"] = provider.apiKey;
  return headers;
}

function applyProviderHeaderOverrides(headers, provider) {
  if (provider.customUserAgent) {
    headers["user-agent"] = provider.customUserAgent;
  }
  for (const [key, value] of Object.entries(provider.headerOverrides || {})) {
    if (typeof value === "string" || typeof value === "number") {
      headers[key.toLowerCase()] = String(value);
    }
  }
}

function applyAuthHeader(headers, provider) {
  if (provider.authHeader === "none") {
    return;
  }
  if (provider.authHeader === "x-api-key") {
    headers["x-api-key"] = provider.apiKey;
    return;
  }
  if (provider.authHeader === "api-key") {
    headers["api-key"] = provider.apiKey;
    return;
  }
  headers.authorization = `Bearer ${provider.apiKey}`;
}

async function fetchWithTimeout(url, options, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error.name === "AbortError") {
      const wrapped = new Error(
        `upstream request timed out after ${timeoutMs}ms`,
      );
      wrapped.statusCode = 504;
      throw wrapped;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function pipeResponse(upstream, res) {
  const headers = {};
  for (const [key, value] of upstream.headers.entries()) {
    if (
      ![
        "content-encoding",
        "content-length",
        "transfer-encoding",
        "connection",
      ].includes(key.toLowerCase())
    ) {
      headers[key] = value;
    }
  }
  res.writeHead(upstream.status, headers);
  if (!upstream.body) {
    res.end();
    return;
  }
  for await (const chunk of upstream.body) {
    res.write(Buffer.from(chunk));
  }
  res.end();
}

async function* iterSseData(stream) {
  if (!stream) {
    return;
  }
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, "\n");
    let index;
    while ((index = buffer.indexOf("\n\n")) >= 0) {
      const raw = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      const data = raw
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (data) {
        yield data;
      }
    }
  }
  buffer += decoder.decode();
  const tail = buffer.trim();
  if (tail) {
    const data = tail
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (data) {
      yield data;
    }
  }
}

function sseWrite(res, event, payload) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function parseJsonObjectLoose(text) {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function parseJsonOrError(text) {
  const parsed = parseJsonObjectLoose(text);
  return (
    parsed || {
      error: {
        type: "upstream_error",
        message: text.slice(0, 4000),
      },
    }
  );
}

function mapModel(model, models = {}) {
  const route = resolveModel(model, models);
  if (!route.ok) {
    throw new Error(
      `model "${model || "(missing)"}" is not allowed by this proxy config`,
    );
  }
  return route.model;
}

function resolveModel(model, models = {}) {
  const directory = compileModelDirectory(models);
  const cleanModel = stripOneMillionSuffix(model || directory.defaultEntry?.scienceId || "");
  if (!cleanModel) {
    return { ok: false, model: cleanModel, reason: "missing" };
  }

  const direct = directory.routes.get(cleanModel);
  if (direct) {
    return { ok: true, model: direct.model, reason: direct.reason };
  }

  if (directory.fallbackUnknownToDefault && directory.defaultEntry) {
    return {
      ok: true,
      model: directory.defaultEntry.upstreamModel,
      reason: "fallback:default",
    };
  }
  return { ok: false, model: cleanModel, reason: "route_unknown" };
}

function isClaudeFamily(model) {
  return model.startsWith("claude-");
}

function stripOneMillionSuffix(model) {
  return String(model).replace(/\s*\[1M\]\s*$/i, "");
}

function providerUpstreamUrl(provider, targetPath) {
  if (provider.isFullUrl && isGenerationEndpoint(targetPath)) {
    return new URL(provider.baseUrl).toString();
  }
  return joinUpstreamUrl(provider.baseUrl, targetPath);
}

function isGenerationEndpoint(targetPath) {
  const cleanPath = String(targetPath || "")
    .split("?")[0]
    .replace(/\/+$/, "");
  return ["/v1/messages", "/v1/chat/completions", "/v1/responses"].includes(
    cleanPath,
  );
}

function joinUpstreamUrl(baseUrl, targetPath) {
  const url = new URL(baseUrl);
  const basePath = url.pathname.replace(/\/+$/, "");
  let suffix = targetPath.startsWith("/") ? targetPath : `/${targetPath}`;
  if (basePath.endsWith("/v1") && suffix.startsWith("/v1/")) {
    suffix = suffix.slice(3);
  }
  url.pathname = `${basePath}${suffix}`.replace(/\/{2,}/g, "/");
  return url.toString();
}

function geminiGenerateContentUrl(baseUrl, model, stream) {
  const method = stream ? "streamGenerateContent" : "generateContent";
  const url = new URL(baseUrl);
  const cleanModel = String(model || "").replace(/^models\//, "");
  const pathname = url.pathname.replace(/\/+$/, "");
  if (
    /\/models\/[^/]+:(streamGenerateContent|generateContent)$/.test(pathname)
  ) {
    url.pathname = pathname.replace(
      /:(streamGenerateContent|generateContent)$/,
      `:${method}`,
    );
  } else {
    const basePath = pathname === "" || pathname === "/" ? "/v1beta" : pathname;
    url.pathname =
      `${basePath}/models/${encodeURIComponent(cleanModel)}:${method}`.replace(
        /\/{2,}/g,
        "/",
      );
  }
  if (stream) {
    url.searchParams.set("alt", "sse");
  } else {
    url.searchParams.delete("alt");
  }
  return url.toString();
}

function geminiModelsUrl(baseUrl) {
  const url = new URL(baseUrl);
  const pathname = url.pathname.replace(/\/+$/, "");
  if (
    /\/models\/[^/]+:(streamGenerateContent|generateContent)$/.test(pathname)
  ) {
    url.pathname = pathname.replace(
      /\/models\/[^/]+:(streamGenerateContent|generateContent)$/,
      "/models",
    );
  } else {
    const basePath = pathname === "" || pathname === "/" ? "/v1beta" : pathname;
    url.pathname = `${basePath}/models`.replace(/\/{2,}/g, "/");
  }
  url.search = "";
  return url.toString();
}

function anthropicToOpenAIChat(body, options = {}) {
  const messages = [];
  if (body.system) {
    messages.push({
      role: "system",
      content: flattenAnthropicContent(body.system),
    });
  }
  for (const message of body.messages || []) {
    messages.push(...anthropicMessageToOpenAIChat(message));
  }

  const out = {
    model: body.model,
    messages,
    max_tokens: body.max_tokens,
    temperature: body.temperature,
    top_p: body.top_p,
    stream: Boolean(options.stream),
  };

  if (Array.isArray(body.tools) && body.tools.length > 0) {
    out.tools = body.tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description || "",
        parameters: tool.input_schema || { type: "object", properties: {} },
      },
    }));
  }
  if (body.tool_choice?.type === "tool") {
    out.tool_choice = {
      type: "function",
      function: { name: body.tool_choice.name },
    };
  } else if (body.tool_choice?.type === "any") {
    out.tool_choice = "required";
  } else if (body.tool_choice?.type === "none") {
    out.tool_choice = "none";
  }

  return dropUndefined(out);
}

function anthropicToOpenAIResponses(body, options = {}) {
  const out = {
    model: body.model,
    input: anthropicMessagesToResponsesInput(body.messages || []),
    instructions: body.system
      ? flattenAnthropicContent(body.system)
      : undefined,
    max_output_tokens: body.max_tokens,
    temperature: body.temperature,
    top_p: body.top_p,
    stream: Boolean(options.stream),
  };
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    out.tools = body.tools.map((tool) => ({
      type: "function",
      name: tool.name,
      description: tool.description || "",
      parameters: tool.input_schema || { type: "object", properties: {} },
    }));
  }
  if (body.tool_choice) {
    out.tool_choice = mapAnthropicToolChoiceForResponses(body.tool_choice);
  }
  return dropUndefined(out);
}

function anthropicMessagesToResponsesInput(messages) {
  const input = [];
  for (const message of messages) {
    if (message.role === "assistant") {
      input.push(...anthropicAssistantMessageToResponsesInput(message.content));
    } else {
      input.push(...anthropicUserMessageToResponsesInput(message.content));
    }
  }
  return input;
}

function anthropicAssistantMessageToResponsesInput(content) {
  const blocks = toAnthropicBlocks(content);
  const textParts = [];
  const items = [];
  for (const block of blocks) {
    if (block.type === "tool_use") {
      items.push({
        type: "function_call",
        call_id: block.id || `call_${randomId()}`,
        name: block.name || "tool",
        arguments: stringifyToolInput(block.input),
      });
      continue;
    }
    const text = flattenAnthropicBlock(block);
    if (text) {
      textParts.push({ type: "output_text", text });
    }
  }
  if (textParts.length > 0 || items.length === 0) {
    items.unshift({
      role: "assistant",
      content:
        textParts.length > 0 ? textParts : [{ type: "output_text", text: "" }],
    });
  }
  return items;
}

function anthropicUserMessageToResponsesInput(content) {
  const blocks = toAnthropicBlocks(content);
  const contentParts = [];
  const items = [];
  for (const block of blocks) {
    if (block.type === "tool_result") {
      items.push({
        type: "function_call_output",
        call_id: block.tool_use_id || block.id || "unknown_tool_call",
        output: flattenToolResultContent(block.content),
      });
      continue;
    }
    const text = flattenAnthropicBlock(block);
    if (text) {
      contentParts.push({ type: "input_text", text });
    }
  }
  if (contentParts.length > 0 || items.length === 0) {
    items.push({
      role: "user",
      content:
        contentParts.length > 0
          ? contentParts
          : [{ type: "input_text", text: "" }],
    });
  }
  return items;
}

function mapAnthropicToolChoiceForResponses(toolChoice) {
  if (toolChoice.type === "any") {
    return "required";
  }
  if (toolChoice.type === "auto") {
    return "auto";
  }
  if (toolChoice.type === "none") {
    return "none";
  }
  if (toolChoice.type === "tool") {
    return { type: "function", name: toolChoice.name };
  }
  return toolChoice;
}

function anthropicToGemini(body) {
  const out = {
    contents: anthropicMessagesToGeminiContents(body.messages || []),
    generationConfig: dropUndefined({
      maxOutputTokens: body.max_tokens,
      temperature: body.temperature,
      topP: body.top_p,
      stopSequences: body.stop_sequences,
    }),
  };
  if (body.system) {
    out.systemInstruction = {
      parts: [{ text: flattenAnthropicContent(body.system) }],
    };
  }
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    out.tools = [
      {
        functionDeclarations: body.tools.map((tool) => ({
          name: tool.name,
          description: tool.description || "",
          parameters: tool.input_schema || { type: "object", properties: {} },
        })),
      },
    ];
  }
  if (Object.keys(out.generationConfig).length === 0) {
    delete out.generationConfig;
  }
  return out;
}

function anthropicMessagesToGeminiContents(messages) {
  return messages.map((message) => ({
    role: message.role === "assistant" ? "model" : "user",
    parts: anthropicBlocksToGeminiParts(message.content),
  }));
}

function anthropicBlocksToGeminiParts(content) {
  const parts = [];
  for (const block of toAnthropicBlocks(content)) {
    if (block.type === "tool_use") {
      parts.push({
        functionCall: {
          name: block.name || "tool",
          args: block.input || {},
        },
      });
      continue;
    }
    if (block.type === "tool_result") {
      parts.push({
        functionResponse: {
          name: block.name || block.tool_name || "tool",
          response: { result: flattenToolResultContent(block.content) },
        },
      });
      continue;
    }
    const text = flattenAnthropicBlock(block);
    if (text) {
      parts.push({ text });
    }
  }
  return parts.length > 0 ? parts : [{ text: "" }];
}

function anthropicMessageToOpenAIChat(message) {
  if (message.role === "assistant") {
    return [anthropicAssistantMessageToOpenAIChat(message.content)];
  }
  return anthropicUserMessageToOpenAIChat(message.content);
}

function anthropicAssistantMessageToOpenAIChat(content) {
  const textParts = [];
  const toolCalls = [];
  for (const block of toAnthropicBlocks(content)) {
    if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id || `toolu_${randomId()}`,
        type: "function",
        function: {
          name: block.name || "tool",
          arguments: stringifyToolInput(block.input),
        },
      });
      continue;
    }
    const text = flattenAnthropicBlock(block);
    if (text) {
      textParts.push(text);
    }
  }
  const out = {
    role: "assistant",
    content: textParts.join("\n") || (toolCalls.length > 0 ? null : ""),
  };
  if (toolCalls.length > 0) {
    out.tool_calls = toolCalls;
  }
  return out;
}

function anthropicUserMessageToOpenAIChat(content) {
  const blocks = toAnthropicBlocks(content);
  const textParts = [];
  const toolMessages = [];
  for (const block of blocks) {
    if (block.type === "tool_result") {
      toolMessages.push({
        role: "tool",
        tool_call_id: block.tool_use_id || block.id || "unknown_tool_call",
        content: flattenToolResultContent(block.content),
      });
      continue;
    }
    const text = flattenAnthropicBlock(block);
    if (text) {
      textParts.push(text);
    }
  }
  if (toolMessages.length === 0) {
    return [{ role: "user", content: textParts.join("\n") }];
  }
  const out = [...toolMessages];
  if (textParts.length > 0) {
    out.push({ role: "user", content: textParts.join("\n") });
  }
  return out;
}

function flattenAnthropicContent(content) {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return String(content ?? "");
  }
  return content.map(flattenAnthropicBlock).join("\n");
}

function toAnthropicBlocks(content) {
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }
  if (Array.isArray(content)) {
    return content;
  }
  if (content == null) {
    return [];
  }
  return [{ type: "text", text: String(content) }];
}

function flattenAnthropicBlock(block) {
  if (block.type === "text") {
    return block.text || "";
  }
  if (block.type === "tool_result") {
    return flattenToolResultContent(block.content);
  }
  if (block.type === "tool_use") {
    return `[tool_use:${block.name || "tool"}] ${stringifyToolInput(block.input)}`;
  }
  return `[unsupported:${block.type}]`;
}

function flattenToolResultContent(content) {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "string") {
          return item;
        }
        if (item?.type === "text") {
          return item.text || "";
        }
        return JSON.stringify(item ?? "");
      })
      .join("\n");
  }
  return JSON.stringify(content ?? "");
}

function stringifyToolInput(input) {
  try {
    return JSON.stringify(input ?? {});
  } catch {
    return "{}";
  }
}

function openAIChatToAnthropic(json, responseModel) {
  const choice = json.choices?.[0] || {};
  const message = choice.message || {};
  const content = [];
  if (message.content) {
    content.push({ type: "text", text: message.content });
  }
  for (const toolCall of message.tool_calls || []) {
    const fn = toolCall.function || {};
    content.push({
      type: "tool_use",
      id: toolCall.id || `toolu_${randomId()}`,
      name: fn.name || "tool",
      input: parseJsonObject(fn.arguments),
    });
  }
  if (content.length === 0) {
    content.push({ type: "text", text: "" });
  }

  return {
    id: `msg_${json.id || randomId()}`,
    type: "message",
    role: "assistant",
    model: responseModel,
    content,
    stop_reason:
      choice.finish_reason === "tool_calls"
        ? "tool_use"
        : mapStopReason(choice.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: json.usage?.prompt_tokens || 0,
      output_tokens: json.usage?.completion_tokens || 0,
    },
  };
}

function openAIResponsesToAnthropic(json, responseModel) {
  const content = [];
  let hasToolUse = false;
  for (const item of json.output || []) {
    if (item.type === "message") {
      for (const block of item.content || []) {
        if (block.type === "output_text" && block.text) {
          content.push({ type: "text", text: block.text });
        } else if (block.type === "refusal" && block.refusal) {
          content.push({ type: "text", text: block.refusal });
        }
      }
    } else if (item.type === "function_call") {
      hasToolUse = true;
      content.push({
        type: "tool_use",
        id: item.call_id || item.id || `toolu_${randomId()}`,
        name: item.name || "tool",
        input: parseJsonObject(item.arguments),
      });
    } else if (item.type === "reasoning") {
      const text = (item.summary || [])
        .map((part) => part?.text || "")
        .filter(Boolean)
        .join("");
      if (text) {
        content.push({ type: "thinking", thinking: text });
      }
    }
  }
  if (content.length === 0) {
    const fallback = json.output_text || "";
    content.push({ type: "text", text: fallback });
  }
  return {
    id: `msg_${json.id || randomId()}`,
    type: "message",
    role: "assistant",
    model: responseModel,
    content,
    stop_reason: mapResponsesStopReason(
      json.status,
      hasToolUse,
      json.incomplete_details?.reason,
    ),
    stop_sequence: null,
    usage: responsesUsageToAnthropic(json.usage),
  };
}

function geminiToAnthropic(json, responseModel) {
  if (json.promptFeedback?.blockReason) {
    return {
      id: `msg_${json.responseId || randomId()}`,
      type: "message",
      role: "assistant",
      model: responseModel,
      content: [
        {
          type: "text",
          text: `Request blocked by Gemini safety filters: ${json.promptFeedback.blockReason}`,
        },
      ],
      stop_reason: "refusal",
      stop_sequence: null,
      usage: geminiUsageToAnthropic(json.usageMetadata),
    };
  }
  const candidate = json.candidates?.[0] || {};
  const content = [];
  let hasToolUse = false;
  for (const part of candidate.content?.parts || []) {
    if (typeof part.text === "string" && part.text.length > 0) {
      content.push({ type: "text", text: part.text });
    }
    if (part.functionCall) {
      hasToolUse = true;
      content.push({
        type: "tool_use",
        id: part.functionCall.id || `toolu_${randomId()}`,
        name: part.functionCall.name || "tool",
        input: part.functionCall.args || {},
      });
    }
  }
  if (content.length === 0) {
    content.push({ type: "text", text: "" });
  }
  return {
    id: `msg_${json.responseId || randomId()}`,
    type: "message",
    role: "assistant",
    model: responseModel,
    content,
    stop_reason: mapGeminiStopReason(candidate.finishReason, hasToolUse),
    stop_sequence: null,
    usage: geminiUsageToAnthropic(json.usageMetadata),
  };
}

function startAnthropicSse(res, responseModel) {
  const state = {
    responseModel,
    stopReason: "end_turn",
    usage: { input_tokens: 0, output_tokens: 0 },
    nextBlockIndex: 0,
    textBlockIndex: null,
    textBlockOpen: false,
    emittedAnyBlock: false,
  };
  sseWrite(res, "message_start", {
    type: "message_start",
    message: {
      id: `msg_${randomId()}`,
      type: "message",
      role: "assistant",
      model: responseModel,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: state.usage,
    },
  });
  return state;
}

function ensureAnthropicTextBlock(res, state) {
  if (state.textBlockOpen) {
    return;
  }
  state.textBlockIndex = state.nextBlockIndex;
  state.nextBlockIndex += 1;
  state.textBlockOpen = true;
  state.emittedAnyBlock = true;
  sseWrite(res, "content_block_start", {
    type: "content_block_start",
    index: state.textBlockIndex,
    content_block: { type: "text", text: "" },
  });
}

function closeAnthropicTextBlock(res, state) {
  if (!state.textBlockOpen) {
    return;
  }
  sseWrite(res, "content_block_stop", {
    type: "content_block_stop",
    index: state.textBlockIndex,
  });
  state.textBlockOpen = false;
}

function emitAnthropicTextDelta(res, state, text) {
  if (!text) {
    return;
  }
  ensureAnthropicTextBlock(res, state);
  sseWrite(res, "content_block_delta", {
    type: "content_block_delta",
    index: state.textBlockIndex,
    delta: { type: "text_delta", text },
  });
}

function closeAnthropicSse(res, state, toolCalls = []) {
  closeAnthropicTextBlock(res, state);
  if (toolCalls.length > 0) {
    state.stopReason = "tool_use";
    for (const toolCall of toolCalls) {
      const blockIndex = state.nextBlockIndex;
      state.nextBlockIndex += 1;
      state.emittedAnyBlock = true;
      sseWrite(res, "content_block_start", {
        type: "content_block_start",
        index: blockIndex,
        content_block: {
          type: "tool_use",
          id: toolCall.id || `toolu_${randomId()}`,
          name: toolCall.name || "tool",
          input: toolCall.input || {},
        },
      });
      const partialJson = toolCall.argumentsParts?.join("") || "";
      if (partialJson) {
        sseWrite(res, "content_block_delta", {
          type: "content_block_delta",
          index: blockIndex,
          delta: { type: "input_json_delta", partial_json: partialJson },
        });
      }
      sseWrite(res, "content_block_stop", {
        type: "content_block_stop",
        index: blockIndex,
      });
    }
  }
  if (!state.emittedAnyBlock) {
    sseWrite(res, "content_block_start", {
      type: "content_block_start",
      index: state.nextBlockIndex,
      content_block: { type: "text", text: "" },
    });
    sseWrite(res, "content_block_stop", {
      type: "content_block_stop",
      index: state.nextBlockIndex,
    });
  }
  sseWrite(res, "message_delta", {
    type: "message_delta",
    delta: { stop_reason: state.stopReason, stop_sequence: null },
    usage: state.usage,
  });
  sseWrite(res, "message_stop", { type: "message_stop" });
  res.end();
}

function handleOpenAIResponsesStreamEvent(res, state, event, pendingToolCalls) {
  if (
    event.type === "response.output_text.delta" ||
    event.type === "response.refusal.delta"
  ) {
    emitAnthropicTextDelta(res, state, event.delta || "");
    return;
  }
  if (event.type === "response.function_call_arguments.delta") {
    const key = String(
      event.output_index ?? event.item_id ?? pendingToolCalls.size,
    );
    const existing = pendingToolCalls.get(key) || {
      id: event.call_id || event.item_id,
      name: event.name || "tool",
      argumentsParts: [],
    };
    existing.argumentsParts.push(event.delta || "");
    pendingToolCalls.set(key, existing);
    return;
  }
  if (
    event.type === "response.output_item.added" &&
    event.item?.type === "function_call"
  ) {
    const key = String(
      event.output_index ?? event.item.id ?? pendingToolCalls.size,
    );
    pendingToolCalls.set(key, {
      id: event.item.call_id || event.item.id,
      name: event.item.name || "tool",
      argumentsParts: [event.item.arguments || ""],
    });
    return;
  }
  if (
    event.type === "response.output_item.done" &&
    event.item?.type === "function_call"
  ) {
    const key = String(
      event.output_index ?? event.item.id ?? pendingToolCalls.size,
    );
    const existing = pendingToolCalls.get(key) || { argumentsParts: [] };
    pendingToolCalls.set(key, {
      id: event.item.call_id || event.item.id || existing.id,
      name: event.item.name || existing.name || "tool",
      argumentsParts: [
        event.item.arguments || existing.argumentsParts.join("") || "",
      ],
    });
    return;
  }
  const response =
    event.response ||
    (event.type === "response.completed" ? event.response : null);
  if (response) {
    state.usage = responsesUsageToAnthropic(response.usage);
    state.stopReason = mapResponsesStopReason(
      response.status,
      pendingToolCalls.size > 0,
      response.incomplete_details?.reason,
    );
    for (const toolCall of extractOpenAIResponsesToolCalls(response)) {
      pendingToolCalls.set(toolCall.id, toolCall);
    }
  }
}

function handleGeminiStreamChunk(res, state, chunk, pendingToolCalls) {
  if (chunk.usageMetadata) {
    state.usage = geminiUsageToAnthropic(chunk.usageMetadata);
  }
  const candidate = chunk.candidates?.[0];
  if (!candidate) {
    return;
  }
  let hasToolUse = pendingToolCalls.length > 0;
  for (const part of candidate.content?.parts || []) {
    if (typeof part.text === "string") {
      emitAnthropicTextDelta(res, state, part.text);
    }
    if (part.functionCall) {
      hasToolUse = true;
      pendingToolCalls.push({
        id: part.functionCall.id || `toolu_${randomId()}`,
        name: part.functionCall.name || "tool",
        input: part.functionCall.args || {},
      });
    }
  }
  if (candidate.finishReason) {
    state.stopReason = mapGeminiStopReason(candidate.finishReason, hasToolUse);
  }
}

function extractOpenAIResponsesToolCalls(response) {
  const calls = [];
  for (const item of response.output || []) {
    if (item.type === "function_call") {
      calls.push({
        id: item.call_id || item.id || `toolu_${randomId()}`,
        name: item.name || "tool",
        input: parseJsonObject(item.arguments),
        argumentsParts: [],
      });
    }
  }
  return calls;
}

function responsesUsageToAnthropic(usage = {}) {
  return {
    input_tokens: usage?.input_tokens || usage?.prompt_tokens || 0,
    output_tokens: usage?.output_tokens || usage?.completion_tokens || 0,
  };
}

function geminiUsageToAnthropic(usage = {}) {
  return {
    input_tokens: usage?.promptTokenCount || 0,
    output_tokens: usage?.candidatesTokenCount || 0,
  };
}

function mapResponsesStopReason(status, hasToolUse, incompleteReason) {
  if (hasToolUse) {
    return "tool_use";
  }
  if (status === "incomplete" && incompleteReason === "max_output_tokens") {
    return "max_tokens";
  }
  if (status === "incomplete" && incompleteReason === "content_filter") {
    return "stop_sequence";
  }
  return "end_turn";
}

function mapGeminiStopReason(reason, hasToolUse) {
  if (hasToolUse) {
    return "tool_use";
  }
  if (reason === "MAX_TOKENS") {
    return "max_tokens";
  }
  if (
    reason === "SAFETY" ||
    reason === "RECITATION" ||
    reason === "BLOCKLIST"
  ) {
    return "stop_sequence";
  }
  return "end_turn";
}

function mapStopReason(reason) {
  if (reason === "length") {
    return "max_tokens";
  }
  if (reason === "content_filter") {
    return "stop_sequence";
  }
  return "end_turn";
}

function parseJsonObject(value) {
  try {
    const parsed = JSON.parse(value || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}

function dropUndefined(object) {
  return Object.fromEntries(
    Object.entries(object).filter(([, value]) => value !== undefined),
  );
}

function randomId() {
  return Math.random().toString(36).slice(2, 14);
}

function isMessagesPath(pathname) {
  return (
    pathname === "/v1/messages" ||
    pathname === "/claude/v1/messages" ||
    pathname === "/claude-desktop/v1/messages"
  );
}

function isModelsPath(pathname) {
  return (
    pathname === "/v1/models" ||
    pathname === "/claude/v1/models" ||
    pathname === "/claude-desktop/v1/models"
  );
}

function isCountTokensPath(pathname) {
  return (
    pathname === "/v1/messages/count_tokens" ||
    pathname === "/claude/v1/messages/count_tokens"
  );
}

async function readJsonBody(req, maxBytes = DEFAULT_MAX_BODY_BYTES) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) {
      const wrapped = new Error(`request body exceeds ${maxBytes} bytes`);
      wrapped.statusCode = 413;
      throw wrapped;
    }
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) {
    return {};
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    const wrapped = new Error(`invalid JSON request body: ${error.message}`);
    wrapped.statusCode = 400;
    throw wrapped;
  }
}

function sendJson(res, status, payload) {
  if (res.headersSent) {
    return;
  }
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload, null, 2));
}

function sendHtml(res, html) {
  if (res.headersSent) {
    return;
  }
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(html);
}

function sendText(res, status, text) {
  if (res.headersSent) {
    return;
  }
  res.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(text);
}

function setCors(req, res) {
  const origin = req.headers.origin;
  if (origin && isSameOriginOrLoopback(origin, req.headers.host)) {
    res.setHeader("access-control-allow-origin", origin);
    res.setHeader("vary", "Origin");
    res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
    res.setHeader(
      "access-control-allow-headers",
      "authorization,content-type,x-api-key,anthropic-version,anthropic-beta,x-cs-switch-admin",
    );
  }
}

function isSameOriginOrLoopback(origin, host) {
  try {
    const parsed = new URL(origin);
    return isLoopbackHost(parsed.hostname) && parsed.host === host;
  } catch {
    return false;
  }
}

function statusPayload(runtime, stats, startedAt) {
  const { server, provider, configPath } = runtime;
  return {
    ok: true,
    configPath,
    listen: `http://${server.host}:${server.port}`,
    provider: {
      name: provider.name,
      apiFormat: provider.apiFormat,
      baseUrl: provider.baseUrl,
      apiKeySource: provider.apiKeySource,
      modelDefault: provider.models.default || null,
    },
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    stats,
  };
}

function readyPayload(runtime) {
  const { provider, server } = runtime;
  const checks = [];
  const add = (name, ok, detail = "") => checks.push({ name, ok, detail });

  add("loopback_listen", isLoopbackHost(server.host), server.host);
  add(
    "client_token",
    Boolean(server.clientToken),
    server.clientToken ? "configured" : "missing",
  );
  add(
    "auth_configured",
    Boolean(provider.apiKey || provider.authHeader === "none"),
    describeApiKeySource(provider),
  );
  add(
    "api_format",
    supportedApiFormats().includes(provider.apiFormat),
    provider.apiFormat,
  );
  try {
    const parsed = new URL(provider.baseUrl);
    add("base_url", Boolean(parsed.protocol && parsed.hostname), parsed.origin);
  } catch (error) {
    add("base_url", false, error.message);
  }
  for (const alias of [
    "claude-haiku-4-5",
    "claude-sonnet-4-6",
    "claude-opus-4-8",
  ]) {
    const route = resolveModel(alias, provider.models);
    add(
      `route_${alias}`,
      route.ok,
      route.ok ? `${alias} -> ${route.model}` : "not routable",
    );
  }

  const ok = checks.every((check) => check.ok);
  return {
    ok,
    checks,
    provider: provider.name,
    apiFormat: provider.apiFormat,
    authConfigured: Boolean(provider.apiKey || provider.authHeader === "none"),
    loopbackOnly: isLoopbackHost(server.host),
    clientAuthRequired: Boolean(server.clientToken),
    upstream: provider.baseUrl,
  };
}

function supportedApiFormats() {
  return ["anthropic", "openai_chat", "openai_responses", "gemini_native"];
}

function appendRequestLog(log, entry) {
  log.push({
    requestId: entry.requestId || "",
    method: entry.method || "",
    path: entry.path || "",
    time: entry.time || new Date().toISOString(),
    kind: entry.kind || "request",
    provider: entry.provider || "",
    apiFormat: entry.apiFormat || "",
    model: entry.model || "",
    mappedModel: entry.mappedModel || "",
    stream: Boolean(entry.stream),
    status: Number(entry.status || 0),
    latencyMs: Number(entry.latencyMs || 0),
    detail: entry.detail || "",
    error: entry.error || "",
  });
  while (log.length > 200) {
    log.shift();
  }
}

function adminStatePayload(runtime, stats, startedAt, requestLog = []) {
  const { config, configPath, provider, server } = runtime;
  return {
    ok: true,
    version: VERSION,
    configPath,
    listen: `http://${server.host}:${server.port}`,
    scienceBaseUrl: `http://127.0.0.1:${server.port}`,
    activeProvider: provider.name,
    provider: providerSummary(provider, true),
    providers: Object.entries(config.providers).map(([name, item]) =>
      providerSummary(
        normalizeProviderConfig(item, name),
        name === provider.name,
      ),
    ),
    recentLogs: requestLog.slice(-20).reverse(),
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    stats,
    safety: {
      loopbackOnly: isLoopbackHost(server.host),
      inboundAuthRequired: true,
      officialAnthropicBlockedByDefault: true,
      writesClaudeScienceProfile: false,
    },
  };
}

function providerSummary(provider, active = false) {
  return {
    id: provider.name,
    name: provider.name,
    active,
    apiFormat: provider.apiFormat || "anthropic",
    baseUrl: provider.baseUrl || "",
    auth: provider.apiKeySource || describeApiKeySource(provider),
    defaultModel: provider.models?.default || "",
    haiku: provider.models?.haiku || "",
    sonnet: provider.models?.sonnet || "",
    opus: provider.models?.opus || "",
    fable: provider.models?.fable || "",
  };
}

function dashboardHtml(adminToken) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Claude Science Switch</title>
  <style>
    :root {
      color-scheme: light dark;
      --bg: #f7f7f4;
      --panel: #ffffff;
      --ink: #202124;
      --muted: #62645f;
      --line: #d9d8d0;
      --accent: #0f766e;
      --accent-ink: #ffffff;
      --warn: #b45309;
      --bad: #b91c1c;
      --code: #1f2937;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #111312;
        --panel: #181b1a;
        --ink: #f4f4ef;
        --muted: #aaa89e;
        --line: #30342f;
        --accent: #2dd4bf;
        --accent-ink: #06201d;
        --warn: #f59e0b;
        --bad: #f87171;
        --code: #0b0f0e;
      }
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font: 14px/1.45 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: var(--bg);
      color: var(--ink);
    }
    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      padding: 18px 24px;
      border-bottom: 1px solid var(--line);
      background: var(--panel);
      position: sticky;
      top: 0;
      z-index: 1;
    }
    h1 { font-size: 18px; margin: 0; font-weight: 700; }
    h2 { font-size: 14px; margin: 0 0 12px; font-weight: 700; }
    main {
      display: grid;
      grid-template-columns: minmax(280px, 360px) minmax(0, 1fr);
      gap: 16px;
      padding: 16px;
      max-width: 1280px;
      margin: 0 auto;
    }
    section, aside {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 14px;
    }
    .toolbar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    button {
      border: 1px solid var(--line);
      border-radius: 7px;
      padding: 7px 10px;
      background: transparent;
      color: var(--ink);
      cursor: pointer;
      font: inherit;
    }
    button.primary { background: var(--accent); color: var(--accent-ink); border-color: var(--accent); }
    button:disabled { opacity: 0.45; cursor: wait; }
    .statusline { display: flex; gap: 10px; flex-wrap: wrap; color: var(--muted); }
    .pill {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 3px 8px;
      font-size: 12px;
    }
    .dot { width: 7px; height: 7px; border-radius: 999px; background: var(--accent); display: inline-block; }
    .dot.warn { background: var(--warn); }
    .providers { display: grid; gap: 8px; }
    .provider {
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 10px;
      display: grid;
      gap: 8px;
    }
    .provider.active { border-color: var(--accent); }
    .provider-head { display: flex; justify-content: space-between; gap: 8px; align-items: start; }
    .provider-name { font-weight: 700; overflow-wrap: anywhere; }
    .meta { color: var(--muted); font-size: 12px; overflow-wrap: anywhere; }
    .grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 16px;
    }
    .kv { display: grid; gap: 8px; }
    .row { display: grid; grid-template-columns: 150px minmax(0, 1fr); gap: 10px; }
    .key { color: var(--muted); }
    .value { overflow-wrap: anywhere; }
    pre {
      margin: 0;
      padding: 12px;
      border-radius: 8px;
      background: var(--code);
      color: #e5e7eb;
      overflow: auto;
      min-height: 180px;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .notice { border-color: color-mix(in srgb, var(--warn), var(--line) 60%); }
    .error { color: var(--bad); }
    .stack { display: grid; gap: 16px; }
    @media (max-width: 860px) {
      main { grid-template-columns: 1fr; }
      .grid { grid-template-columns: 1fr; }
      header { position: static; align-items: start; flex-direction: column; }
    }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>Claude Science Switch</h1>
      <div class="statusline" id="summary"></div>
    </div>
    <div class="toolbar">
      <button id="reload">Reload</button>
      <button id="doctor" class="primary">Doctor</button>
    </div>
  </header>
  <main>
    <aside>
      <h2>Providers</h2>
      <div class="providers" id="providers"></div>
    </aside>
    <div class="stack">
      <section>
        <h2>Proxy</h2>
        <div class="kv" id="proxy"></div>
      </section>
      <section>
        <h2>Doctor</h2>
        <pre id="doctor-output">Ready.</pre>
      </section>
      <section>
        <h2>Request Log</h2>
        <div class="kv" id="request-log"></div>
      </section>
      <section class="notice">
        <h2>Science Launch</h2>
        <pre id="science-env">Loading...</pre>
      </section>
    </div>
  </main>
  <script>
    const ADMIN_TOKEN = ${JSON.stringify(adminToken)};
    const state = { busy: false };
    const $ = (id) => document.getElementById(id);
    const esc = (text) => String(text ?? "").replace(/[&<>"']/g, (ch) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    }[ch]));

    async function json(url, options) {
      const headers = { "content-type": "application/json" };
      if (url.startsWith("/admin/")) headers["x-cs-switch-admin"] = ADMIN_TOKEN;
      const res = await fetch(url, {
        headers,
        ...options
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || data.error?.message || res.statusText);
      return data;
    }

    async function load() {
      const data = await json("/admin/state");
      render(data);
      const script = await fetch("/admin/science-env", {
        headers: { "x-cs-switch-admin": ADMIN_TOKEN }
      }).then((res) => res.text());
      $("science-env").textContent = script;
    }

    function render(data) {
      $("summary").innerHTML = [
        '<span class="pill"><span class="dot"></span>' + esc(data.activeProvider) + '</span>',
        '<span class="pill">' + esc(data.listen) + '</span>',
        '<span class="pill">uptime ' + esc(data.uptimeSeconds) + 's</span>'
      ].join("");

      $("providers").innerHTML = data.providers.map((provider) =>
        '<div class="provider ' + (provider.active ? "active" : "") + '">' +
          '<div class="provider-head">' +
            '<div>' +
              '<div class="provider-name">' + esc(provider.name) + '</div>' +
              '<div class="meta">' + esc(provider.apiFormat) + ' / ' + esc(provider.auth) + '</div>' +
            '</div>' +
            '<button data-provider="' + esc(provider.name) + '" data-active="' + (provider.active ? "1" : "0") + '" ' + (provider.active ? "disabled" : "") + '>Use</button>' +
          '</div>' +
          '<div class="meta">' + esc(provider.baseUrl) + '</div>' +
          '<div class="meta">default ' + esc(provider.defaultModel || "(missing)") + '</div>' +
        '</div>'
      ).join("");

      for (const button of document.querySelectorAll("[data-provider]")) {
        button.addEventListener("click", () => useProvider(button.dataset.provider));
      }

      $("proxy").innerHTML = rows([
        ["Config", data.configPath],
        ["Science base URL", data.scienceBaseUrl],
        ["API format", data.provider.apiFormat],
        ["Upstream", data.provider.baseUrl],
        ["Auth source", data.provider.auth],
        ["Default model", data.provider.defaultModel],
        ["Requests", data.stats.requests],
        ["Upstream errors", data.stats.upstreamErrors],
        ["Switches", data.stats.switches],
        ["Doctor runs", data.stats.doctorRuns]
      ]);
      $("request-log").innerHTML = renderLogs(data.recentLogs || []);
    }

    function rows(items) {
      return items.map(([key, value]) =>
        '<div class="row"><div class="key">' + esc(key) + '</div><div class="value">' + esc(value) + '</div></div>'
      ).join("");
    }

    function renderLogs(logs) {
      if (!logs.length) {
        return '<div class="meta">No proxy requests yet.</div>';
      }
      return logs.map((entry) => {
        const model = entry.model ? esc(entry.model) + (entry.mappedModel ? " -> " + esc(entry.mappedModel) : "") : "";
        const detail = entry.error || entry.detail || "";
        return '<div class="row">' +
          '<div class="key">' + esc(entry.kind) + ' / ' + esc(entry.status) + '</div>' +
          '<div class="value">' +
            '<div>' + esc(entry.time) + ' / ' + esc(entry.provider) + ' / ' + esc(entry.latencyMs) + 'ms</div>' +
            '<div class="meta">' + model + (entry.stream ? " / stream" : "") + '</div>' +
            (detail ? '<div class="meta">' + esc(detail) + '</div>' : '') +
          '</div>' +
        '</div>';
      }).join("");
    }

    async function useProvider(provider) {
      setBusy(true);
      try {
        await json("/admin/use", { method: "POST", body: JSON.stringify({ provider, persist: true }) });
        await load();
      } catch (error) {
        $("doctor-output").innerHTML = '<span class="error">' + esc(error.message) + '</span>';
      } finally {
        setBusy(false);
      }
    }

    async function runDoctor() {
      setBusy(true);
      $("doctor-output").textContent = "Running...";
      try {
        const result = await json("/admin/doctor", { method: "POST", body: "{}" });
        $("doctor-output").textContent = JSON.stringify(result, null, 2);
        await load();
      } catch (error) {
        $("doctor-output").innerHTML = '<span class="error">' + esc(error.message) + '</span>';
      } finally {
        setBusy(false);
      }
    }

    function setBusy(value) {
      state.busy = value;
      for (const button of document.querySelectorAll("button")) {
        if (value) {
          button.dataset.wasDisabled = button.disabled ? "1" : "0";
          button.disabled = true;
        } else {
          button.disabled = button.dataset.wasDisabled === "1" || button.dataset.active === "1";
          delete button.dataset.wasDisabled;
        }
      }
    }

    $("reload").addEventListener("click", load);
    $("doctor").addEventListener("click", runDoctor);
    load().catch((error) => {
      $("doctor-output").innerHTML = '<span class="error">' + esc(error.message) + '</span>';
    });
  </script>
</body>
</html>`;
}

function localModelsPayload(provider) {
  const directory = compileModelDirectory(provider.models);
  const rows = provider.models.exposeAliases === true
    ? exposeAliasModelRows(directory)
    : directory.visibleEntries;
  const data = rows.map((entry) => {
    const displayName = entry.displayName;
    const tokenLimits = modelTokenLimits(entry.upstreamModel);
    return {
      id: entry.scienceId,
      type: "model",
      display_name: displayName,
      name: displayName,
      label: displayName,
      created_at: "2026-07-02T00:00:00Z",
      max_input_tokens: tokenLimits.input,
      max_output_tokens: tokenLimits.output,
    };
  });
  return {
    data,
    first_id: data[0]?.id || null,
    last_id: data.at(-1)?.id || null,
    has_more: directory.hiddenUpstreamModels.length > 0,
  };
}

function compileModelDirectory(models = {}) {
  const displayNames = plainObject(models.displayNames) || {};
  const visibleEntries = [];
  const hiddenUpstreamModels = [];
  const routes = new Map();
  const entriesByUpstream = new Map();
  const usedScienceIds = new Set();
  const upstreamOrder = orderedUpstreamModels(models);
  const fallbackUnknownToDefault =
    models.fallbackUnknownToDefault === true ||
    models.allowUnknownModelFallback === true;

  const reserveRoute = (scienceId, upstreamModel, reason) => {
    if (!scienceId || !upstreamModel || routes.has(scienceId)) {
      return;
    }
    routes.set(scienceId, {
      model: upstreamModel,
      reason,
      displayName:
        nonEmptyString(displayNames[scienceId], displayNames[upstreamModel]) ||
        (scienceId === upstreamModel ? upstreamModel : `${scienceId} -> ${upstreamModel}`),
    });
  };

  const nextScienceId = (preferred = [], fallback = SCIENCE_ALIAS_PRIORITY) => {
    const candidates = Array.isArray(preferred) ? preferred : [preferred];
    for (const candidate of candidates) {
      if (candidate && !usedScienceIds.has(candidate)) {
        return candidate;
      }
    }
    for (const candidate of fallback) {
      if (!usedScienceIds.has(candidate)) {
        return candidate;
      }
    }
    return "";
  };

  const addVisible = (
    upstreamModel,
    preferredScienceId,
    reason,
    fallbackScienceIds = SCIENCE_ALIAS_PRIORITY,
  ) => {
    const upstream = nonEmptyString(upstreamModel);
    if (!upstream) {
      return null;
    }
    const existing = entriesByUpstream.get(upstream);
    if (existing) {
      reserveRoute(preferredScienceId, upstream, `alias:${reason}`);
      return existing;
    }
    const scienceId = nextScienceId(preferredScienceId, fallbackScienceIds);
    if (!scienceId) {
      hiddenUpstreamModels.push(upstream);
      reserveRoute(upstream, upstream, "upstream:hidden");
      return null;
    }
    usedScienceIds.add(scienceId);
    const displayName =
      nonEmptyString(displayNames[scienceId], displayNames[upstream], models.displayName) ||
      upstream;
    const entry = {
      scienceId,
      upstreamModel: upstream,
      displayName,
      reason,
    };
    visibleEntries.push(entry);
    entriesByUpstream.set(upstream, entry);
    reserveRoute(scienceId, upstream, `visible:${reason}`);
    reserveRoute(upstream, upstream, "upstream");
    return entry;
  };

  for (const [role, scienceId] of [
    ["opus", SCIENCE_ROLE_ALIAS.opus],
    ["sonnet", SCIENCE_ROLE_ALIAS.sonnet],
    ["haiku", SCIENCE_ROLE_ALIAS.haiku],
    ["fable", SCIENCE_ROLE_ALIAS.fable],
  ]) {
    addVisible(
      models[role],
      roleScienceIdCandidates(role, scienceId),
      `role:${role}`,
      roleScienceIdCandidates(role, scienceId),
    );
  }

  const defaultTarget = nonEmptyString(
    models.default,
    models.opus,
    models.sonnet,
    upstreamOrder[0],
  );
  const defaultEntry = addVisible(
    defaultTarget,
    roleScienceIdCandidates("default", SCIENCE_ROLE_ALIAS.default),
    "default",
    SCIENCE_EXTRA_ALIAS_PRIORITY,
  );

  for (const upstream of upstreamOrder) {
    addVisible(upstream, "", "catalog", SCIENCE_EXTRA_ALIAS_PRIORITY);
  }

  const exact = plainObject(models.exact) || {};
  for (const [source, target] of Object.entries(exact)) {
    reserveRoute(source, target, "exact");
  }

  for (const alias of CLAUDE_ALIASES) {
    const roleTarget = roleTargetForClaudeAlias(alias, models);
    if (roleTarget) {
      reserveRoute(alias, roleTarget, `role:${claudeAliasRole(alias)}`);
    }
  }

  if (!visibleEntries.length) {
    const entry = {
      scienceId: "claude-opus-4-8",
      upstreamModel: "claude-opus-4-8",
      displayName: nonEmptyString(displayNames["claude-opus-4-8"], models.displayName) || "claude-opus-4-8",
      reason: "fallback",
    };
    visibleEntries.push(entry);
    reserveRoute(entry.scienceId, entry.upstreamModel, "fallback");
  }

  if (defaultEntry) {
    const index = visibleEntries.indexOf(defaultEntry);
    if (index > 0) {
      visibleEntries.splice(index, 1);
      visibleEntries.unshift(defaultEntry);
    }
  }

  return {
    visibleEntries,
    hiddenUpstreamModels,
    routes,
    defaultEntry: defaultEntry || visibleEntries[0] || null,
    fallbackUnknownToDefault,
  };
}

function roleScienceIdCandidates(role, primary) {
  const dated = {
    default: ["claude-opus-4-8"],
    opus: ["claude-opus-4-8", "claude-opus-4-8-20251201"],
    sonnet: ["claude-sonnet-4-6", "claude-sonnet-4-6-20251101"],
    haiku: ["claude-haiku-4-5", "claude-haiku-4-5-20251001"],
    fable: ["claude-fable-5", "claude-fable-5-20260609"],
  };
  return dated[role] || [primary].filter(Boolean);
}

function exposeAliasModelRows(directory) {
  const rows = [];
  const seen = new Set();
  const add = (scienceId, upstreamModel, displayName) => {
    if (!scienceId || seen.has(scienceId)) {
      return;
    }
    seen.add(scienceId);
    rows.push({ scienceId, upstreamModel, displayName });
  };
  for (const entry of directory.visibleEntries) {
    add(entry.scienceId, entry.upstreamModel, entry.displayName);
  }
  for (const [scienceId, route] of directory.routes.entries()) {
    add(scienceId, route.model, route.displayName);
  }
  return rows;
}

function orderedUpstreamModels(models = {}) {
  const ids = new Set();
  for (const key of ["default", "haiku", "sonnet", "opus", "fable"]) {
    if (models[key]) {
      ids.add(models[key]);
    }
  }
  for (const value of Object.values(models.exact || {})) {
    if (value) {
      ids.add(value);
    }
  }
  for (const value of models.allowed || []) {
    if (value) {
      ids.add(value);
    }
  }
  return [...ids];
}

function roleTargetForClaudeAlias(alias, models = {}) {
  const role = claudeAliasRole(alias);
  if (role === "fable") {
    return nonEmptyString(models.fable, models.opus, models.default);
  }
  return role ? nonEmptyString(models[role], models.default) : "";
}

function claudeAliasRole(alias) {
  const lower = String(alias || "").toLowerCase();
  if (!isClaudeFamily(lower)) {
    return "";
  }
  if (lower.includes("haiku")) return "haiku";
  if (lower.includes("sonnet")) return "sonnet";
  if (lower.includes("opus")) return "opus";
  if (lower.includes("fable")) return "fable";
  return "";
}

function modelTokenLimits(upstreamModel) {
  const id = String(upstreamModel || "").toLowerCase();
  if (id.startsWith("gpt-")) {
    return { input: 272000, output: 128000 };
  }
  if (id.includes("qwen") || id.includes("deepseek") || id.includes("kimi")) {
    return { input: 128000, output: 64000 };
  }
  return { input: 200000, output: 64000 };
}

function estimateTokenCount(body) {
  const size = JSON.stringify(body || {}).length;
  return { input_tokens: Math.max(1, Math.ceil(size / 4)) };
}

async function doctor(runtime, flags) {
  const result = await doctorDetails(runtime, flags);
  console.log(`config: ${result.configPath}`);
  console.log(
    `provider: ${result.provider.name} (${result.provider.apiFormat})`,
  );
  console.log(`upstream: ${result.provider.baseUrl}`);
  console.log(`api key source: ${result.provider.auth}`);
  console.log(
    `model mapping: ${result.model.requested} -> ${result.model.mapped}`,
  );
  for (const check of result.checks) {
    const target = check.path || check.name || check.layer;
    const method = check.method ? `${check.method} ` : "";
    console.log(
      `[${check.layer}] ${method}${target}: ${check.ok ? "ok" : "failed"} (${check.latencyMs}ms)`,
    );
  }
  console.log(`reply: ${result.reply}`);
}

async function doctorDetails(runtime, flags) {
  const started = Date.now();
  const { provider } = runtime;
  const requestedModel = String(flags.model || "claude-opus-4-8");
  const mappedModel = mapModel(requestedModel, provider.models);
  const base = {
    ok: true,
    configPath: runtime.configPath,
    provider: providerSummary(provider, true),
    model: {
      requested: requestedModel,
      mapped: mappedModel,
    },
    checks: [
      {
        layer: "config",
        name: "provider",
        ok: true,
        status: 200,
        latencyMs: 0,
        detail: `${provider.name} (${provider.apiFormat})`,
      },
      {
        layer: "routing",
        name: requestedModel,
        ok: true,
        status: 200,
        latencyMs: 0,
        detail: `${requestedModel} -> ${mappedModel}`,
      },
    ],
    reply: "",
  };

  if (provider.apiFormat === "anthropic") {
    const result = await doctorAnthropic(provider, mappedModel, base);
    result.latencyMs = Date.now() - started;
    return result;
  }
  if (provider.apiFormat === "openai_chat") {
    const result = await doctorOpenAIChat(provider, mappedModel, base);
    result.latencyMs = Date.now() - started;
    return result;
  }
  if (provider.apiFormat === "openai_responses") {
    const result = await doctorOpenAIResponses(provider, mappedModel, base);
    result.latencyMs = Date.now() - started;
    return result;
  }
  if (provider.apiFormat === "gemini_native") {
    const result = await doctorGeminiNative(provider, mappedModel, base);
    result.latencyMs = Date.now() - started;
    return result;
  }
  throw new Error(`unsupported apiFormat "${provider.apiFormat}"`);
}

async function doctorAnthropic(provider, model, result) {
  const modelsUrl = joinUpstreamUrl(provider.baseUrl, "/v1/models");
  let started = Date.now();
  const modelsResp = await fetchWithTimeout(
    modelsUrl,
    { headers: buildAnthropicHeaders(provider, {}) },
    provider.timeoutMs,
  );
  result.checks.push({
    layer: "upstream_models",
    method: "GET",
    path: "/v1/models",
    ok: modelsResp.ok,
    status: modelsResp.status,
    latencyMs: Date.now() - started,
  });
  if (!modelsResp.ok) {
    throw new Error(
      `models check failed: ${redact(await modelsResp.text(), [provider.apiKey])}`,
    );
  }

  const messageUrl = joinUpstreamUrl(provider.baseUrl, "/v1/messages");
  started = Date.now();
  const messageResp = await fetchWithTimeout(
    messageUrl,
    {
      method: "POST",
      headers: buildAnthropicHeaders(provider, {}),
      body: JSON.stringify({
        model,
        max_tokens: 8,
        messages: [{ role: "user", content: "只回复两个字：通了" }],
      }),
    },
    provider.timeoutMs,
  );
  result.checks.push({
    layer: "upstream_generation",
    method: "POST",
    path: "/v1/messages",
    ok: messageResp.ok,
    status: messageResp.status,
    latencyMs: Date.now() - started,
  });
  const text = await messageResp.text();
  if (!messageResp.ok) {
    throw new Error(`message check failed: ${redact(text, [provider.apiKey])}`);
  }
  const json = JSON.parse(text);
  result.reply = extractAnthropicText(json).slice(0, 80);
  return result;
}

async function doctorOpenAIChat(provider, model, result) {
  const modelsUrl = joinUpstreamUrl(provider.baseUrl, "/v1/models");
  let started = Date.now();
  const modelsResp = await fetchWithTimeout(
    modelsUrl,
    { headers: buildOpenAIHeaders(provider) },
    provider.timeoutMs,
  );
  result.checks.push({
    layer: "upstream_models",
    method: "GET",
    path: "/v1/models",
    ok: modelsResp.ok,
    status: modelsResp.status,
    latencyMs: Date.now() - started,
  });
  if (!modelsResp.ok) {
    throw new Error(
      `models check failed: ${redact(await modelsResp.text(), [provider.apiKey])}`,
    );
  }

  const chatUrl = joinUpstreamUrl(provider.baseUrl, "/v1/chat/completions");
  started = Date.now();
  const chatResp = await fetchWithTimeout(
    chatUrl,
    {
      method: "POST",
      headers: buildOpenAIHeaders(provider),
      body: JSON.stringify({
        model,
        max_tokens: 8,
        messages: [{ role: "user", content: "只回复两个字：通了" }],
      }),
    },
    provider.timeoutMs,
  );
  result.checks.push({
    layer: "upstream_generation",
    method: "POST",
    path: "/v1/chat/completions",
    ok: chatResp.ok,
    status: chatResp.status,
    latencyMs: Date.now() - started,
  });
  const text = await chatResp.text();
  if (!chatResp.ok) {
    throw new Error(`chat check failed: ${redact(text, [provider.apiKey])}`);
  }
  const json = JSON.parse(text);
  result.reply = String(json.choices?.[0]?.message?.content || "").slice(0, 80);
  return result;
}

async function doctorOpenAIResponses(provider, model, result) {
  const modelsUrl = joinUpstreamUrl(provider.baseUrl, "/v1/models");
  let started = Date.now();
  const modelsResp = await fetchWithTimeout(
    modelsUrl,
    { headers: buildOpenAIHeaders(provider) },
    provider.timeoutMs,
  );
  result.checks.push({
    layer: "upstream_models",
    method: "GET",
    path: "/v1/models",
    ok: modelsResp.ok,
    status: modelsResp.status,
    latencyMs: Date.now() - started,
  });
  if (!modelsResp.ok) {
    throw new Error(
      `models check failed: ${redact(await modelsResp.text(), [provider.apiKey])}`,
    );
  }

  const responsesUrl = joinUpstreamUrl(provider.baseUrl, "/v1/responses");
  started = Date.now();
  const response = await fetchWithTimeout(
    responsesUrl,
    {
      method: "POST",
      headers: buildOpenAIHeaders(provider),
      body: JSON.stringify({
        model,
        max_output_tokens: 8,
        input: [
          {
            role: "user",
            content: [{ type: "input_text", text: "只回复两个字：通了" }],
          },
        ],
      }),
    },
    provider.timeoutMs,
  );
  result.checks.push({
    layer: "upstream_generation",
    method: "POST",
    path: "/v1/responses",
    ok: response.ok,
    status: response.status,
    latencyMs: Date.now() - started,
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `responses check failed: ${redact(text, [provider.apiKey])}`,
    );
  }
  const json = JSON.parse(text);
  result.reply = extractResponsesText(json).slice(0, 80);
  return result;
}

async function doctorGeminiNative(provider, model, result) {
  const modelsUrl = geminiModelsUrl(provider.baseUrl);
  let started = Date.now();
  const modelsResp = await fetchWithTimeout(
    modelsUrl,
    { headers: buildGeminiHeaders(provider) },
    provider.timeoutMs,
  );
  result.checks.push({
    layer: "upstream_models",
    method: "GET",
    path: new URL(modelsUrl).pathname,
    ok: modelsResp.ok,
    status: modelsResp.status,
    latencyMs: Date.now() - started,
  });
  if (!modelsResp.ok) {
    throw new Error(
      `models check failed: ${redact(await modelsResp.text(), [provider.apiKey])}`,
    );
  }

  const generateUrl = geminiGenerateContentUrl(provider.baseUrl, model, false);
  started = Date.now();
  const response = await fetchWithTimeout(
    generateUrl,
    {
      method: "POST",
      headers: buildGeminiHeaders(provider),
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: "只回复两个字：通了" }] }],
        generationConfig: { maxOutputTokens: 8 },
      }),
    },
    provider.timeoutMs,
  );
  result.checks.push({
    layer: "upstream_generation",
    method: "POST",
    path: new URL(generateUrl).pathname,
    ok: response.ok,
    status: response.status,
    latencyMs: Date.now() - started,
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`gemini check failed: ${redact(text, [provider.apiKey])}`);
  }
  const json = JSON.parse(text);
  result.reply = extractGeminiText(json).slice(0, 80);
  return result;
}

function extractAnthropicText(json) {
  return (json.content || [])
    .filter((block) => block.type === "text")
    .map((block) => block.text || "")
    .join("");
}

function extractResponsesText(json) {
  return (
    (json.output || [])
      .flatMap((item) => item.content || [])
      .filter((block) => block.type === "output_text")
      .map((block) => block.text || "")
      .join("") || String(json.output_text || "")
  );
}

function extractGeminiText(json) {
  return (json.candidates?.[0]?.content?.parts || [])
    .map((part) => part.text || "")
    .join("");
}

async function scienceSmoke(runtime, flags) {
  const scienceBin = String(
    flags.scienceBin || "/Users/cai/.claude-science/bin/claude-science",
  );
  const smokeMs = Number(flags.smokeMs || (flags.probeMessage ? 60000 : 15000));
  const holdMs = Number(
    flags.holdMs === undefined ? DEFAULT_HOLD_MS : flags.holdMs,
  );
  if (!Number.isInteger(smokeMs) || smokeMs < 3000) {
    throw new Error(`invalid smoke-ms: ${flags.smokeMs}`);
  }
  if (!Number.isInteger(holdMs) || holdMs < 0) {
    throw new Error(`invalid hold-ms: ${flags.holdMs}`);
  }
  if (!fs.existsSync(scienceBin)) {
    throw new Error(`Claude Science CLI not found: ${scienceBin}`);
  }
  if (flags.allowSmokeExternal) {
    console.log(
      "science-smoke: warning external Claude/Anthropic/MCP stubs are disabled",
    );
  }

  console.log("science-smoke: starting loopback proxy");
  if (!flags.adminToken) {
    flags.adminToken = `smoke-admin-${crypto.randomBytes(16).toString("hex")}`;
  }
  const server = await serve(runtime, flags);
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cs-switch-smoke-"));
  const baseUrl = `http://127.0.0.1:${runtime.server.port}`;
  const clientToken = runtime.server.clientToken || DEFAULT_CLIENT_TOKEN;
  const paths = prepareScienceTempProfile(tempRoot, {
    clientToken,
    provider: runtime.provider,
    tempOauthToken: Boolean(flags.tempOauthToken),
  });
  const secrets = [runtime.provider.apiKey, clientToken];
  let child = null;
  let probe = null;

  try {
    console.log(`science-smoke: proxy ready ${baseUrl}`);
    const ready = readyPayload(runtime);
    console.log(`science-smoke: ready checks ${ready.ok ? "ok" : "failed"}`);
    if (!ready.ok) {
      console.log(JSON.stringify(ready, null, 2));
    }

    child = spawn(
      scienceBin,
      [
        "serve",
        "--data-dir",
        paths.dataDir,
        "--config",
        paths.configPath,
        "--no-browser",
        "--no-auto-update",
        "--port",
        "0",
        "--sandbox-port",
        "0",
      ],
      {
        env: buildScienceProcessEnv(paths, baseUrl, clientToken, {
          preloadTrace: Boolean(flags.preloadTrace),
          tempOauthToken: Boolean(flags.tempOauthToken),
          stubExternalServices: !flags.allowSmokeExternal,
        }),
        cwd: tempRoot,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    const signal = await waitForScienceSignal(child, smokeMs, secrets);
    if (flags.probeMessage && signal.webUrl) {
      probe = await probeScienceMessage(
        signal.webUrl,
        baseUrl,
        flags.adminToken,
        secrets,
        {
          model: String(flags.model || "claude-haiku-4-5"),
          timeoutMs: Math.max(15000, Math.min(smokeMs, 90000)),
        },
      );
    }

    console.log(`science-smoke: temp profile ${tempRoot}`);
    console.log(
      `science-smoke: temp OAuth token ${paths.tempOauthToken ? "created" : "not created"}`,
    );
    console.log(
      `science-smoke: Claude Science web URL ${signal.webUrl || "(not observed)"}`,
    );
    console.log(
      `science-smoke: Bun preload ${signal.preloadLoaded ? "loaded" : "not observed"}`,
    );
    console.log(
      `science-smoke: preload trace events ${signal.preloadTraceEvents}`,
    );
    console.log(
      `science-smoke: Keychain fallback ${signal.keychainFallback ? "observed" : "not observed"}`,
    );
    console.log(
      `science-smoke: auth resolver warning ${signal.authFailure ? "observed" : "not observed"}`,
    );
    if (flags.probeMessage) {
      if (probe?.ok) {
        console.log(`science-smoke: message probe ok frame=${probe.frameId}`);
        console.log(
          `science-smoke: message probe route ${probe.route.kind}:${probe.route.status}:${probe.route.path} ${probe.route.model || "(missing)"} -> ${probe.route.mappedModel || "(missing)"}`,
        );
      } else {
        console.log(
          `science-smoke: message probe failed ${probe?.error || "no Claude Science web URL"}`,
        );
      }
    }
    if (signal.exit) {
      console.log(
        `science-smoke: child exited code=${signal.exit.code ?? "null"} signal=${signal.exit.signal ?? "null"}`,
      );
    }
    if (signal.logTail) {
      console.log("science-smoke: log tail");
      console.log(signal.logTail);
    }
    if (flags.preloadTrace && signal.preloadTraceSample) {
      console.log("science-smoke: preload trace sample");
      console.log(signal.preloadTraceSample);
    }
    await printScienceSmokeProxyActivity(baseUrl, flags.adminToken, secrets);

    if (
      !signal.webUrl ||
      !ready.ok ||
      signal.reason === "spawn_error" ||
      signal.reason === "early_exit"
    ) {
      process.exitCode = 1;
    }
    if (flags.probeMessage && !probe?.ok) {
      process.exitCode = 1;
    }
    if (signal.authFailure) {
      console.log(
        "science-smoke: Science started, but its credential resolver did not accept the proxy token. Next safe step is a temp artifact resolver fallback, not the real login profile.",
      );
    }

    if (
      flags.hold &&
      child &&
      signal.webUrl &&
      ready.ok &&
      signal.reason !== "spawn_error" &&
      signal.reason !== "early_exit" &&
      !signal.exit
    ) {
      const ttlLabel = holdMs > 0 ? ` or after ${holdMs}ms` : "";
      console.log(
        `science-smoke: holding live session; send SIGINT or SIGTERM to stop${ttlLabel}`,
      );
      const held = await waitForHoldEnd(child, holdMs);
      if (held.reason === "child_exit") {
        console.log(
          `science-smoke: child exited while holding code=${held.exit.code ?? "null"} signal=${held.exit.signal ?? "null"}`,
        );
      } else if (held.reason === "timeout") {
        console.log("science-smoke: hold TTL reached, stopping");
      } else {
        console.log(`science-smoke: received ${held.exit.signal}, stopping`);
      }
    }

    await stopChild(child);
    child = null;
  } finally {
    if (child) {
      await stopChild(child);
    }
    await closeServer(server);
    if (flags.keepTemp) {
      console.log(`science-smoke: kept temp profile ${tempRoot}`);
    } else {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  }
}

async function waitForHoldEnd(child, holdMs = DEFAULT_HOLD_MS) {
  return await new Promise((resolve) => {
    let settled = false;
    const timer =
      holdMs > 0
        ? setTimeout(() => finish("timeout", { code: null, signal: "TTL" }), holdMs)
        : null;
    const finish = (reason, exit) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      child.off("exit", onChildExit);
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
      resolve({ reason, exit });
    };
    const onChildExit = (code, signal) =>
      finish("child_exit", { code, signal });
    const onSigint = () => finish("signal", { code: null, signal: "SIGINT" });
    const onSigterm = () =>
      finish("signal", { code: null, signal: "SIGTERM" });
    child.once("exit", onChildExit);
    process.once("SIGINT", onSigint);
    process.once("SIGTERM", onSigterm);
  });
}

function printScienceEnv(runtime, flags) {
  console.log(buildScienceEnv(runtime, flags));
}

function buildScienceEnv(runtime, flags) {
  const port = Number(flags.port || runtime.server.port);
  const scienceBin =
    flags.scienceBin || "/Users/cai/.claude-science/bin/claude-science";
  const baseUrl = `http://127.0.0.1:${port}`;
  const clientToken = runtime.server.clientToken || DEFAULT_CLIENT_TOKEN;

  return `# This recipe is intentionally isolated from ~/.claude-science.
# Start the proxy first:
#   node ${relativeBinPath()} serve --config ${path.relative(process.cwd(), runtime.configPath) || runtime.configPath}

CS_ROOT="$(mktemp -d "\${TMPDIR:-/tmp}/cs-loopback-test.XXXXXX")"
mkdir -p "$CS_ROOT/home" "$CS_ROOT/xdg-config" "$CS_ROOT/xdg-data" "$CS_ROOT/xdg-cache" "$CS_ROOT/tmp" "$CS_ROOT/data"
cat > "$CS_ROOT/config.toml" <<'TOML'
${scienceConfigToml(runtime.provider)}
TOML
cat > "$CS_ROOT/bunfig.toml" <<'TOML'
preload = ["./preload.js"]
TOML
cat > "$CS_ROOT/preload.js" <<'JS'
${sciencePreloadJs()}
JS

cd "$CS_ROOT"
env -i \\
  HOME="$CS_ROOT/home" \\
  XDG_CONFIG_HOME="$CS_ROOT/xdg-config" \\
  XDG_DATA_HOME="$CS_ROOT/xdg-data" \\
  XDG_CACHE_HOME="$CS_ROOT/xdg-cache" \\
  TMPDIR="$CS_ROOT/tmp" \\
  PATH="/usr/bin:/bin:/usr/sbin:/sbin:/Users/cai/.local/bin:/opt/homebrew/bin" \\
  NO_PROXY="127.0.0.1,localhost" \\
  CS_PRELOAD_TRACE="${flags.preloadTrace ? "1" : "0"}" \\
  CS_STUB_EXTERNAL_SERVICES="${flags.allowSmokeExternal ? "0" : "1"}" \\
  CS_PROXY_BASE_URL="${baseUrl}" \\
  CS_PROXY_TOKEN="${clientToken}" \\
  ANTHROPIC_BASE_URL="${baseUrl}" \\
  ANTHROPIC_AUTH_TOKEN="${clientToken}" \\
  ANTHROPIC_API_KEY="${clientToken}" \\
  "${scienceBin}" serve \\
    --data-dir "$CS_ROOT/data" \\
    --config "$CS_ROOT/config.toml" \\
    --no-browser \\
    --no-auto-update \\
    --port 0 \\
    --sandbox-port 0`;
}

function prepareScienceTempProfile(tempRoot, options = {}) {
  const paths = {
    home: path.join(tempRoot, "home"),
    xdgConfig: path.join(tempRoot, "xdg-config"),
    xdgData: path.join(tempRoot, "xdg-data"),
    xdgCache: path.join(tempRoot, "xdg-cache"),
    tmp: path.join(tempRoot, "tmp"),
    dataDir: path.join(tempRoot, "data"),
    authDir: path.join(tempRoot, "home", ".claude-science"),
    configPath: path.join(tempRoot, "config.toml"),
    tempOauthToken: false,
  };
  assertIsolatedScienceProfile(paths, tempRoot);
  for (const dir of [
    paths.home,
    paths.xdgConfig,
    paths.xdgData,
    paths.xdgCache,
    paths.tmp,
    paths.dataDir,
  ]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(paths.configPath, `${scienceConfigToml(options.provider)}\n`);
  if (options.tempOauthToken) {
    const encryptionKeys = writeScienceTempEncryptionKey(paths);
    writeScienceTempOAuthToken(paths, {
      clientToken: options.clientToken || DEFAULT_CLIENT_TOKEN,
      oauthKey: encryptionKeys.oauth,
    });
    paths.tempOauthToken = true;
  }
  fs.writeFileSync(
    path.join(tempRoot, "bunfig.toml"),
    'preload = ["./preload.js"]\n',
  );
  fs.writeFileSync(path.join(tempRoot, "preload.js"), sciencePreloadJs());
  return paths;
}

function assertIsolatedScienceProfile(paths, tempRoot) {
  const resolvedRoot = path.resolve(tempRoot);
  const resolvedHome = path.resolve(paths.home);
  const resolvedAuth = path.resolve(paths.authDir);
  const realHomeAuth = path.resolve(os.homedir(), ".claude-science");
  if (!resolvedHome.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error("refusing Science launch: HOME is not inside temp profile");
  }
  if (resolvedAuth === realHomeAuth || resolvedAuth.startsWith(`${realHomeAuth}${path.sep}`)) {
    throw new Error("refusing Science launch: auth dir points at real ~/.claude-science");
  }
  if (resolvedAuth !== path.resolve(resolvedHome, ".claude-science")) {
    throw new Error("refusing Science launch: auth dir is not under isolated HOME");
  }
}

function sciencePreloadJs() {
  return `const trace = process.env.CS_PRELOAD_TRACE === "1";
const traceLimit = Number(process.env.CS_PRELOAD_TRACE_LIMIT || 1000);
let traceCount = 0;
const token = process.env.CS_PROXY_TOKEN || "PROXY_MANAGED";
const proxyBaseUrl = process.env.CS_PROXY_BASE_URL || process.env.ANTHROPIC_BASE_URL || "";
const fakeOAuthProfile = process.env.CS_FAKE_OAUTH_PROFILE === "1";
const stubExternalServices = process.env.CS_STUB_EXTERNAL_SERVICES !== "0";
process.env.ANTHROPIC_BASE_URL ||= proxyBaseUrl;
process.env.ANTHROPIC_AUTH_TOKEN ||= token;
process.env.ANTHROPIC_API_KEY ||= process.env.ANTHROPIC_AUTH_TOKEN;
console.error("[cs-preload] loaded");
console.error("[cs-preload] env " + JSON.stringify({
  anthropicBaseUrl: Boolean(process.env.ANTHROPIC_BASE_URL),
  anthropicAuthToken: Boolean(process.env.ANTHROPIC_AUTH_TOKEN),
  anthropicApiKey: Boolean(process.env.ANTHROPIC_API_KEY),
  externalStubs: stubExternalServices,
  home: Boolean(process.env.HOME),
  dataDir: Boolean(process.env.XDG_DATA_HOME)
}));

function shouldTracePath(value) {
  if (!trace || traceCount >= traceLimit) return false;
  const text = String(value || "");
  if (/oauth|token|credential|key|auth|org|anthropic|claude|science/i.test(text)) {
    return true;
  }
  if (text.includes("/drizzle/sqlite") || text.includes("proj_example") || text.includes("artifacts")) {
    return false;
  }
  return /config|settings|sqlite|db/i.test(text);
}

function traceLog(kind, value) {
  if (!trace || traceCount >= traceLimit) return;
  traceCount += 1;
  console.error("[cs-preload] trace " + kind + " " + String(value).slice(0, 500));
}

function describePath(value) {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "href" in value) return value.href;
  if (value && typeof value === "object" && "pathname" in value) return value.pathname;
  return String(value);
}

try {
  const originalFetch = globalThis.fetch;
  if (typeof originalFetch === "function") {
    globalThis.fetch = function(input, init) {
      const next = maybeAuthorizeProxyFetch(input, init);
      const stub = maybeStubScienceExternalFetch(input, next.init);
      if (stub) {
        return Promise.resolve(stub);
      }
      if (trace) {
        const raw = typeof input === "string" ? input : input?.url || input?.href || String(input);
        try {
          const url = new URL(raw, "http://localhost");
          traceLog("fetch", JSON.stringify({
            target: url.origin + url.pathname,
            method: next.method,
            proxyTarget: next.proxyTarget,
            hasAuth: next.hasAuth
          }));
        } catch {
          traceLog("fetch", raw);
        }
      }
      return originalFetch.call(this, next.input, next.init);
    };
  }
} catch (error) {
  traceLog("fetch-hook-error", error?.message || error);
}

function maybeAuthorizeProxyFetch(input, init) {
  const method = String(init?.method || input?.method || "GET").toUpperCase();
  const raw = typeof input === "string" ? input : input?.url || input?.href || "";
  let proxyTarget = false;
  try {
    if (proxyBaseUrl) {
      const requestUrl = new URL(raw, proxyBaseUrl);
      const proxyUrl = new URL(proxyBaseUrl);
      proxyTarget = requestUrl.origin === proxyUrl.origin;
    }
  } catch {}

  const headers = new Headers(init?.headers || input?.headers || {});
  let hasAuth = headers.has("authorization") || headers.has("x-api-key");
  if (proxyTarget && !hasAuth) {
    headers.set("authorization", "Bearer " + token);
    headers.set("x-api-key", token);
    hasAuth = true;
  }
  return {
    input,
    init: proxyTarget ? { ...(init || {}), headers } : init,
    method,
    proxyTarget,
    hasAuth
  };
}

function maybeStubScienceExternalFetch(input, init) {
  const raw = typeof input === "string" ? input : input?.url || input?.href || "";
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const hostname = url.hostname.toLowerCase();
  if (
    fakeOAuthProfile &&
    (hostname === "claude.ai" || hostname === "api.anthropic.com") &&
    url.pathname.startsWith("/api/oauth/")
  ) {
    const headers = new Headers(init?.headers || input?.headers || {});
    if (!headers.has("authorization")) {
      return null;
    }
    return stubOAuthResponse(url);
  }
  if (!stubExternalServices) {
    return null;
  }
  if (hostname === "claude.ai" && url.pathname.startsWith("/api/event_logging/")) {
    traceLog("fetch-stub", JSON.stringify({ target: url.origin + url.pathname, status: 204 }));
    return new Response(null, { status: 204 });
  }
  if (hostname === "pubmed.mcp.claude.com" || hostname === "hcls.mcp.claude.com") {
    traceLog("fetch-stub", JSON.stringify({ target: url.origin + url.pathname, status: 503 }));
    return new Response(JSON.stringify({
      error: "blocked_by_claude_science_switch_smoke",
      message: "external MCP access is disabled during isolated smoke tests"
    }), {
      status: 503,
      headers: { "content-type": "application/json" }
    });
  }
  if (hostname === "claude.ai" || hostname === "api.anthropic.com") {
    traceLog("fetch-stub", JSON.stringify({ target: url.origin + url.pathname, status: 403 }));
    return new Response(JSON.stringify({
      error: {
        type: "blocked_by_claude_science_switch_smoke",
        message: "external Claude service access is disabled during isolated smoke tests"
      }
    }), {
      status: 403,
      headers: { "content-type": "application/json" }
    });
  }
  return null;
}

function stubOAuthResponse(url) {
  const organization = {
    uuid: "local-org",
    name: "Local Science Switch",
    capabilities: ["chat"],
    raven_type: null,
    organization_type: "claude_pro",
    rate_limit_tier: "local",
    seat_tier: "local",
    billing_type: "local",
    has_extra_usage_enabled: true
  };
  const account = {
    uuid: "local-dev",
    email_address: "local-dev@localhost",
    email: "local-dev@localhost",
    display_name: "Local Dev"
  };
  let payload;
  if (url.pathname === "/api/oauth/profile") {
    payload = { account, organization, enabled_plugins: [] };
  } else if (url.pathname === "/api/oauth/account") {
    payload = { memberships: [{ organization }] };
  } else if (url.pathname === "/api/oauth/usage") {
    payload = { usage: [], claude_ai_usage: [], organization_uuid: organization.uuid };
  } else if (url.pathname === "/api/oauth/operon/client_data") {
    payload = { client_data: {} };
  } else if (
    url.pathname.startsWith("/api/oauth/organizations/") &&
    url.pathname.endsWith("/skills/list-skills")
  ) {
    payload = { skills: [] };
  } else if (
    url.pathname.startsWith("/api/oauth/organizations/") &&
    url.pathname.endsWith("/plugins/list-plugins")
  ) {
    payload = { plugins: [] };
  } else {
    payload = {};
  }
  traceLog("fetch-stub", JSON.stringify({ target: url.origin + url.pathname, status: 200 }));
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

try {
  if (globalThis.Bun && typeof globalThis.Bun.file === "function") {
    const originalBunFile = globalThis.Bun.file.bind(globalThis.Bun);
    globalThis.Bun.file = function(file, ...rest) {
      const label = describePath(file);
      if (shouldTracePath(label)) traceLog("bun.file", label);
      return originalBunFile(file, ...rest);
    };
  }
} catch (error) {
  traceLog("bun-file-hook-error", error?.message || error);
}

try {
  const fs = require("node:fs");
  for (const name of ["accessSync", "existsSync", "lstatSync", "mkdirSync", "openSync", "readFileSync", "readdirSync", "statSync", "writeFileSync"]) {
    const original = fs[name];
    if (typeof original !== "function") continue;
    fs[name] = function(path, ...rest) {
      const label = describePath(path);
      if (shouldTracePath(label)) traceLog("fs." + name, label);
      return original.call(this, path, ...rest);
    };
  }
  if (fs.promises) {
    for (const name of ["access", "lstat", "mkdir", "open", "readFile", "readdir", "stat", "writeFile"]) {
      const original = fs.promises[name];
      if (typeof original !== "function") continue;
      fs.promises[name] = function(path, ...rest) {
        const label = describePath(path);
        if (shouldTracePath(label)) traceLog("fs.promises." + name, label);
        return original.call(this, path, ...rest);
      };
    }
  }
} catch (error) {
  traceLog("fs-hook-error", error?.message || error);
}
`;
}

function scienceConfigToml(provider = {}) {
  const models = provider?.models || {};
  const directory = compileModelDirectory(models);
  const defaultTarget = nonEmptyString(
    models.default,
    models.opus,
    models.sonnet,
    "claude-opus-4-8",
  );
  const defaultModel = nonEmptyString(
    scienceModelIdForTarget(defaultTarget, directory),
    directory.defaultEntry?.scienceId,
    defaultTarget,
  );
  const kernelTarget = nonEmptyString(models.haiku, defaultTarget);
  const kernelModel = nonEmptyString(
    scienceModelIdForTarget(kernelTarget, directory),
    defaultModel,
  );
  const lineageTarget = nonEmptyString(models.sonnet, defaultTarget);
  const lineageModel = nonEmptyString(
    scienceModelIdForTarget(lineageTarget, directory),
    defaultModel,
  );
  return [
    `default_model = ${tomlString(defaultModel)}`,
    "",
    "[llm]",
    `kernel_default_model = ${tomlString(kernelModel)}`,
    `lineage_extraction_model = ${tomlString(lineageModel)}`,
  ].join("\n");
}

function scienceModelIdForTarget(target, directory) {
  if (!target) {
    return "";
  }
  return (
    directory.visibleEntries.find((entry) => entry.upstreamModel === target)
      ?.scienceId || ""
  );
}

function tomlString(value) {
  return `"${String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function writeScienceTempOAuthToken(paths, options) {
  const tokenDir = path.join(paths.authDir, ".oauth-tokens");
  fs.mkdirSync(tokenDir, { recursive: true, mode: 0o700 });
  const accountUuid = crypto.randomUUID();
  const orgUuid = crypto.randomUUID();
  const tokenData = {
    access_token: options.clientToken,
    refresh_token: "",
    api_key: null,
    token_expires_at: "2099-01-01T00:00:00.000Z",
    provider: "claude_ai",
    scopes: "user:inference user:file_upload user:profile user:mcp_servers user:plugins",
    email: "local-dev@localhost.invalid",
    account_uuid: accountUuid,
    subscription_type: "max",
    rate_limit_tier: null,
    seat_tier: null,
    org_uuid: orgUuid,
    billing_type: null,
    has_extra_usage_enabled: false,
  };
  const encrypted = encryptScienceTokenV2(
    JSON.stringify(tokenData),
    options.oauthKey,
    "oauth",
  );
  for (const entry of fs.readdirSync(tokenDir)) {
    if (entry.endsWith(".enc")) {
      fs.rmSync(path.join(tokenDir, entry), { force: true });
    }
  }
  const userId = accountUuid.replace(/[^a-zA-Z0-9_-]/g, "");
  fs.writeFileSync(path.join(tokenDir, `${userId}.enc`), encrypted, { mode: 0o600 });
  fs.writeFileSync(
    path.join(paths.authDir, "active-org.json"),
    JSON.stringify({ org_uuid: orgUuid }, null, 2) + "\n",
    { mode: 0o600 },
  );
}

function writeScienceTempEncryptionKey(paths) {
  const keys = {
    anthropicApiKey: crypto.randomBytes(32).toString("base64"),
    oauth: crypto.randomBytes(32).toString("base64"),
    jwt: crypto.randomBytes(32).toString("base64"),
    userSecret: crypto.randomBytes(32).toString("base64"),
  };
  fs.mkdirSync(paths.authDir, { recursive: true, mode: 0o700 });
  const body = [
    `ANTHROPIC_API_KEY_ENCRYPTION_KEY=${keys.anthropicApiKey}`,
    `OAUTH_ENCRYPTION_KEY=${keys.oauth}`,
    `JWT_SIGNING_SECRET=${keys.jwt}`,
    `USER_SECRET_ENCRYPTION_KEY=${keys.userSecret}`,
    "",
  ].join("\n");
  fs.writeFileSync(path.join(paths.authDir, "encryption.key"), body, {
    mode: 0o600,
  });
  return keys;
}

function encryptScienceTokenV2(plaintext, keyBase64, label) {
  const rootKey = Buffer.from(keyBase64, "base64");
  if (rootKey.length < 16) {
    throw new Error("invalid temp OAuth encryption key");
  }
  const key = Buffer.from(
    crypto.hkdfSync(
      "sha256",
      rootKey,
      Buffer.alloc(0),
      `operon:aes-256-gcm:${label}`,
      32,
    ),
  );
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv, {
    authTagLength: 16,
  });
  cipher.setAAD(Buffer.from(`v2:${label}`, "utf8"));
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return `v2:${Buffer.concat([iv, ciphertext, tag]).toString("base64")}`;
}

function buildScienceProcessEnv(paths, baseUrl, clientToken, options = {}) {
  return {
    HOME: paths.home,
    XDG_CONFIG_HOME: paths.xdgConfig,
    XDG_DATA_HOME: paths.xdgData,
    XDG_CACHE_HOME: paths.xdgCache,
    TMPDIR: paths.tmp,
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin:/Users/cai/.local/bin:/opt/homebrew/bin",
    NO_PROXY: "127.0.0.1,localhost",
    CS_PRELOAD_TRACE: options.preloadTrace ? "1" : "0",
    CS_STUB_EXTERNAL_SERVICES:
      options.stubExternalServices === false ? "0" : "1",
    CS_PROXY_BASE_URL: baseUrl,
    CS_PROXY_TOKEN: clientToken,
    ANTHROPIC_BASE_URL: baseUrl,
    ANTHROPIC_AUTH_TOKEN: clientToken,
    ANTHROPIC_API_KEY: clientToken,
    CS_FAKE_OAUTH_PROFILE: options.tempOauthToken ? "1" : "0",
  };
}

async function probeScienceMessage(
  webUrl,
  proxyBaseUrl,
  adminToken,
  secrets,
  options = {},
) {
  const jar = createCookieJar();
  const model = options.model || "claude-haiku-4-5";
  let scienceBase;
  try {
    scienceBase = new URL(webUrl).origin;
  } catch (error) {
    return {
      ok: false,
      error: `invalid Claude Science web URL: ${error.message}`,
    };
  }

  try {
    const login = await fetchWithCookieJar(webUrl, { method: "GET" }, jar, {
      timeoutMs: 5000,
    });
    if (login.status >= 400) {
      throw new Error(`login URL returned ${login.status}`);
    }

    let csrf = jar.get("operon_csrf");
    if (!csrf) {
      const csrfResponse = await fetchWithCookieJar(
        `${scienceBase}/api/csrf`,
        { method: "GET" },
        jar,
        { timeoutMs: 5000 },
      );
      if (!csrfResponse.ok) {
        throw new Error(`csrf endpoint returned ${csrfResponse.status}`);
      }
      csrf = jar.get("operon_csrf");
    }
    if (!csrf) {
      throw new Error("operon_csrf cookie was not set");
    }

    const baseHeaders = {
      "content-type": "application/json",
      origin: scienceBase,
      "x-operon-csrf": csrf,
    };
    const frameResponse = await fetchWithCookieJar(
      `${scienceBase}/api/frames`,
      {
        method: "POST",
        headers: baseHeaders,
        body: JSON.stringify({ project_id: "proj_example" }),
      },
      jar,
      { timeoutMs: 10000 },
    );
    const frameText = await frameResponse.text();
    if (!frameResponse.ok) {
      throw new Error(
        `create frame returned ${frameResponse.status}: ${frameText.slice(0, 300)}`,
      );
    }
    const frame = parseJsonObjectLoose(frameText) || {};
    const frameId = frame.root_frame_id || frame.frame_id || frame.id;
    if (!frameId) {
      throw new Error("create frame response did not include a frame id");
    }

    const messageResponse = await fetchWithCookieJar(
      `${scienceBase}/api/frames/${encodeURIComponent(frameId)}/message`,
      {
        method: "POST",
        headers: baseHeaders,
        body: JSON.stringify({
          input_data: { request: "只回复两个字：通了" },
          model,
          effort: "low",
          thinking: false,
        }),
      },
      jar,
      { timeoutMs: 10000 },
    );
    const messageText = await messageResponse.text();
    if (!messageResponse.ok) {
      throw new Error(
        `send frame message returned ${messageResponse.status}: ${messageText.slice(0, 300)}`,
      );
    }

    const route = await waitForProxyRoute(
      proxyBaseUrl,
      adminToken,
      "messages",
      options.timeoutMs || 60000,
    );
    return { ok: true, frameId, route };
  } catch (error) {
    return { ok: false, error: redact(error.message, secrets) };
  }
}

function createCookieJar() {
  const cookies = new Map();
  return {
    get(name) {
      return cookies.get(name) || "";
    },
    header() {
      return [...cookies.entries()]
        .map(([name, value]) => `${name}=${value}`)
        .join("; ");
    },
    absorb(response) {
      const setCookies =
        typeof response.headers.getSetCookie === "function"
          ? response.headers.getSetCookie()
          : splitSetCookieHeader(response.headers.get("set-cookie"));
      for (const line of setCookies) {
        const pair = String(line).split(";")[0] || "";
        const eq = pair.indexOf("=");
        if (eq <= 0) {
          continue;
        }
        cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
      }
    },
  };
}

function splitSetCookieHeader(header) {
  if (!header) {
    return [];
  }
  return String(header)
    .split(/,(?=\s*[^;,=\s]+=)/g)
    .map((item) => item.trim())
    .filter(Boolean);
}

async function fetchWithCookieJar(url, options, jar, requestOptions = {}) {
  let current = url;
  let method = options.method || "GET";
  let body = options.body;
  for (let redirects = 0; redirects < 6; redirects += 1) {
    const headers = new Headers(options.headers || {});
    const cookie = jar.header();
    if (cookie) {
      headers.set("cookie", cookie);
    }
    const response = await fetch(current, {
      ...options,
      method,
      body,
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(requestOptions.timeoutMs || 10000),
    });
    jar.absorb(response);
    if (![301, 302, 303, 307, 308].includes(response.status)) {
      return response;
    }
    const location = response.headers.get("location");
    if (!location) {
      return response;
    }
    current = new URL(location, current).toString();
    if (
      response.status === 303 ||
      ((response.status === 301 || response.status === 302) && method !== "GET")
    ) {
      method = "GET";
      body = undefined;
    }
  }
  throw new Error(
    "too many redirects while logging into Claude Science smoke daemon",
  );
}

async function waitForProxyRoute(baseUrl, adminToken, kind, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastRoute = null;
  while (Date.now() < deadline) {
    const response = await fetch(`${baseUrl}/admin/state`, {
      headers: { "x-cs-switch-admin": adminToken },
      signal: AbortSignal.timeout(3000),
    });
    if (response.ok) {
      const state = await response.json();
      const logs = Array.isArray(state.recentLogs) ? state.recentLogs : [];
      lastRoute = logs.find((entry) => entry.kind === kind) || lastRoute;
      const okRoute = logs.find(
        (entry) =>
          entry.kind === kind &&
          Number(entry.status) >= 200 &&
          Number(entry.status) < 300,
      );
      if (okRoute) {
        return okRoute;
      }
    }
    await delay(1000);
  }
  const detail = lastRoute
    ? `last ${kind} route status ${lastRoute.status} (${lastRoute.path})`
    : `no ${kind} route observed`;
  throw new Error(
    `proxy did not record a successful ${kind} route within ${timeoutMs}ms: ${detail}`,
  );
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function printScienceSmokeProxyActivity(baseUrl, adminToken, secrets) {
  if (!adminToken) {
    return;
  }
  try {
    const response = await fetch(`${baseUrl}/admin/state`, {
      headers: { "x-cs-switch-admin": adminToken },
      signal: AbortSignal.timeout(2000),
    });
    if (!response.ok) {
      console.log(
        `science-smoke: proxy activity unavailable (${response.status})`,
      );
      return;
    }
    const state = await response.json();
    const logs = Array.isArray(state.recentLogs) ? state.recentLogs : [];
    const counts = logs.reduce((acc, entry) => {
      const key = entry.kind || "unknown";
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {});
    const routed = logs
      .filter((entry) =>
        ["models", "messages", "count_tokens", "error", "auth"].includes(
          entry.kind,
        ),
      )
      .slice(0, 8)
      .map((entry) => `${entry.kind}:${entry.status}:${entry.path}`);
    console.log(`science-smoke: proxy requests ${state.stats?.requests ?? 0}`);
    console.log(
      `science-smoke: proxy recent kinds ${redact(JSON.stringify(counts), secrets)}`,
    );
    if (routed.length > 0) {
      console.log(
        `science-smoke: proxy recent routes ${redact(routed.join(", "), secrets)}`,
      );
    }
  } catch (error) {
    console.log(`science-smoke: proxy activity unavailable (${error.message})`);
  }
}

async function waitForScienceSignal(child, timeoutMs, secrets) {
  return await new Promise((resolve) => {
    let logs = "";
    let webUrl = "";
    let exit = null;
    let resolved = false;
    let readyTimer = null;
    const hardTimer = setTimeout(() => settle("timeout"), timeoutMs);

    const pushLog = (chunk) => {
      logs += chunk.toString("utf8");
      if (logs.length > 120000) {
        logs = logs.slice(-80000);
      }
      const nextWebUrl = bestScienceWebUrl(logs);
      if (nextWebUrl && nextWebUrl !== webUrl) {
        webUrl = nextWebUrl;
        if (readyTimer) {
          clearTimeout(readyTimer);
        }
        readyTimer = setTimeout(
          () => settle("web_url"),
          isScienceLoginUrl(webUrl) ? 1000 : 4000,
        );
      }
    };

    const settle = (reason) => {
      if (resolved) {
        return;
      }
      resolved = true;
      clearTimeout(hardTimer);
      if (readyTimer) {
        clearTimeout(readyTimer);
      }
      const redacted = redact(logs, secrets);
      const traceLines = redacted
        .split(/\r?\n/)
        .filter((line) => line.includes("[cs-preload] trace "));
      resolve({
        reason,
        webUrl,
        exit,
        preloadLoaded:
          /\[cs-preload\] loaded/.test(redacted) || traceLines.length > 0,
        preloadTraceEvents: traceLines.length,
        preloadTraceSample: summarizeTraceLines(traceLines),
        keychainFallback: /keychain|encryption\.key|ensureEncryptionKeys/i.test(
          redacted,
        ),
        authFailure:
          /auth failed|No credentials available|credentials unavailable/i.test(
            redacted,
          ),
        logTail: tailLines(redacted, 40),
      });
    };

    child.stdout.on("data", pushLog);
    child.stderr.on("data", pushLog);
    child.once("error", (error) => {
      logs += `\nspawn error: ${error.message}\n`;
      settle("spawn_error");
    });
    child.once("exit", (code, signal) => {
      exit = { code, signal };
      if (!webUrl) {
        settle("early_exit");
      }
    });
  });
}

function bestScienceWebUrl(text) {
  const matches = [
    ...String(text || "").matchAll(
      /https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])[^"'\s<>)]+/g,
    ),
  ].map((match) => match[0].replace(/[.,;]+$/g, ""));
  if (!matches.length) {
    return "";
  }
  let best = "";
  let bestScore = -1;
  for (const candidate of matches) {
    let score = 0;
    try {
      const url = new URL(candidate);
      if (url.searchParams.has("nonce")) {
        score += 100;
      }
      if (url.pathname === "/" || url.pathname === "") {
        score += 20;
      }
      if (url.pathname === "/mcp_apps") {
        score -= 10;
      }
    } catch {
      continue;
    }
    if (score >= bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return best || matches.at(-1) || "";
}

function isScienceLoginUrl(value) {
  try {
    const url = new URL(value);
    return (
      url.searchParams.has("nonce") ||
      url.pathname === "/" ||
      url.pathname === ""
    );
  } catch {
    return false;
  }
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

async function closeServer(server) {
  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

function tailLines(text, count) {
  return String(text || "")
    .split(/\r?\n/)
    .slice(-count)
    .join("\n")
    .trim();
}

function summarizeTraceLines(lines) {
  if (!lines.length) {
    return "";
  }
  const head = lines.slice(0, 12);
  const tail = lines.length > 18 ? lines.slice(-6) : [];
  return [
    ...head,
    ...(tail.length
      ? [
          `... ${lines.length - head.length - tail.length} trace lines omitted ...`,
        ]
      : []),
    ...tail,
  ]
    .join("\n")
    .trim();
}

function relativeBinPath() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return (
    path.relative(process.cwd(), path.join(here, "claude-science-switch.js")) ||
    "bin/claude-science-switch.js"
  );
}

function redact(text, extraSecrets = []) {
  let out = String(text || "");
  for (const value of [...Object.values(process.env), ...extraSecrets]) {
    if (value && value.length >= 20) {
      out = out.split(value).join("[redacted]");
    }
  }
  out = out.replace(
    /(authorization|x-api-key|api-key)["':\s]+bearer\s+[a-z0-9._-]+/gi,
    "$1: [redacted]",
  );
  out = out.replace(
    /(authorization|x-api-key|api-key)["':\s]+[a-z0-9._-]{20,}/gi,
    "$1: [redacted]",
  );
  return out;
}
