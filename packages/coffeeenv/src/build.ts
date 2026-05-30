import fs from "node:fs";
import path from "node:path";
import { loadSpec, type LoadedSpec } from "./spec.js";
import { layout } from "./paths.js";
import {
  npmInstallTools,
  symlinkSystemBins,
  which,
  clearWrapperSlot,
} from "./bins.js";
import { writeWrapper } from "./wrapper.js";
import { renderClaude } from "./render.js";

export interface BuildOptions {
  rootOverride?: string;
  force?: boolean;
}

export interface BuildResult {
  envDir: string;
  envHome: string;
  envBin: string;
}

export function buildEnv(name: string, opts: BuildOptions = {}): BuildResult {
  const L = layout(opts.rootOverride);
  const profileDir = L.profile(name);
  if (!fs.existsSync(profileDir)) {
    throw new Error(`No profile '${name}' at ${profileDir}. Run \`coffeeenv install\` first.`);
  }
  const loaded = loadSpec(profileDir);
  return buildFromLoaded(loaded, name, opts);
}

export function buildFromLoaded(
  loaded: LoadedSpec,
  envName: string,
  opts: BuildOptions = {},
): BuildResult {
  const L = layout(opts.rootOverride);
  const envDir = L.env(envName);

  if (opts.force && fs.existsSync(envDir)) {
    fs.rmSync(envDir, { recursive: true, force: true });
  }
  fs.mkdirSync(envDir, { recursive: true });
  fs.mkdirSync(L.envBin(envName), { recursive: true });
  fs.mkdirSync(L.envHome(envName), { recursive: true });

  const { spec } = loaded;

  // 1. npm install declared tools into envDir (lands bins in envDir/bin)
  const npmResult = npmInstallTools(envDir, spec.tools);

  // 2. For each tool with hijack:home, replace the npm-dropped bin with a wrapper.
  const envHome = L.envHome(envName);
  for (const tool of spec.tools) {
    if (tool.hijack !== "home") continue;
    const realBin = npmResult.binPaths[tool.name];
    if (!realBin) {
      throw new Error(
        `Tool '${tool.name}' declared hijack:home but no real bin resolved (source=${tool.source})`,
      );
    }
    clearWrapperSlot(L.envBin(envName), tool.name);
    writeWrapper(L.envBin(envName), {
      name: tool.name,
      realBin,
      fakeHome: envHome,
      extraEnv: extraEnvFor(tool.name, envHome),
    });
  }

  // 3. Symlink system bins (rg, jq, gh, ...)
  symlinkSystemBins(L.envBin(envName), spec.bins);

  // 4. Pre-populate fake home with selected pass-through dotfiles.
  passThroughDotfiles(envHome);

  // 5. Render Claude config tree into envHome/.claude + .claude.json
  const envVars = computeRenderVars(envName, opts.rootOverride);
  renderClaude(loaded, envName, { envVars }, opts.rootOverride);

  // 6. Write manifest
  const manifest = {
    name: envName,
    builtAt: new Date().toISOString(),
    spec: spec.name,
    tools: spec.tools.map((t) => ({
      name: t.name,
      source: t.source,
      package: t.package,
      version: t.version,
      hijack: t.hijack,
      resolvedRealBin: npmResult.binPaths[t.name] ?? null,
    })),
    bins: spec.bins.map((b) => ({
      name: b.name,
      source: b.source,
      resolved: b.source === "system" ? which(b.name) ?? null : null,
    })),
  };
  fs.writeFileSync(L.envManifest(envName), JSON.stringify(manifest, null, 2));

  return {
    envDir,
    envHome,
    envBin: L.envBin(envName),
  };
}

function extraEnvFor(toolName: string, fakeHome: string): Record<string, string> {
  // Tool-specific env additions on top of HOME hijack.
  if (toolName === "claude") {
    return {
      CLAUDE_CONFIG_DIR: path.join(fakeHome, ".claude"),
    };
  }
  return {};
}

function computeRenderVars(envName: string, rootOverride?: string): Record<string, string> {
  const L = layout(rootOverride);
  return {
    COFFEEENV_HOME: L.envHome(envName),
    COFFEEENV_ENV: envName,
    COFFEEENV_ROOT: L.root,
    HOME: process.env.HOME ?? "",
  };
}

const PASS_THROUGH_DOTFILES = [".gitconfig", ".npmrc"];

function passThroughDotfiles(envHome: string): void {
  const realHome = process.env.HOME;
  if (!realHome) return;
  for (const name of PASS_THROUGH_DOTFILES) {
    const src = path.join(realHome, name);
    const dst = path.join(envHome, name);
    if (fs.existsSync(dst) || fs.lstatSync(dst, { throwIfNoEntry: false })) continue;
    if (!fs.existsSync(src)) continue;
    try {
      fs.symlinkSync(src, dst);
    } catch {}
  }
}
