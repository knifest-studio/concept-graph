#!/bin/bash
set -e
cd "$(dirname "$0")"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 22+ is required. Install it, then follow docs/setup.md."
  exit 1
fi
if [ ! -d node_modules ] || [ ! -f dist/index.html ]; then
  echo "Finish installation first: npm ci && npm run build"
  echo "For a release ZIP, run: npm ci --omit=dev"
  exit 1
fi
concept_graph_url="http://127.0.0.1:${PORT:-4317}"
if curl -fsS "$concept_graph_url/api/workspace" >/dev/null 2>&1; then
  open "$concept_graph_url"
  exit 0
fi
node server.mjs &
concept_graph_pid=$!
trap 'kill "$concept_graph_pid" 2>/dev/null || true' EXIT
trap 'exit 0' INT TERM
for concept_graph_attempt in {1..50}; do
  if curl -fsS "$concept_graph_url/api/workspace" >/dev/null 2>&1; then
    open "$concept_graph_url"
    break
  fi
  if ! kill -0 "$concept_graph_pid" 2>/dev/null; then break; fi
  sleep 0.1
done
wait "$concept_graph_pid"
