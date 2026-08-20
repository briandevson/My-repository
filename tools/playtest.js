/**
 * End-to-end play test: boots the real server, drives the real client in a real
 * browser, and asserts the world actually loads and responds.
 *
 * Run with `node tools/playtest.js [--keep]`. Screenshots land in tools/shots/.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = join(root, 'tools', 'shots');
const PORT = Number(process.env.PLAYTEST_PORT ?? 8099);
mkdirSync(SHOTS, { recursive: true });
// Start from a blank character every run so assertions do not depend on history.
rmSync(join(SHOTS, 'players'), { recursive: true, force: true });

const failures = [];
function check(condition, label) {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}`);
  if (!condition) failures.push(label);
}

const server = spawn(process.execPath, [join(root, 'server', 'index.js')], {
  env: { ...process.env, PORT: String(PORT), AETHERIA_DATA: join(SHOTS, 'players') },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', (data) => process.stdout.write(`[server] ${data}`));
server.stderr.on('data', (data) => process.stderr.write(`[server] ${data}`));

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
await wait(1200);

// Prefer a system/pre-provisioned Chromium when the bundled revision is absent.
function findChromium() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const roots = ['/opt/pw-browsers'];
  for (const dir of roots) {
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir)) {
      const candidate = join(dir, entry, 'chrome-linux', 'chrome');
      if (entry.startsWith('chromium-') && existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

const browser = await chromium.launch({
  executablePath: findChromium(),
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

const consoleErrors = [];
page.on('console', (message) => {
  // The web font is the only external request the page makes; some sandboxes
  // block it and the page falls back cleanly, so it is not a failure.
  const text = message.text();
  if (message.type() !== 'error') return;
  if (/fonts\.(googleapis|gstatic)\.com/.test(text) || text.includes('Failed to load resource')) return;
  consoleErrors.push(text);
});
page.on('pageerror', (error) => consoleErrors.push(String(error)));

try {
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });
  await page.fill('#login-name', 'playtest');
  await page.fill('#login-pass', 'hunter2');
  await page.click('#login-create');

  await page.waitForSelector('#hud:not([hidden])', { timeout: 10000 });
  check(true, 'logged in and the HUD appeared');
  await wait(2500);
  await page.screenshot({ path: join(SHOTS, '01-world.png') });

  // The world should have meshed terrain, scenery and the local player.
  const sceneStats = await page.evaluate(() => ({
    objects: window.__aetheria?.scene?.objectMeshes.size ?? 0,
    entities: window.__aetheria?.scene?.entities.size ?? 0,
    triangles: window.__aetheria?.scene?.renderer.info.render.triangles ?? 0,
  }));
  console.log('   scene:', JSON.stringify(sceneStats));
  check(sceneStats.entities >= 1, 'the local player exists in the scene');
  check(sceneStats.objects > 5, 'scenery is streamed in around the player');
  check(sceneStats.triangles > 1000, 'the terrain is being rendered');

  const start = await page.evaluate(() => window.__aetheria.latest.self);
  check(!!start && start.region === 'Ashford', `spawned in Ashford (got ${start?.region})`);

  // Walk somewhere and confirm the server moved us.
  await page.evaluate(
    ({ x, y }) => window.__aetheria.net.send('walk', { x, y }),
    { x: start.x, y: start.y - 6 },
  );
  await wait(4000);
  const moved = await page.evaluate(() => window.__aetheria.latest.self);
  check(moved.x !== start.x || moved.y !== start.y, `walked from ${start.x},${start.y} to ${moved.x},${moved.y}`);

  // Chat should echo back through the message log.
  await page.fill('#chatinput', 'hello world');
  await page.press('#chatinput', 'Enter');
  await wait(900);
  const chatSeen = await page.evaluate(() =>
    [...document.querySelectorAll('#chatlog div')].some((line) => line.textContent.includes('hello world')),
  );
  check(chatSeen, 'chat round-trips through the server');

  // Panels render real data.
  await page.click('.tab[data-tab="skills"]');
  await wait(400);
  const skillRows = await page.locator('.skill-row').count();
  check(skillRows === 18, `all 18 skills are listed (got ${skillRows})`);
  await page.click('.tab[data-tab="inventory"]');
  const filled = await page.locator('#inventory-grid .slot.filled').count();
  check(filled >= 10, `starter kit is in the pack (${filled} items)`);
  await page.screenshot({ path: join(SHOTS, '02-panels.png') });

  // Mine the nearest copper rock end to end.
  const mined = await page.evaluate(async () => {
    const { net, world, latest } = window.__aetheria;
    const rock = world.objects
      .filter((object) => object.type === 'copper_rock')
      .sort((a, b) => Math.hypot(a.x - latest.self.x, a.y - latest.self.y) - Math.hypot(b.x - latest.self.x, b.y - latest.self.y))[0];
    net.send('action', { kind: 'object', index: rock.index, option: 'use' });
    for (let i = 0; i < 90; i++) {
      await new Promise((resolve) => setTimeout(resolve, 600));
      const ore = window.__aetheria.inventory.find((slot) => slot?.id === 'copper_ore');
      if (ore) return { ok: true, ticks: i };
    }
    return { ok: false };
  });
  check(mined.ok, `walked to a rock and mined copper ore (after ${mined.ticks ?? '90+'} ticks)`);
  await page.screenshot({ path: join(SHOTS, '03-mining.png') });

  // Fight the nearest monster and confirm damage is exchanged.
  const fought = await page.evaluate(async () => {
    const { net } = window.__aetheria;
    const monster = window.__aetheria.latest.npcs
      .filter((npc) => npc.level > 0)
      .sort((a, b) => Math.hypot(a.x - window.__aetheria.latest.self.x, a.y - window.__aetheria.latest.self.y)
        - Math.hypot(b.x - window.__aetheria.latest.self.x, b.y - window.__aetheria.latest.self.y))[0];
    if (!monster) return { ok: false, reason: 'nothing nearby' };
    net.send('action', { kind: 'npc', id: monster.id, option: 'attack' });
    for (let i = 0; i < 60; i++) {
      await new Promise((resolve) => setTimeout(resolve, 600));
      const live = window.__aetheria.latest.npcs.find((npc) => npc.id === monster.id);
      if (!live) return { ok: true, name: monster.name, killed: true };
      if (live.hits < live.maxHits) return { ok: true, name: monster.name, hits: `${live.hits}/${live.maxHits}` };
    }
    return { ok: false, reason: 'no damage dealt' };
  });
  check(fought.ok, `fought a monster (${JSON.stringify(fought)})`);
  await page.screenshot({ path: join(SHOTS, '04-combat.png') });

  // Chop a tree, then burn the logs with the tinderbox. Lighting is a 35% roll
  // at level 1, so this retries - each retry must pick a tree that has not
  // already been chopped, which the scene's override map knows about.
  const fire = await page.evaluate(async () => {
    const { net, scene } = window.__aetheria;
    const self = () => window.__aetheria.latest.self;
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    const nearestLiveTree = () =>
      window.__aetheria.world.objects
        .filter((object) => scene.objectTypeAt(object.index) === 'tree')
        .sort((a, b) => Math.hypot(a.x - self().x, a.y - self().y) - Math.hypot(b.x - self().x, b.y - self().y))[0];

    const chopSomeLogs = async () => {
      const tree = nearestLiveTree();
      if (!tree) return false;
      net.send('action', { kind: 'object', index: tree.index, option: 'use' });
      for (let i = 0; i < 60; i++) {
        await sleep(600);
        if (window.__aetheria.inventory.some((slot) => slot?.id === 'logs')) return true;
      }
      return false;
    };

    for (let attempt = 1; attempt <= 12; attempt++) {
      if (!window.__aetheria.inventory.some((slot) => slot?.id === 'logs')) {
        if (!(await chopSomeLogs())) return { ok: false, reason: 'could not chop logs', attempt };
      }
      const tinderbox = window.__aetheria.inventory.findIndex((slot) => slot?.id === 'tinderbox');
      const logs = window.__aetheria.inventory.findIndex((slot) => slot?.id === 'logs');
      net.send('inv', { act: 'use', slot: tinderbox, targetKind: 'item', to: logs });
      await sleep(1500);
      if (window.__aetheria.latest.objects.some((object) => object.type === 'fire')) {
        return { ok: true, attempts: attempt };
      }
    }
    return { ok: false, reason: 'never caught light' };
  });
  check(fire.ok, `chopped a tree and lit a fire (${JSON.stringify(fire)})`);
  await page.screenshot({ path: join(SHOTS, '05-fire.png') });

  check(consoleErrors.length === 0, `no console errors (${consoleErrors.slice(0, 3).join(' | ') || 'none'})`);
} catch (error) {
  console.error('playtest threw:', error);
  failures.push(String(error));
  await page.screenshot({ path: join(SHOTS, 'error.png') }).catch(() => {});
} finally {
  if (!process.argv.includes('--keep')) {
    await browser.close();
    server.kill('SIGTERM');
  }
}

console.log(failures.length === 0 ? '\nAll play-test checks passed.' : `\n${failures.length} check(s) failed.`);
process.exit(failures.length === 0 ? 0 : 1);
