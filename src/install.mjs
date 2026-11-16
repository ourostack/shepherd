// `shepherd install`: the launch agent that runs `shepherd watch --quiet` every 60 s, so the health watch runs with no one
// at a terminal. Loading replaces a running copy of the same label. Nothing here runs unless the person asks for it.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const LABEL = 'bot.ouro.shepherd';

// A Homebrew node runs from a versioned Cellar folder that the next upgrade removes; launchd needs the stable link.
export function stableNode(execPath, exists = fs.existsSync) {
  if (!/\/Cellar\//.test(execPath)) return execPath;
  return ['/opt/homebrew/bin/node', '/usr/local/bin/node'].find((p) => exists(p)) || execPath;
}
export const BIN = fileURLToPath(new URL('../bin/shepherd.mjs', import.meta.url));
export const agentPath = (home = os.homedir()) => path.join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`);
export const logPath = (home = os.homedir()) => path.join(home, 'Library', 'Logs', 'shepherd-watch.launchd.log');

const esc = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;');

export function watchPlist({ node, bin, log, path: searchPath }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${esc(LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
${[node, bin, 'watch', '--quiet'].map((a) => `    <string>${esc(a)}</string>`).join('\n')}
  </array>
  <key>RunAtLoad</key><true/>
  <key>StartInterval</key><integer>60</integer>
  <key>LimitLoadToSessionType</key><string>Aqua</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${esc(searchPath)}</string>
  </dict>
  <key>StandardOutPath</key><string>${esc(log)}</string>
  <key>StandardErrorPath</key><string>${esc(log)}</string>
</dict>
</plist>
`;
}

const run = (file, argv) => new Promise((res) => {
  execFile(file, argv, { timeout: 30000 }, (err, stdout, stderr) => res({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stderr: String(stderr || '') }));
});

// Writes the plist and loads it (bootout, then bootstrap). dry: returns the plist text and changes nothing.
export async function install({ home = os.homedir(), node = stableNode(process.execPath), bin = BIN, dry = false, uid = process.getuid?.(), launchctl = (a) => run('/bin/launchctl', a) } = {}) {
  const file = agentPath(home), log = logPath(home);
  const searchPath = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin', path.join(home, '.ouro-cli', 'bin')].join(':');
  const text = watchPlist({ node, bin, log, path: searchPath });
  if (dry) return { ok: true, dry_run: true, label: LABEL, plist: file, log, text };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.mkdirSync(path.dirname(log), { recursive: true });
  fs.writeFileSync(file, text);
  await launchctl(['bootout', `gui/${uid}/${LABEL}`]);
  const r = await launchctl(['bootstrap', `gui/${uid}`, file]);
  return { ok: r.code === 0, dry_run: false, label: LABEL, plist: file, log, error: r.stderr.trim() || null, text };
}
