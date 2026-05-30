import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { Spec, Tool, Bin } from "./spec.js";

export interface NpmInstallResult {
  /** Map of declared tool name → resolved real binary path inside the env's lib tree. */
  binPaths: Record<string, string>;
}

export function npmInstallTools(envDir: string, tools: Tool[]): NpmInstallResult {
  const npmTools = tools.filter((t) => t.source === "npm" && t.package);
  if (npmTools.length === 0) return { binPaths: {} };

  fs.mkdirSync(envDir, { recursive: true });
  const args = [
    "install",
    "-g",
    "--prefix",
    envDir,
    "--no-audit",
    "--no-fund",
    ...npmTools.map((t) => `${t.package!}${t.version ? `@${t.version}` : ""}`),
  ];
  execFileSync("npm", args, { stdio: "inherit" });

  // After `npm install -g --prefix`, bins land in <envDir>/bin/<name>.
  // We want to know the *real* path (i.e. the file npm just dropped), so the
  // wrapper script can exec it. npm uses the package's `bin` field; the file
  // at <envDir>/bin/<tool> is a symlink into lib/node_modules/<pkg>/<file>.
  const binDir = path.join(envDir, "bin");
  const out: Record<string, string> = {};
  for (const t of npmTools) {
    const binPath = path.join(binDir, t.name);
    if (!fs.existsSync(binPath)) {
      throw new Error(
        `npm installed ${t.package} but no bin '${t.name}' was created at ${binPath}`,
      );
    }
    // Resolve symlinks so we have a stable real path for the wrapper to exec.
    out[t.name] = fs.realpathSync(binPath);
  }
  return { binPaths: out };
}

export function symlinkSystemBins(binDir: string, bins: Bin[]): void {
  fs.mkdirSync(binDir, { recursive: true });
  for (const b of bins) {
    if (b.source !== "system") continue;
    const sysPath = which(b.name);
    if (!sysPath) {
      throw new Error(
        `system binary '${b.name}' not found on PATH; install it on the host or change source`,
      );
    }
    const dest = path.join(binDir, b.name);
    if (fs.existsSync(dest) || fs.lstatSync(dest, { throwIfNoEntry: false })) {
      fs.rmSync(dest, { force: true });
    }
    fs.symlinkSync(sysPath, dest);
  }
}

export function which(cmd: string): string | undefined {
  try {
    const out = execFileSync("/usr/bin/env", ["which", cmd], {
      encoding: "utf8",
    }).trim();
    return out || undefined;
  } catch {
    return undefined;
  }
}

export function realBinaryFor(envDir: string, tool: string): string {
  return fs.realpathSync(path.join(envDir, "bin", tool));
}

export function clearWrapperSlot(binDir: string, name: string): void {
  const p = path.join(binDir, name);
  if (fs.existsSync(p) || fs.lstatSync(p, { throwIfNoEntry: false })) {
    fs.rmSync(p, { force: true });
  }
}

export function summarizeTools(spec: Spec): string[] {
  return [
    ...spec.tools.map((t) => `${t.name} (${t.source}${t.package ? `:${t.package}` : ""})`),
    ...spec.bins.map((b) => `${b.name} (${b.source})`),
  ];
}
