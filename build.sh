#!/usr/bin/env bash
# Build the plugin. With BRAT installed in Obsidian, you typically don't need
# to copy anything yourself — `git push` is enough; BRAT pulls on update.
#
# If you set TARGET_DIR (or accept the default cordycep server vault path),
# this also drops the built files into a vault for direct testing.
set -euo pipefail

PLUGIN_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$PLUGIN_DIR"

if [[ ! -d node_modules ]]; then
    echo "Installing deps…"
    npm install
fi

echo "Building…"
npm run build

if [[ -n "${TARGET_DIR:-}" ]]; then
    mkdir -p "$TARGET_DIR"
    install -m 0644 main.js manifest.json styles.css "$TARGET_DIR/"
    echo "Installed to $TARGET_DIR"
fi
