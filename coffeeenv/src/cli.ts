#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";
import { install } from "./install.js";
import { buildEnv } from "./build.js";
import { spawnShell } from "./shell.js";
import { layout } from "./paths.js";
import { loadSpec } from "./spec.js";
import { summarizeTools } from "./bins.js";

const program = new Command();
program
  .name("coffeeenv")
  .description("Virtual environments for AI coding setups")
  .version("0.1.0");

program
  .command("install <source>")
  .description("Install a profile from a local dir or git+https URL")
  .option("--name <name>", "override the profile name from the spec")
  .action((source: string, opts: { name?: string }) => {
    const r = install({ source, name: opts.name });
    console.log(`Installed profile '${r.name}' at ${r.profileDir}`);
    console.log(`Next: coffeeenv build ${r.name}  (or jump straight to: coffeeenv shell ${r.name})`);
  });

program
  .command("build <name>")
  .description("Materialize the env directory for a profile (idempotent unless --force)")
  .option("--force", "wipe the existing env dir first")
  .action((name: string, opts: { force?: boolean }) => {
    const r = buildEnv(name, { force: opts.force });
    console.log(`Built env at ${r.envDir}`);
    console.log(`  bin:  ${r.envBin}`);
    console.log(`  home: ${r.envHome}`);
  });

program
  .command("shell <name>")
  .description("Activate a profile in a subshell")
  .option("--no-build", "skip the build step (env must already exist)")
  .action(async (name: string, opts: { build?: boolean }) => {
    const L = layout();
    if (opts.build !== false && !fs.existsSync(L.env(name))) {
      buildEnv(name);
    } else if (!fs.existsSync(L.env(name))) {
      console.error(`Env '${name}' not built. Run: coffeeenv build ${name}`);
      process.exit(1);
    }
    const code = await spawnShell(name);
    process.exit(code);
  });

program
  .command("list")
  .description("List installed profiles")
  .action(() => {
    const L = layout();
    if (!fs.existsSync(L.profiles)) {
      console.log("(no profiles installed)");
      return;
    }
    const names = fs.readdirSync(L.profiles).filter((n) => {
      const yamlPath = path.join(L.profile(n), "coffeeenv.yaml");
      return fs.existsSync(yamlPath);
    });
    if (names.length === 0) {
      console.log("(no profiles installed)");
      return;
    }
    for (const n of names) {
      const built = fs.existsSync(L.env(n)) ? "built" : "not built";
      console.log(`  ${n}  [${built}]`);
    }
  });

program
  .command("show <name>")
  .description("Show details of a profile")
  .action((name: string) => {
    const L = layout();
    const profileDir = L.profile(name);
    if (!fs.existsSync(profileDir)) {
      console.error(`No profile '${name}'`);
      process.exit(1);
    }
    const { spec } = loadSpec(profileDir);
    console.log(`Profile: ${spec.name}`);
    if (spec.description) console.log(`  ${spec.description}`);
    console.log(`  source dir: ${profileDir}`);
    console.log(`  env dir:    ${L.env(name)} (${fs.existsSync(L.env(name)) ? "built" : "not built"})`);
    console.log(`  tools/bins:`);
    for (const line of summarizeTools(spec)) console.log(`    - ${line}`);
    if (spec.claude.agents_md) console.log(`  CLAUDE.md: ${spec.claude.agents_md}`);
    if (spec.claude.settings) console.log(`  settings:  ${spec.claude.settings}`);
    if (spec.claude.mcp_servers) console.log(`  mcp:       ${spec.claude.mcp_servers}`);
  });

program
  .command("rm <name>")
  .description("Remove a profile and its env dir")
  .option("--keep-profile", "remove only the env dir, not the profile spec")
  .action((name: string, opts: { keepProfile?: boolean }) => {
    const L = layout();
    if (fs.existsSync(L.env(name))) {
      fs.rmSync(L.env(name), { recursive: true, force: true });
      console.log(`Removed env: ${L.env(name)}`);
    }
    if (!opts.keepProfile && fs.existsSync(L.profile(name))) {
      fs.rmSync(L.profile(name), { recursive: true, force: true });
      console.log(`Removed profile: ${L.profile(name)}`);
    }
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
