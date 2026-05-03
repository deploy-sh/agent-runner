#!/bin/bash
# Build agent-runner as standalone binary (no Node.js required)
set -euo pipefail

cd "$(dirname "$0")/.."

echo "=== Build: TypeScript ==="
npm run build

echo "=== Bundle: esbuild ==="
npx esbuild dist/main.js \
  --bundle \
  --platform=node \
  --target=node22 \
  --outfile=release/agent-runner.js \
  --external:readline \
  --minify

echo "=== Binary: pkg ==="
mkdir -p release
npx pkg release/agent-runner.js \
  --target node22-linux-x64 \
  --output release/agent-runner-linux-x64 \
  --compress GZip

echo "=== Done ==="
ls -lh release/agent-runner-linux-x64
echo "Binary: release/agent-runner-linux-x64"
