/**
 * Play test on a phone-sized device with touch input, against the real server.
 * Phones are first-class clients: the same shared world, the same social
 * features, driven by taps instead of clicks. Screenshots land in tools/shots/.
 */
import { chromium, devices } from 'playwright';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = join(root, 'tools', 'shots');
const PORT = Number(process.env.MOBILETEST_PORT ?? 8097);
mkdirSync(SHOTS, { recursive: true });
rmSync(join(SHOTS, 'mobile-players'), { recursive: true, force: true });

const failures = [];
const check = (ok, label) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failures.push(label);
};
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const server = spawn(process.execPath, [join(root, 'server', 'index.js')], {
  env: { ...process.env, PORT: String(PORT), AETHERIA_DATA: join(SHOTS, 'mobile-players') },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stderr.on('data', (data) => process.stderr.write(`[server] ${data}`));
await wait(1200);

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

const errors = [];
const FONT_HOSTS = /fonts\.(googleapis|gstatic)\.com/;
async function open(device) {
  const context = await browser.newContext({ ...devices[device] });
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(String(error)));
  page.on('console', (message) => {
    const text = message.text();
    if (message.type() !== 'error') return;
    if (FONT_HOSTS.test(text) || text.includes('Failed to load resource')) return;
    errors.push(text);
  });
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });
  return page;
}

try {
  const phone = await open('iPhone 13');

  // --- Registration and unique names -------------------------------------
  await phone.fill('#login-name', 'wren');
  await phone.fill('#login-pass', 'hunter2');
  await phone.tap('#login-go');
  await wait(1200);
  const loginError = await phone.textContent('#login-error');
  check(loginError.includes('No character'), `logging in to a name that does not exist is refused (${loginError})`);

  await phone.tap('#login-create');
  await phone.waitForSelector('#hud:not([hidden])', { timeout: 15000 });
  await wait(3000);
  check(true, 'creating the character logs straight in');

  const stats = await phone.evaluate(() => ({
    entities: window.__aetheria.scene.entities.size,
    objects: window.__aetheria.scene.objectMeshes.size,
    triangles: window.__aetheria.scene.renderer.info.render.triangles,
  }));
  console.log('   scene:', JSON.stringify(stats));
  check(stats.triangles > 1000 && stats.entities >= 1, 'the world renders on the phone');
  check((await phone.locator('#panel.collapsed').count()) === 1, 'the panel starts collapsed');
  await phone.screenshot({ path: join(SHOTS, 'ios-01-world.png') });

  // --- A second person cannot take the same name --------------------------
  const rival = await open('iPhone 13');
  await rival.fill('#login-name', 'WREN');
  await rival.fill('#login-pass', 'different');
  await rival.tap('#login-create');
  await wait(1200);
  const taken = await rival.textContent('#login-error');
  check(/already taken/i.test(taken), `the name is taken, capitals and all (${taken})`);

  // The rival makes their own character and joins the same world.
  await rival.fill('#login-name', 'finch');
  await rival.fill('#login-pass', 'hunter2');
  await rival.tap('#login-create');
  await rival.waitForSelector('#hud:not([hidden])', { timeout: 15000 });
  await wait(2500);
  const seen = await phone.evaluate(() => window.__aetheria.latest.players.map((p) => p.name));
  check(seen.includes('Finch'), `wren sees finch in the shared world (${seen.join(', ')})`);

  // --- Social features work from a phone ----------------------------------
  await phone.tap('.tab[data-tab="social"]');
  await wait(400);
  await phone.fill('#friend-name', 'finch');
  await phone.tap('#friend-add');
  await wait(900);
  check((await phone.locator('#friends-list .friend-row.online').count()) === 1, 'wren added finch as a friend from the phone');
  await phone.screenshot({ path: join(SHOTS, 'ios-02-social.png') });

  await phone.evaluate(() => window.__aetheria.net.send('pm', { to: 'finch', text: 'on my way' }));
  await wait(900);
  const finchChat = await rival.evaluate(() =>
    [...document.querySelectorAll('#chatlog div')].map((line) => line.textContent));
  check(finchChat.some((line) => line.includes('Wren tells you: on my way')), 'the private message arrived');

  await phone.tap('.tab[data-tab="social"]');
  await wait(300);

  // --- Touch controls -----------------------------------------------------
  const before = await phone.evaluate(() => ({ ...window.__aetheria.latest.self }));
  const target = await phone.evaluate(() => {
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
  await phone.touchscreen.tap(target[0], target[1]);
  await wait(3500);
  const after = await phone.evaluate(() => ({ ...window.__aetheria.latest.self }));
  check(after.x !== before.x || after.y !== before.y, `tap walks (${before.x},${before.y} -> ${after.x},${after.y})`);

  const yaw = await phone.evaluate(() => window.__aetheria.scene.cameraYaw);
  await phone.evaluate(() => {
    const canvas = document.getElementById('view');
    const send = (type, x, y) =>
      canvas.dispatchEvent(new PointerEvent(type, { pointerId: 1, pointerType: 'touch', clientX: x, clientY: y, bubbles: true, isPrimary: true }));
    send('pointerdown', 200, 320);
    for (let x = 200; x <= 300; x += 20) send('pointermove', x, 320);
    send('pointerup', 300, 320);
  });
  await wait(200);
  check((await phone.evaluate(() => window.__aetheria.scene.cameraYaw)) !== yaw, 'dragging orbits the camera');

  await phone.evaluate(() => {
    document.getElementById('view').dispatchEvent(new PointerEvent('pointerdown', {
      pointerId: 7, pointerType: 'touch', clientX: 195, clientY: 300, bubbles: true, isPrimary: true,
    }));
  });
  await wait(700);
  const menuItems = await phone.locator('#contextmenu:not([hidden]) .cm-item').count();
  check(menuItems > 0, `long press opens the options menu (${menuItems} options)`);
  await phone.screenshot({ path: join(SHOTS, 'ios-03-menu.png') });
  await phone.evaluate(() => {
    document.getElementById('view').dispatchEvent(new PointerEvent('pointerup', {
      pointerId: 7, pointerType: 'touch', clientX: 195, clientY: 300, bubbles: true, isPrimary: true,
    }));
  });

  // --- A full skill loop from the phone -----------------------------------
  const mined = await phone.evaluate(async () => {
    const { net, world, scene } = window.__aetheria;
    const self = () => window.__aetheria.latest.self;
    const rock = world.objects
      .filter((object) => scene.objectTypeAt(object.index) === 'copper_rock')
      .sort((a, b) => Math.hypot(a.x - self().x, a.y - self().y) - Math.hypot(b.x - self().x, b.y - self().y))[0];
    net.send('action', { kind: 'object', index: rock.index, option: 'use' });
    for (let i = 0; i < 100; i++) {
      await new Promise((resolve) => setTimeout(resolve, 600));
      if (window.__aetheria.inventory.some((slot) => slot?.id === 'copper_ore')) return true;
    }
    return false;
  });
  check(mined, 'mining works from a phone');

  // --- Progress persists across a reconnect -------------------------------
  const xpBefore = await phone.evaluate(() => window.__aetheria.stats?.mining?.xp ?? 0);
  await phone.reload({ waitUntil: 'load' });
  await phone.fill('#login-name', 'wren');
  await phone.fill('#login-pass', 'hunter2');
  await phone.tap('#login-go');
  await phone.waitForSelector('#hud:not([hidden])', { timeout: 15000 });
  await wait(2500);
  const xpAfter = await phone.evaluate(() => window.__aetheria.stats?.mining?.xp ?? 0);
  check(xpAfter >= xpBefore && xpAfter > 0, `progress is on the server (${xpBefore} -> ${xpAfter} mining xp)`);

  check(errors.length === 0, `no console errors (${errors.slice(0, 3).join(' | ') || 'none'})`);
} catch (error) {
  console.error('mobile test threw:', error);
  failures.push(String(error));
} finally {
  await browser.close();
  server.kill('SIGTERM');
}

console.log(failures.length === 0 ? '\nAll mobile checks passed.' : `\n${failures.length} check(s) failed.`);
process.exit(failures.length === 0 ? 0 : 1);
