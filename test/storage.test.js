import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createFileStorage, createMemoryStorage, createPostgresStorage } from '../server/storage.js';
import { Player, giveStarterKit } from '../server/player.js';

/**
 * Every backend must behave the same, because the choice of backend is an
 * operational detail and a character must not notice it.
 *
 * The Postgres case needs a database: set TEST_DATABASE_URL to run it
 * (`npm run test:db`). It is skipped, not failed, when there is none.
 */
const backends = [
  ['memory', () => createMemoryStorage()],
  ['file', () => createFileStorage(mkdtempSync(join(tmpdir(), 'aetheria-storage-')))],
];
if (process.env.TEST_DATABASE_URL) {
  backends.push(['postgres', () => createPostgresStorage(process.env.TEST_DATABASE_URL)]);
}

for (const [name, make] of backends) {
  test(`${name}: stores, overwrites and reports missing records`, async () => {
    const storage = make();
    await storage.init();
    try {
      const key = `probe_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
      assert.equal(await storage.read(key), null, 'a missing record reads as null');

      await storage.write(key, { name: key, count: 1, nested: { deep: [1, 2, 3] } });
      assert.deepEqual(await storage.read(key), { name: key, count: 1, nested: { deep: [1, 2, 3] } });

      await storage.write(key, { name: key, count: 2, nested: { deep: [] } });
      assert.equal((await storage.read(key)).count, 2, 'a second write replaces the first');
    } finally {
      await storage.close();
    }
  });

  test(`${name}: a character survives being written and read back`, async () => {
    const storage = make();
    await storage.init();
    try {
      const key = `char_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
      const player = new Player(key, { readyState: 1, send() {} });
      giveStarterKit(player);
      player.addXp('woodcutting', 8000);
      player.x = 42;
      player.y = 118;
      player.friends.add('wren');

      await storage.write(key, { name: key, save: player.toSave() });

      const restored = new Player(key, { readyState: 1, send() {} });
      restored.loadSave((await storage.read(key)).save);
      assert.equal(restored.level('woodcutting'), player.level('woodcutting'));
      assert.deepEqual({ x: restored.x, y: restored.y }, { x: 42, y: 118 });
      assert.equal(restored.inventory.filter(Boolean).length, player.inventory.filter(Boolean).length);
      assert.ok(restored.friends.has('wren'));
    } finally {
      await storage.close();
    }
  });
}
