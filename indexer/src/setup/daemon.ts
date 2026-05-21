/**
 * Systemd / launchd service installation helpers for the coffeectx daemon.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';

/** Returns true when the current platform supports daemon installation. */
export function isDaemonSupported(): boolean {
  return process.platform === 'darwin' || process.platform === 'linux';
}

/**
 * Install and activate a background service that runs:
 *   `coffeectx-index daemonize --project <projectName>`
 *
 * macOS  → launchd plist at ~/Library/LaunchAgents/com.coffeectx.plist
 * Linux  → systemd user unit at ~/.config/systemd/user/coffeectx.service
 *
 * The service does NOT auto-respawn on exit (no KeepAlive / Restart=on-failure).
 * It launches at login (RunAtLoad / WantedBy=default.target).
 */
export async function installDaemon(
  indexerBin: string,
  projectName: string,
): Promise<void> {
  if (process.platform === 'darwin') {
    await installLaunchd(indexerBin, projectName);
  } else if (process.platform === 'linux') {
    await installSystemd(indexerBin, projectName);
  } else {
    throw new Error(`Daemon installation is not supported on platform: ${process.platform}`);
  }
}

// ── macOS launchd ─────────────────────────────────────────────────────────────

async function installLaunchd(indexerBin: string, projectName: string): Promise<void> {
  const plistPath = join(homedir(), 'Library', 'LaunchAgents', 'com.coffeectx.plist');
  const logDir = join(homedir(), '.coffeecode', 'logs');
  mkdirSync(logDir, { recursive: true });
  mkdirSync(dirname(plistPath), { recursive: true });

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.coffeectx</string>

  <key>ProgramArguments</key>
  <array>
    <string>node</string>
    <string>${indexerBin}</string>
    <string>daemonize</string>
    <string>--project</string>
    <string>${projectName}</string>
  </array>

  <key>RunAtLoad</key>
  <true/>

  <key>StandardOutPath</key>
  <string>${logDir}/coffeectx.log</string>

  <key>StandardErrorPath</key>
  <string>${logDir}/coffeectx.error.log</string>
</dict>
</plist>
`;

  writeFileSync(plistPath, plist, 'utf-8');
  console.log(`  Written: ${plistPath}`);

  const result = spawnSync('launchctl', ['load', plistPath], { encoding: 'utf-8' });
  if (result.status !== 0) {
    const msg = (result.stderr ?? result.stdout ?? '').trim();
    console.warn(`  Warning: launchctl load failed: ${msg || 'unknown error'}`);
    console.warn(`  You can load it manually: launchctl load "${plistPath}"`);
  } else {
    console.log('  Service loaded via launchctl.');
  }
}

// ── Linux systemd ─────────────────────────────────────────────────────────────

async function installSystemd(indexerBin: string, projectName: string): Promise<void> {
  const unitDir = join(homedir(), '.config', 'systemd', 'user');
  const unitPath = join(unitDir, 'coffeectx.service');
  mkdirSync(unitDir, { recursive: true });

  const unit = `[Unit]
Description=CoffeeCtx knowledge graph scheduler
After=network.target

[Service]
ExecStart=node ${indexerBin} daemonize --project ${projectName}

[Install]
WantedBy=default.target
`;

  writeFileSync(unitPath, unit, 'utf-8');
  console.log(`  Written: ${unitPath}`);

  // Reload systemd manager configuration
  const reload = spawnSync('systemctl', ['--user', 'daemon-reload'], { encoding: 'utf-8' });
  if (reload.status !== 0) {
    const msg = (reload.stderr ?? '').trim();
    console.warn(`  Warning: systemctl daemon-reload failed: ${msg || 'unknown error'}`);
  }

  const enable = spawnSync('systemctl', ['--user', 'enable', '--now', 'coffeectx'], {
    encoding: 'utf-8',
  });
  if (enable.status !== 0) {
    const msg = (enable.stderr ?? '').trim();
    console.warn(`  Warning: systemctl enable --now failed: ${msg || 'unknown error'}`);
    console.warn(`  You can enable it manually: systemctl --user enable --now coffeectx`);
  } else {
    console.log('  Service enabled and started via systemctl.');
  }
}
