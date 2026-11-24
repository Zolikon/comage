import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sessionTitle } from '../lib/session.mjs';
import { fakeSession } from './helpers.mjs';
const ai = (aiTitle) => ({ type: 'ai-title', aiTitle, sessionId: 's1' });
const custom = (customTitle) => ({ type: 'custom-title', customTitle, sessionId: 's1' });

test('the title is the latest one Claude Code generated for the session', () => {
  const { configDir } = fakeSession('s1', [ai('First guess'), { type: 'user', message: { content: 'hi' } }, ai('Auth spec review')]);
  assert.equal(sessionTitle('s1', { configDir }), 'Auth spec review');
});

test('a name the user gave the session wins over generated titles, also later ones', () => {
  const { configDir } = fakeSession('s1', [ai('Generated'), custom('My name'), ai('Generated again')]);
  assert.equal(sessionTitle('s1', { configDir }), 'My name');
});

test('a title that changes while the session runs is picked up on the next read', () => {
  const s = fakeSession('s1', [ai('Before')]);
  assert.equal(sessionTitle('s1', s), 'Before');
  s.add(ai('After'));
  assert.equal(sessionTitle('s1', s), 'After');
  s.add(custom('Renamed'));
  assert.equal(sessionTitle('s1', s), 'Renamed');
  s.add(custom('Renamed twice'));
  assert.equal(sessionTitle('s1', s), 'Renamed twice');
});

test('an entry still being written is ignored until its line is complete', () => {
  const s = fakeSession('s1', [ai('Whole')]);
  const half = JSON.stringify(ai('Half written'));
  appendFileSync(s.file, half.slice(0, 20));
  assert.equal(sessionTitle('s1', s), 'Whole');
  appendFileSync(s.file, `${half.slice(20)}\n`);
  assert.equal(sessionTitle('s1', s), 'Half written');
});

test('text in a message that looks like a title entry is not a title', () => {
  const { configDir } = fakeSession('s1', [ai('Real'), { type: 'user', message: { content: JSON.stringify(custom('Quoted in chat')) } }]);
  assert.equal(sessionTitle('s1', { configDir }), 'Real');
});

test('a transcript that was rewritten shorter is read again from the start', () => {
  const s = fakeSession('s1', [ai('Old'), ai('Old but longer, so that the file shrinks')]);
  assert.equal(sessionTitle('s1', s), 'Old but longer, so that the file shrinks');
  writeFileSync(s.file, `${JSON.stringify(ai('New'))}\n`);
  assert.equal(sessionTitle('s1', s), 'New');
});

test('no title: unknown session, no title entries yet, no session id, or an id that is not a file name', () => {
  const { configDir } = fakeSession('s1', [{ type: 'user', message: { content: 'hi' } }]);
  assert.equal(sessionTitle('s1', { configDir }), null);
  assert.equal(sessionTitle('nope', { configDir }), null);
  assert.equal(sessionTitle(null, { configDir }), null);
  assert.equal(sessionTitle('../projects/-some-project/s1', { configDir }), null);
  assert.equal(sessionTitle('s1', { configDir: join(configDir, 'missing') }), null);
});
