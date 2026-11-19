// execFile that owns the child's whole process tree. The child runs in its own process group; a timeout sends SIGTERM to the
// group and SIGKILL after a short grace, and a normal exit still kills whatever the child left behind. Plain execFile kills
// only the child, so a runner's own children (a wedged git fetch, say) were left running under launchd.
import { spawn } from 'node:child_process';

export const KILL_GRACE_MS = 2000;

const signalGroup = (pid, signal) => {
  try { process.kill(-pid, signal); } catch { /* the group is already gone */ }
};

// Same callback shape as execFile: (error, stdout, stderr). A timeout gives error.killed true and error.code null.
export function execFileGroup(file, args, opts = {}, cb = () => {}) {
  const { timeout = 0, maxBuffer = 1 << 20, encoding = 'utf8', ...spawnOpts } = opts;
  let child;
  try {
    child = spawn(file, args, { ...spawnOpts, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    queueMicrotask(() => cb(e, '', ''));
    return null;
  }
  let out = '';
  let err = '';
  let settled = false;
  let timer = null;
  let killTimer = null;
  const finish = (error) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    child.stdout?.destroy();
    child.stderr?.destroy();
    cb(error, out, err);
  };
  const killTree = () => {
    signalGroup(child.pid, 'SIGTERM');
    killTimer = setTimeout(() => signalGroup(child.pid, 'SIGKILL'), KILL_GRACE_MS);
  };
  const take = (which) => (chunk) => {
    if (settled) return;
    if (which === 'out') out += chunk; else err += chunk;
    if (out.length + err.length > maxBuffer) {
      killTree();
      finish(Object.assign(new Error('maxBuffer exceeded'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', killed: true }));
    }
  };
  child.stdout.setEncoding(encoding);
  child.stderr.setEncoding(encoding);
  child.stdout.on('data', take('out'));
  child.stderr.on('data', take('err'));
  child.on('error', (e) => finish(e));
  const result = (code, signal) => {
    if (code === 0) return finish(null);
    finish(Object.assign(new Error(`Command failed: ${file}`), { code, signal }));
  };
  child.on('exit', (code, signal) => {
    // Nothing the child started outlives it; the pipes close once the group is gone, with a fallback if one is held open.
    if (!killTimer) signalGroup(child.pid, 'SIGKILL');
    setTimeout(() => result(code, signal), 1000);
  });
  child.on('close', result);
  if (timeout > 0) {
    timer = setTimeout(() => {
      killTree();
      finish(Object.assign(new Error(`Command timed out after ${timeout}ms: ${file}`), { code: null, killed: true, signal: 'SIGTERM' }));
    }, timeout);
  }
  return child;
}
