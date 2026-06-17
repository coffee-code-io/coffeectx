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
# Re-publishing the same version is a hard error from npm. For the common
# case where some workspaces were bumped and others weren't, the loop below
# checks `npm view <pkg>@<v> version` first and skips the package when that
# version is already on the registry — instead of letting `npm publish` fail
# with EPUBLISHCONFLICT and aborting the rest of the run.

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

published=0
skipped=0
for pkg in "${PACKAGES[@]}"; do
  echo
  # Read the workspace's local version from its package.json. `npm pkg get
  # -w <pkg>` returns a JSON object keyed by package name (`{"@x/y":"0.1.6"}`)
  # — pluck the value out via node so we don't depend on jq.
  local_version="$(node -e "
    const r = require('child_process').execSync('npm pkg get version -w \"$pkg\"', {encoding:'utf-8'});
    process.stdout.write(Object.values(JSON.parse(r))[0] || '');
  " 2>/dev/null)"
  if [[ -z "$local_version" ]]; then
    echo "==> $pkg: could not read local version — skipping" >&2
    skipped=$((skipped + 1))
    continue
  fi

  # `npm view <pkg>@<v> version` prints the version when it exists on the
  # registry, empty otherwise. Errors (404, network) also yield empty —
  # safest because publish will reject if there's an actual conflict.
  if [[ -n "$(npm view "$pkg@$local_version" version 2>/dev/null)" ]]; then
    echo "==> $pkg@$local_version already published — skipping"
    skipped=$((skipped + 1))
    continue
  fi

  echo "==> Publishing $pkg@$local_version..."
  npm publish -w "$pkg"
  published=$((published + 1))
done

echo
echo "Done. Published $published, skipped $skipped (already on registry)."
