/**
 * Checks the published demo build: it must load with no server, play, and
 * remember the character - on a desktop and on a phone.
 */
import { chromium, devices } from 'playwright';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = join(root, 'tools', 'shots');
const FILE = process.argv[2] ?? join(root, 'dist', 'aetheria.html');
const PORT = 8094;
mkdirSync(SHOTS, { recursive: true });

const failures = [];
const check = (ok, label) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failures.push(label);
};
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

const errors = [];
const FONT_HOSTS = /fonts\.(googleapis|gstatic)\.com/;
async function open(deviceName) {
  const context = deviceName
    ? await browser.newContext({ ...devices[deviceName] })
    : await browser.newContext({ viewport: { width: 1280, height: 800 } });
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
  const page = await open(null);

  // The demo presents itself honestly: one button, no password, no accounts.
  check(await page.locator('#login-pass').isHidden(), 'the password field is hidden');
  check(await page.locator('#login-create').isHidden(), 'only one way in');
  const hint = await page.textContent('.hint');
  check(/demo/i.test(hint), `the page says it is a demo (${hint.trim().slice(0, 60)}...)`);

  await page.fill('#login-name', 'gwyn');
  await page.click('#login-go');
  await page.waitForSelector('#hud:not([hidden])', { timeout: 15000 });
  await wait(3000);
  check(true, 'the world booted with no server');

  const stats = await page.evaluate(() => ({
    entities: window.__aetheria.scene.entities.size,
    objects: window.__aetheria.scene.objectMeshes.size,
    triangles: window.__aetheria.scene.renderer.info.render.triangles,
    region: window.__aetheria.latest.self.region,
    name: window.__aetheria.latest.players[0]?.name,
  }));
  console.log('   scene:', JSON.stringify(stats));
  check(stats.triangles > 1000 && stats.entities >= 1, 'the world renders');
  check(stats.region === 'Ashford', `spawned in Ashford (${stats.region})`);
  check(stats.name === 'Gwyn', `the character is named (${stats.name})`);
  check((await page.locator('.tab[data-tab="social"]').count()) === 0, 'the social tab is gone in single player');
  await page.screenshot({ path: join(SHOTS, 'demo-01-world.png') });

  // A full skill loop, end to end.
  const mined = await page.evaluate(async () => {
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
  check(mined, 'mining works');
  await page.screenshot({ path: join(SHOTS, 'demo-02-mining.png') });

  // Progress survives a reload, and the button offers to continue.
  const xpBefore = await page.evaluate(() => {
    window.__aetheria.net.save();
    return window.__aetheria.stats.mining.xp;
  });
  await page.reload({ waitUntil: 'load' });
  await wait(500);
  check(/continue as gwyn/i.test(await page.textContent('#login-go')), 'it offers to continue the saved character');
  await page.click('#login-go');
  await page.waitForSelector('#hud:not([hidden])', { timeout: 15000 });
  await wait(2000);
  const xpAfter = await page.evaluate(() => window.__aetheria.stats.mining.xp);
  check(xpAfter === xpBefore && xpAfter > 0, `progress survives a reload (${xpBefore} -> ${xpAfter} mining xp)`);

  // And it all works on a phone, by touch.
  const phone = await open('iPhone 13');
  await phone.fill('#login-name', 'wren');
  await phone.tap('#login-go');
  await phone.waitForSelector('#hud:not([hidden])', { timeout: 15000 });
  await wait(3000);
  check((await phone.locator('#panel.collapsed').count()) === 1, 'the phone layout starts collapsed');

  const target = await phone.evaluate(() => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    for (let fy = 0.35; fy <= 0.7; fy += 0.05) {
      for (const fx of [0.5, 0.3, 0.7]) {
        const x = Math.round(w * fx);
        const y = Math.round(h * fy);
        if (document.elementFromPoint(x, y)?.id !== 'view') continue;
        if (window.__aetheria.scene.pick((x / w) * 2 - 1, -(y / h) * 2 + 1)?.kind === 'tile') return [x, y];
      }
    }
    return null;
  });
  const before = await phone.evaluate(() => ({ ...window.__aetheria.latest.self }));
  await phone.touchscreen.tap(target[0], target[1]);
  await wait(3500);
  const after = await phone.evaluate(() => ({ ...window.__aetheria.latest.self }));
  check(after.x !== before.x || after.y !== before.y, `tap walks on the phone (${before.x},${before.y} -> ${after.x},${after.y})`);
  await phone.screenshot({ path: join(SHOTS, 'demo-03-phone.png') });

  check(errors.length === 0, `no console errors (${errors.slice(0, 3).join(' | ') || 'none'})`);
} catch (error) {
  console.error('demo test threw:', error);
  failures.push(String(error));
} finally {
  await browser.close();
  server.close();
}

console.log(failures.length === 0 ? '\nAll demo checks passed.' : `\n${failures.length} check(s) failed.`);
process.exit(failures.length === 0 ? 0 : 1);
