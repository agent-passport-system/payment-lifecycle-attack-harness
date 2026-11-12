#!/usr/bin/env bash
# Copyright 2026 Tymofii Pidlisnyi. Apache-2.0 license. See LICENSE.
# Copy the gateway source at the commit named in PIN into vendor/gateway and install its lockfile.
# The harness imports this copy unchanged.
# Usage: scripts/vendor-gateway.sh [path-to-a-clone-of-agent-passport-gateway]
# With no path and no GATEWAY_REPO, the public repository is cloned into .cache/.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
url="${GATEWAY_URL:-https://github.com/agent-passport-system/agent-passport-gateway.git}"
pin="$(tr -d '[:space:]' < "$here/PIN")"
repo="${1:-${GATEWAY_REPO:-}}"
if [ -z "$repo" ]; then
  repo="$here/.cache/gateway.git"
  if [ -d "$repo" ]; then git -C "$repo" fetch -q origin '+refs/heads/*:refs/heads/*'
  else mkdir -p "$here/.cache" && git clone -q --bare "$url" "$repo"; fi
fi
got="$(git -C "$repo" rev-parse --verify -q "$pin^{commit}" || true)"
[ "$got" = "$pin" ] || { echo "commit $pin not found in $repo" >&2; exit 2; }
rm -rf "$here/vendor/gateway"; mkdir -p "$here/vendor/gateway"
git -C "$repo" archive "$pin" src package.json package-lock.json tsconfig.json | tar -x -C "$here/vendor/gateway"
echo "$pin" > "$here/vendor/gateway/VENDORED_FROM"
(cd "$here/vendor/gateway" && npm ci --no-audit --no-fund --loglevel=error)
echo "vendored gateway at $pin"
