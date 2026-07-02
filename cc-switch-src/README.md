# Claude Science Switch Desktop

This directory is a local desktop shell forked from `cc-switch` and narrowed for
Claude Science provider switching.

The goal is simple:

- keep Claude Science account state untouched;
- route Claude-style requests to explicit API providers;
- make local `cliproxyapi` / `gpt-5.5` easy to start, inspect, and switch;
- avoid managed OAuth, Keychain, ChatGPT/Copilot/Gemini CLI, and official-account
  credential paths by default.

## Current Shape

- Visible app surface is focused on Claude Science.
- The Settings auth and usage tabs are removed from the UI.
- Managed official-account providers are blocked in UI actions, provider switch,
  proxy takeover, forwarding, and connectivity checks.
- The tray menu is restricted to the Claude section.
- The bundled resource set includes the local switch engine:
  - `claude-science-switch/bin/claude-science-switch`
  - `claude-science-switch/bin/claude-science-switch.js`
  - `claude-science-switch/examples/cliproxy-gpt55.json`
  - `claude-science-switch/examples/cc-switch-provider-openai-chat.json`
  - `claude-science-switch/examples/multi-provider.json`
  - `claude-science-switch/package.json`

## Supported Provider API Formats

The bundled local switch engine supports:

- `anthropic`
- `openai_chat`
- `openai_responses`
- `gemini_native`

See the root project README and `../examples/multi-provider.json` for provider
config examples.

## Local Development

From this directory:

```bash
./node_modules/.bin/tsc --noEmit
./node_modules/.bin/vitest run
```

Run the Tauri shell in development:

```bash
./node_modules/.bin/tauri dev
```

The normal `pnpm tauri ...` wrapper may be blocked by local pnpm build-script
approval policy. Calling `./node_modules/.bin/tauri` directly avoids that wrapper.

## Build

Build the macOS DMG:

```bash
./node_modules/.bin/tauri build --bundles dmg --config '{"build":{"beforeBuildCommand":"./node_modules/.bin/vite build"}}'
```

The current macOS artifact is produced at:

```text
src-tauri/target/release/bundle/dmg/Claude Science Switch_3.16.5_aarch64.dmg
```

The app bundles a Bun-compiled native `claude-science-switch` proxy executable
and keeps the JavaScript source as a fallback. The desktop shell prefers the
native proxy and only falls back to JS when the native resource is missing.

From the repository root, run the release smoke/packaging verifier:

```bash
npm run verify:dmg
```

It mounts the DMG, checks bundled resources, runs
`Contents/MacOS/cc-switch --science-proxy-managed-smoke`, verifies codesign and
URL schemes, and runs the bundled proxy doctor. Set `SKIP_UPSTREAM_DOCTOR=1` if
the machine does not have local `cliproxyapi`.

## Safety Notes

This fork is deliberately conservative:

- it does not patch `/Applications/Claude Science.app`;
- it does not modify the real logged-in Claude Science profile for smoke tests;
- it does not read or write real Claude account tokens for provider routing;
- official quota/account lookup code is disabled or unreachable from the current
  UI and execution paths;
- provider configs should use explicit API keys and base URLs.
- an online proxy on the configured port is treated as external unless it was
  started by the desktop shell; launching Claude Science verifies the managed
  child process before opening the isolated UI.
- the Science Proxy panel has a self-check for the loopback URL, bundled proxy
  resources, config templates, Claude Science CLI, isolated profile path, port
  ownership, and the default `cliproxyapi` upstream.

If a user sees a macOS Keychain warning during isolated smoke tests, it should be
from the temporary test profile, not the real Claude Science account profile.

## Useful Checks

Root switch engine:

```bash
cd ..
node --check bin/claude-science-switch.js
npm test --silent
npm run --silent check
node bin/claude-science-switch.js doctor --config examples/cliproxy-gpt55.json
```

Desktop shell:

```bash
./node_modules/.bin/tsc --noEmit
./node_modules/.bin/vitest run tests/hooks/useProviderActions.test.tsx tests/components/ProviderList.test.tsx
cd src-tauri && cargo check
```
