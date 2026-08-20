/**
 * Play test for the standalone single-player build on a phone-sized device
 * with touch input. Screenshots land in tools/shots/.
 */
import { chromium, devices } from 'playwright';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = join(root, 'tools', 'shots');
const FILE = process.argv[2] ?? join(root, 'dist', 'aetheria.html');
const PORT = 8111;
mkdirSync(SHOTS, { recursive: true });

const failures = [];
const check = (ok, label) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failures.push(label);
};

const page_html = readFileSync(FILE);
const server = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(page_html);
}).listen(PORT);

function findChromium() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  for (const entry of existsSync('/opt/pw-browsers') ? readdirSync('/opt/pw-browsers') : []) {
    const candidate = join('/opt/pw-browsers', entry, 'chrome-linux', 'chrome');
    if (entry.startsWith('chromium-') && existsSync(candidate)) return candidate;
  }
  return undefined;
}

const browser = await chromium.launch({
  executablePath: findChromium(),
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const context = await browser.newContext({ ...devices['iPhone 13'] });
const page = await context.newPage();

const errors = [];
const FONT_HOSTS = /fonts\.(googleapis|gstatic)\.com/;
page.on('console', (message) => {
  // The web font is the one external request; some sandboxes block it, and the
  // page is designed to fall back cleanly, so it is not a failure.
  const text = message.text();
  if (message.type() !== 'error') return;
  if (FONT_HOSTS.test(text) || text.includes('Failed to load resource')) return;
  errors.push(text);
});
page.on('requestfailed', (request) => {
  if (!FONT_HOSTS.test(request.url())) errors.push(`request failed: ${request.url()}`);
});
page.on('pageerror', (error) => errors.push(String(error)));

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

try {
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });
  check((await page.locator('#login-name').count()) === 1, 'the start screen renders');
  check(await page.locator('#login-pass').isHidden().catch(() => false) === false, 'name field is present');

  await page.fill('#login-name', 'wren');
  await page.tap('#login-go');
  await page.waitForSelector('#hud:not([hidden])', { timeout: 15000 });
  await wait(3000);
  check(true, 'the world booted with no server');

  const stats = await page.evaluate(() => ({
    entities: window.__aetheria.scene.entities.size,
    objects: window.__aetheria.scene.objectMeshes.size,
    triangles: window.__aetheria.scene.renderer.info.render.triangles,
    name: window.__aetheria.latest.players.find((p) => p.id === 1)?.name,
  }));
  console.log('   scene:', JSON.stringify(stats));
  check(stats.triangles > 1000 && stats.entities >= 1, 'the world renders on the phone');
  check(stats.name === 'Wren', `the character is named (${stats.name})`);

  // The panel starts collapsed so the world keeps the screen.
  const collapsed = await page.locator('#panel.collapsed').count();
  check(collapsed === 1, 'the panel starts collapsed on a phone');
  await page.screenshot({ path: join(SHOTS, 'ios-01-world.png') });

  await page.tap('.tab[data-tab="inventory"]');
  await wait(400);
  check((await page.locator('#panel.collapsed').count()) === 0, 'tapping a tab opens the sheet');
  check((await page.locator('#inventory-grid .slot.filled').count()) >= 10, 'the starter kit is there');
  await page.screenshot({ path: join(SHOTS, 'ios-02-panel.png') });
  await page.tap('.tab[data-tab="inventory"]');
  await wait(300);
  check((await page.locator('#panel.collapsed').count()) === 1, 'tapping it again closes the sheet');

  // A tap on the world walks there.
  const before = await page.evaluate(() => ({ ...window.__aetheria.latest.self }));
  // Aim at a point that is both ground in the 3D scene and not under any HUD
  // element: a tap on the sky or on the panel correctly does not walk.
  const target = await page.evaluate(() => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    for (let fy = 0.35; fy <= 0.75; fy += 0.05) {
      for (const fx of [0.5, 0.3, 0.7]) {
        const x = Math.round(w * fx);
        const y = Math.round(h * fy);
        if (document.elementFromPoint(x, y)?.id !== 'view') continue;
        const hit = window.__aetheria.scene.pick((x / w) * 2 - 1, -(y / h) * 2 + 1);
        if (hit?.kind === 'tile') return [x, y];
      }
    }
    return null;
  });
  check(!!target, `found open ground to tap (${target})`);
  await page.touchscreen.tap(target[0], target[1]);
  await wait(3500);
  const after = await page.evaluate(() => ({ ...window.__aetheria.latest.self }));
  check(after.x !== before.x || after.y !== before.y, `tap walks (${before.x},${before.y} -> ${after.x},${after.y})`);

  // A drag orbits the camera rather than walking.
  const yaw = await page.evaluate(() => window.__aetheria.scene.cameraYaw);
  await page.touchscreen.tap(1, 1).catch(() => {});
  await page.locator('#view').hover({ position: { x: 200, y: 320 } }).catch(() => {});
  await page.evaluate(() => {
    const canvas = document.getElementById('view');
    const send = (type, x, y, id = 1) =>
      canvas.dispatchEvent(new PointerEvent(type, { pointerId: id, pointerType: 'touch', clientX: x, clientY: y, bubbles: true, isPrimary: true }));
    send('pointerdown', 200, 320);
    for (let x = 200; x <= 300; x += 20) send('pointermove', x, 320);
    send('pointerup', 300, 320);
  });
  await wait(200);
  const yawAfter = await page.evaluate(() => window.__aetheria.scene.cameraYaw);
  check(yawAfter !== yaw, 'dragging orbits the camera');

  // A long press opens the options menu.
  await page.evaluate(() => {
    const canvas = document.getElementById('view');
    canvas.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 7, pointerType: 'touch', clientX: 195, clientY: 300, bubbles: true, isPrimary: true }));
  });
  await wait(700);
  const menuOpen = await page.locator('#contextmenu:not([hidden]) .cm-item').count();
  check(menuOpen > 0, `long press opens the options menu (${menuOpen} options)`);
  await page.screenshot({ path: join(SHOTS, 'ios-03-menu.png') });
  await page.evaluate(() => {
    document.getElementById('view').dispatchEvent(new PointerEvent('pointerup', { pointerId: 7, pointerType: 'touch', clientX: 195, clientY: 300, bubbles: true, isPrimary: true }));
  });

  // Mine some ore, so a full skill loop is proven on the phone build.
  const mined = await page.evaluate(async () => {
    const { net, world } = window.__aetheria;
    const self = () => window.__aetheria.latest.self;
    const rock = world.objects
      .filter((object) => object.type === 'copper_rock')
      .sort((a, b) => Math.hypot(a.x - self().x, a.y - self().y) - Math.hypot(b.x - self().x, b.y - self().y))[0];
    net.send('action', { kind: 'object', index: rock.index, option: 'use' });
    for (let i = 0; i < 100; i++) {
      await new Promise((resolve) => setTimeout(resolve, 600));
      if (window.__aetheria.inventory.some((slot) => slot?.id === 'copper_ore')) return true;
    }
    return false;
  });
  check(mined, 'mining works in the standalone build');

  // Progress survives a reload.
  const xpBefore = await page.evaluate(() => {
    window.__aetheria.net.save();
    return window.__aetheria.net.player.stats.mining.xp;
  });
  await page.reload({ waitUntil: 'load' });
  await page.fill('#login-name', 'wren');
  await page.tap('#login-go');
  await page.waitForSelector('#hud:not([hidden])', { timeout: 15000 });
  await wait(1500);
  const xpAfter = await page.evaluate(() => window.__aetheria.net.player.stats.mining.xp);
  check(xpAfter === xpBefore && xpAfter > 0, `progress survives a reload (${xpBefore} -> ${xpAfter} mining xp)`);

  check(errors.length === 0, `no console errors (${errors.slice(0, 3).join(' | ') || 'none'})`);
} catch (error) {
  console.error('mobile test threw:', error);
  failures.push(String(error));
  await page.screenshot({ path: join(SHOTS, 'ios-error.png') }).catch(() => {});
} finally {
  await browser.close();
  server.close();
}

console.log(failures.length === 0 ? '\nAll mobile checks passed.' : `\n${failures.length} check(s) failed.`);
process.exit(failures.length === 0 ? 0 : 1);
