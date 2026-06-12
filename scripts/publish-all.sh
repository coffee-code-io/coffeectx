#!/usr/bin/env bash
#
# Publish every public coffeectx workspace to npm in dependency order.
#
# Behaviour:
#   1. Ensures the caller is logged in (`npm whoami`). If not, runs the
#      interactive `npm login` flow (browser + OTP) and persists credentials
#      into `~/.npmrc` so subsequent `npm publish` calls authenticate
#      automatically.
#   2. Builds every workspace once. Each `npm publish` re-runs
#      `prepublishOnly: npm run build` per package as a belt-and-braces
#      check, but doing it up front catches breakage before we start pushing
#      to the registry.
#   3. Publishes packages in dependency order so the registry is internally
#      consistent the whole way through.
#
# Skips `@coffeectx/webui` because it's marked `private: true` (its built
# assets ship bundled inside the indexer tarball via `webui-dist/`).
#
# Re-publishing the same version is a hard error from npm — bump the patch
# version first (`npm version patch --workspaces --no-git-tag-version`).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

# ── 1. Authentication ─────────────────────────────────────────────────────
if npm whoami >/dev/null 2>&1; then
  echo "Logged in to npm as: $(npm whoami)"
else
  echo "Not logged in to npm. Starting interactive login..."
  npm login
  echo "Logged in as: $(npm whoami)"
fi

# ── 2. Fresh build ────────────────────────────────────────────────────────
echo
echo "Building all workspaces..."
npm run build --workspaces --if-present >/dev/null
echo "Build OK."

# ── 3. Publish in dependency order ────────────────────────────────────────
#
# Topological order: every package's @coffeectx/* deps are already on the
# registry before it gets pushed. Webui omitted (private).
PACKAGES=(
  @coffeectx/core
  @coffeectx/secrets-core
  @coffeectx/tools
  @coffeectx/secrets-pi
  @coffeectx/secrets-mcp
  @coffeectx/server
  @coffeectx/pi-plugin
  @coffeectx/indexer
  @coffeectx/test-utils
)

for pkg in "${PACKAGES[@]}"; do
  echo
  echo "==> Publishing $pkg..."
  npm publish -w "$pkg"
done

echo
echo "All ${#PACKAGES[@]} packages published successfully."
