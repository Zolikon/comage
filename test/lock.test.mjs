import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquire, withLock } from '../lib/lock.mjs';

const lockFile = () => join(mkdtempSync(join(tmpdir(), 'rw-lock-')), 'x.lock');

test('a held lock keeps a second taker out until it is released', () => {
  const file = lockFile();
  const release = acquire(file);
  assert.throws(() => acquire(file, { timeout: 80 }), (e) => e.status === 503 && /locked/.test(e.message));
  release();
  assert.equal(existsSync(file), false);
  acquire(file, { timeout: 80 })();
});

test('a lock left behind by a dead process is taken over', () => {
  const file = lockFile();
  writeFileSync(file, '2147483646'); // no such process
  const release = acquire(file, { timeout: 80 });
  release();
  assert.equal(existsSync(file), false);
});

test('withLock releases when the callback throws', () => {
  const file = lockFile();
  assert.throws(() => withLock(file, () => { throw new Error('boom'); }), /boom/);
  assert.equal(withLock(file, () => 'ok', { timeout: 80 }), 'ok');
});
