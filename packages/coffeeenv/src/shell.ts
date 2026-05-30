import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { layout } from "./paths.js";
import { loadSpec } from "./spec.js";

export interface ShellOptions {
  rootOverride?: string;
}

export async function spawnShell(name: string, opts: ShellOptions = {}): Promise<number> {
  const L = layout(opts.rootOverride);
  const envDir = L.env(name);
  if (!fs.existsSync(envDir)) {
    throw new Error(`Env '${name}' not built. Run \`coffeeenv build ${name}\` first.`);
  }
  const profileDir = L.profile(name);
  const { spec } = loadSpec(profileDir);

  const shell = process.env.SHELL || "/bin/sh";
  const shellName = path.basename(shell);

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${L.envBin(name)}:${process.env.PATH ?? ""}`,
    COFFEEENV_ACTIVE: name,
    COFFEEENV_ENV: name,
    COFFEEENV_HOME: L.envHome(name),
    COFFEEENV_ROOT: L.root,
    npm_config_prefix: envDir,
    ...spec.env,
  };

  // Friendly prompt prefix (best-effort per shell)
  if (shellName === "bash" || shellName === "sh") {
    env.PS1 = `(coffee:${name}) ${process.env.PS1 ?? "\\u@\\h:\\w$ "}`;
  } else if (shellName === "zsh") {
    env.PROMPT = `(coffee:${name}) ${process.env.PROMPT ?? "%n@%m %~ %# "}`;
  }
  // fish: handled via FISH_PROMPT override below by launching with a -C init.

  const args: string[] = [];
  if (shellName === "fish") {
    // Subshell-only override; parent shell's prompt is unaffected on exit.
    args.push(
      "-C",
      `functions -c fish_prompt __coffeeenv_orig_prompt 2>/dev/null; function fish_prompt; set_color brblue; echo -n "(coffee:${name}) "; set_color normal; __coffeeenv_orig_prompt; end`,
    );
  }

  return await new Promise<number>((resolve, reject) => {
    const child = spawn(shell, args, { stdio: "inherit", env });
    child.on("error", reject);
    child.on("exit", (code) => resolve(code ?? 0));
  });
}
