import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createFileStorage, createMemoryStorage, createStorage } from '../server/storage.js';
import { authenticate, nameAvailable, normaliseName, useStorage, persistPlayer } from '../server/persistence.js';
import { Player, giveStarterKit } from '../server/player.js';

const dir = mkdtempSync(join(tmpdir(), 'aetheria-accounts-'));
await useStorage(createFileStorage(dir));

test.after(() => rmSync(dir, { recursive: true, force: true }));

test('a name can only be registered once', async () => {
  assert.equal(await nameAvailable('gwyn'), true);
  const first = await authenticate('gwyn', 'hunter2', true);
  assert.equal(first.ok, true);
  assert.equal(first.fresh, true);
  assert.equal(await nameAvailable('gwyn'), false);

  const second = await authenticate('gwyn', 'somethingelse', true);
  assert.equal(second.ok, false);
  assert.match(second.reason, /already taken/i);
});

test('names are case- and space-insensitive, so lookalikes cannot be registered', async () => {
  await authenticate('rowan', 'hunter2', true);
  for (const variant of ['Rowan', 'ROWAN', '  rowan  ']) {
    const attempt = await authenticate(variant, 'hunter2', true);
    assert.equal(attempt.ok, false, `${variant} should collide with rowan`);
    assert.match(attempt.reason, /already taken/i);
  }
  assert.equal(normaliseName('Robin Hood'), 'robin_hood');
});

test('logging in needs an existing name and the right password', async () => {
  await authenticate('finch', 'hunter2', true);

  const missing = await authenticate('nobody', 'hunter2', false);
  assert.equal(missing.ok, false);
  assert.match(missing.reason, /No character/i);

  const wrong = await authenticate('finch', 'wrongpass', false);
  assert.equal(wrong.ok, false);
  assert.match(wrong.reason, /Incorrect password/i);

  const right = await authenticate('FINCH', 'hunter2', false);
  assert.equal(right.ok, true);
  assert.equal(right.name, 'finch', 'you get the canonical name back');
  assert.equal(right.fresh, false);
});

test('invalid names and short passwords are rejected before anything is stored', async () => {
  for (const bad of ['', 'a', 'way_too_long_name', 'bad name!', '../etc/passwd']) {
    const attempt = await authenticate(bad, 'hunter2', true);
    assert.equal(attempt.ok, false, `${bad} should be rejected`);
  }
  const short = await authenticate('sparrow', 'abc', true);
  assert.equal(short.ok, false);
  assert.match(short.reason, /at least 4/i);
  assert.equal(await nameAvailable('sparrow'), true, 'a rejected registration stores nothing');
});

test('passwords are never stored in the clear', async () => {
  const result = await authenticate('wren', 'correct horse', true);
  const stored = JSON.stringify(result.account);
  assert.ok(!stored.includes('correct horse'), 'the password does not appear in the record');
  assert.ok(result.account.salt && result.account.hash);
});

test('a character round-trips through storage with progress intact', async () => {
  await authenticate('magpie', 'hunter2', true);
  const player = new Player('magpie', { readyState: 1, send() {} });
  giveStarterKit(player);
  player.addXp('mining', 5000);
  player.x = 91;
  player.y = 64;
  player.friends.add('wren');
  assert.equal(await persistPlayer(player), true);

  const reloaded = await authenticate('magpie', 'hunter2', false);
  const restored = new Player('magpie', { readyState: 1, send() {} });
  restored.loadSave(reloaded.account.save);
  assert.equal(restored.stats.mining.xp, player.stats.mining.xp);
  assert.equal(restored.level('mining'), player.level('mining'));
  assert.deepEqual({ x: restored.x, y: restored.y }, { x: 91, y: 64 });
  assert.ok(restored.friends.has('wren'));
});

test('the backend is chosen by environment, defaulting to files', () => {
  assert.equal(createStorage({ AETHERIA_STORAGE: 'memory' }).kind, 'memory');
  assert.equal(createStorage({ DATABASE_URL: 'postgres://example/db' }).kind, 'postgres');
  assert.equal(createStorage({ AETHERIA_DATA: dir }).kind, 'file');
});

test('storage backends behave identically', async () => {
  for (const storage of [createMemoryStorage(), createFileStorage(mkdtempSync(join(tmpdir(), 'aetheria-store-')))]) {
    await storage.init();
    assert.equal(await storage.read('nobody'), null, `${storage.kind}: missing keys read as null`);
    await storage.write('gwyn', { name: 'gwyn', save: { x: 1 } });
    assert.deepEqual(await storage.read('gwyn'), { name: 'gwyn', save: { x: 1 } }, `${storage.kind}: round-trip`);
    await storage.write('gwyn', { name: 'gwyn', save: { x: 2 } });
    assert.equal((await storage.read('gwyn')).save.x, 2, `${storage.kind}: writes overwrite`);
    await storage.close();
  }
});
