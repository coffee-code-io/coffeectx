import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import os from "node:os";
import { loadSpec } from "./spec.js";
import { layout } from "./paths.js";

export interface InstallOptions {
  source: string;
  name?: string;
  rootOverride?: string;
}

export interface InstallResult {
  name: string;
  profileDir: string;
}

export function install(opts: InstallOptions): InstallResult {
  const L = layout(opts.rootOverride);
  fs.mkdirSync(L.profiles, { recursive: true });

  const fetched = isGitSource(opts.source)
    ? fetchGit(opts.source)
    : { dir: path.resolve(opts.source), cleanup: () => {} };

  try {
    const { spec } = loadSpec(fetched.dir);
    const name = opts.name ?? spec.name;
    const dest = L.profile(name);
    if (fs.existsSync(dest)) {
      fs.rmSync(dest, { recursive: true, force: true });
    }
    fs.mkdirSync(dest, { recursive: true });
    copyDir(fetched.dir, dest);
    return { name, profileDir: dest };
  } finally {
    fetched.cleanup();
  }
}

function isGitSource(s: string): boolean {
  return /^(git\+|https?:\/\/.*\.git|git@)/.test(s);
}

interface Fetched {
  dir: string;
  cleanup: () => void;
}

function fetchGit(source: string): Fetched {
  // Format: git+https://host/user/repo.git#ref:subpath
  // or: git+https://host/user/repo.git#ref
  const stripped = source.replace(/^git\+/, "");
  const [urlPart, fragment] = stripped.split("#");
  let ref: string | undefined;
  let subpath: string | undefined;
  if (fragment) {
    const colonIdx = fragment.indexOf(":");
    if (colonIdx >= 0) {
      ref = fragment.slice(0, colonIdx) || undefined;
      subpath = fragment.slice(colonIdx + 1) || undefined;
    } else {
      ref = fragment;
    }
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "coffeeenv-git-"));
  const args = ["clone", "--depth", "1"];
  if (ref) args.push("--branch", ref);
  args.push(urlPart, tmp);
  execFileSync("git", args, { stdio: "inherit" });

  const dir = subpath ? path.join(tmp, subpath) : tmp;
  return {
    dir,
    cleanup: () => {
      try {
        fs.rmSync(tmp, { recursive: true, force: true });
      } catch {}
    },
  };
}

function copyDir(src: string, dst: string): void {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      copyDir(s, d);
    } else if (entry.isSymbolicLink()) {
      fs.symlinkSync(fs.readlinkSync(s), d);
    } else {
      fs.copyFileSync(s, d);
    }
  }
}
