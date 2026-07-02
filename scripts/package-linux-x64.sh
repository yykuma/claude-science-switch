#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="$(node -e 'console.log(JSON.parse(require("fs").readFileSync("package.json", "utf8")).version)' 2>/dev/null || echo "0.1.0")"
OUT_DIR="$ROOT_DIR/release/linux-x64"
ARCHIVE="$ROOT_DIR/release/claude-science-switch_${VERSION}_linux-x64.tar.gz"

rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR/bin" "$OUT_DIR/examples"

bun build --compile --target=bun-linux-x64 \
  "$ROOT_DIR/bin/claude-science-switch.js" \
  --outfile "$OUT_DIR/bin/claude-science-switch"

chmod +x "$OUT_DIR/bin/claude-science-switch"
cp "$ROOT_DIR"/examples/*.json "$OUT_DIR/examples/"
cp "$ROOT_DIR/README.md" "$ROOT_DIR/package.json" "$OUT_DIR/"

tar -C "$ROOT_DIR/release" -czf "$ARCHIVE" linux-x64
shasum -a 256 "$ARCHIVE" "$OUT_DIR/bin/claude-science-switch"
