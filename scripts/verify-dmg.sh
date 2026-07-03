#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DMG_PATH="${1:-"$ROOT_DIR/cc-switch-src/src-tauri/target/release/bundle/dmg/Claude Science Switch_0.1.0_aarch64.dmg"}"
MOUNT_DIR="$(mktemp -d /tmp/claude-science-switch-dmg.XXXXXX)"

cleanup() {
  hdiutil detach "$MOUNT_DIR" >/dev/null 2>&1 || true
  rmdir "$MOUNT_DIR" >/dev/null 2>&1 || true
}
trap cleanup EXIT

if [[ ! -f "$DMG_PATH" ]]; then
  echo "DMG not found: $DMG_PATH" >&2
  exit 1
fi

echo "[verify] hdiutil verify"
hdiutil verify "$DMG_PATH" >/dev/null

echo "[verify] attach"
hdiutil attach -readonly -nobrowse -mountpoint "$MOUNT_DIR" "$DMG_PATH" >/dev/null

APP_PATH="$MOUNT_DIR/Claude Science Switch.app"
RESOURCE_DIR="$APP_PATH/Contents/Resources/claude-science-switch"
PROXY_BIN="$RESOURCE_DIR/bin/claude-science-switch"
PROXY_JS="$RESOURCE_DIR/bin/claude-science-switch.js"

test -x "$APP_PATH/Contents/MacOS/cc-switch"
test -x "$PROXY_BIN"
test -f "$PROXY_JS"
test -f "$RESOURCE_DIR/examples/cliproxy-gpt55.json"
test -f "$RESOURCE_DIR/examples/cc-switch-provider-openai-chat.json"
test -f "$RESOURCE_DIR/examples/multi-provider.json"
test -f "$RESOURCE_DIR/examples/science-provider-presets.json"

echo "[verify] codesign"
codesign --verify --deep --strict --verbose=2 "$APP_PATH"

echo "[verify] packaged smoke"
"$APP_PATH/Contents/MacOS/cc-switch" --science-proxy-managed-smoke

echo "[verify] bundled resource hashes"
root_proxy_hash="$(shasum -a 256 "$ROOT_DIR/bin/native/claude-science-switch" | awk '{print $1}')"
bundled_proxy_hash="$(shasum -a 256 "$PROXY_BIN" | awk '{print $1}')"
root_js_hash="$(shasum -a 256 "$ROOT_DIR/bin/claude-science-switch.js" | awk '{print $1}')"
bundled_js_hash="$(shasum -a 256 "$PROXY_JS" | awk '{print $1}')"
[[ "$root_proxy_hash" == "$bundled_proxy_hash" ]]
[[ "$root_js_hash" == "$bundled_js_hash" ]]

echo "[verify] URL schemes"
/usr/libexec/PlistBuddy -c 'Print :CFBundleURLTypes:0:CFBundleURLSchemes' "$APP_PATH/Contents/Info.plist" \
  | grep -q 'claude-science-switch'

echo "[verify] smoke entry strings"
grep -a -q 'science-proxy-managed-smoke' "$APP_PATH/Contents/MacOS/cc-switch"
grep -a -q 'science-preload-' "$APP_PATH/Contents/MacOS/cc-switch"

echo "[verify] bundled providers"
"$PROXY_BIN" providers --config "$RESOURCE_DIR/examples/multi-provider.json" >/dev/null
"$PROXY_BIN" providers --config "$RESOURCE_DIR/examples/science-provider-presets.json" >/dev/null

if [[ "${SKIP_UPSTREAM_DOCTOR:-0}" != "1" ]]; then
  echo "[verify] upstream doctor"
  "$PROXY_BIN" doctor \
    --config "$RESOURCE_DIR/examples/cliproxy-gpt55.json" \
    --model claude-fable-5
else
  echo "[verify] upstream doctor skipped"
fi

echo "[verify] spctl assessment (expected to reject until notarized)"
spctl --assess --type execute --verbose=4 "$APP_PATH" || true

echo "[verify] ok: $DMG_PATH"
