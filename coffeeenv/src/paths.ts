import os from "node:os";
import path from "node:path";

export interface Layout {
  root: string;
  profiles: string;
  envs: string;
  profile(name: string): string;
  env(name: string): string;
  envBin(name: string): string;
  envHome(name: string): string;
  envManifest(name: string): string;
  envClaudeDir(name: string): string;
  envClaudeJson(name: string): string;
}

export function layout(rootOverride?: string): Layout {
  const root = rootOverride ?? path.join(os.homedir(), ".coffeeenv");
  const profiles = path.join(root, "profiles");
  const envs = path.join(root, "envs");
  return {
    root,
    profiles,
    envs,
    profile: (n) => path.join(profiles, n),
    env: (n) => path.join(envs, n),
    envBin: (n) => path.join(envs, n, "bin"),
    envHome: (n) => path.join(envs, n, "home"),
    envManifest: (n) => path.join(envs, n, "manifest.json"),
    envClaudeDir: (n) => path.join(envs, n, "home", ".claude"),
    envClaudeJson: (n) => path.join(envs, n, "home", ".claude.json"),
  };
}
