// Cross-process lock: a file created exclusively, holding its owner's pid. Several Claude sessions (and
// the UI server) run this code at the same time, so a read-modify-write of shared state takes the lock.
import { closeSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from 'node:fs';

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// Left behind by a process that died, or held far longer than any operation here takes.
function abandoned(file, staleMs) {
  try {
    const pid = Number(readFileSync(file, 'utf8'));
    if (pid && !alive(pid)) return true;
    return Date.now() - statSync(file).mtimeMs > staleMs;
  } catch { return false; } // gone already: just try again
}

// Returns the function that releases the lock. Throws (status 503) if it stays taken for `timeout` ms.
export function acquire(file, { timeout = 5000, staleMs = 30000 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    try {
      const fd = openSync(file, 'wx');
      try { writeSync(fd, String(process.pid)); } finally { closeSync(fd); }
      return () => { try { unlinkSync(file); } catch { /* already gone */ } };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    if (abandoned(file, staleMs)) { try { unlinkSync(file); } catch { /* someone else cleared it */ } continue; }
    if (Date.now() >= deadline) {
      throw Object.assign(new Error(`${file} is locked by another process; try again`), { status: 503 });
    }
    sleep(10);
  }
}

export function withLock(file, fn, opts) {
  const release = acquire(file, opts);
  try { return fn(); } finally { release(); }
}
