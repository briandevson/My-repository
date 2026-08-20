/**
 * Two real browsers, two players, one server: friends, private messages,
 * following, trading and the friend dot on the minimap.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = join(root, 'tools', 'shots');
const PORT = Number(process.env.SOCIALTEST_PORT ?? 8098);
mkdirSync(SHOTS, { recursive: true });
rmSync(join(SHOTS, 'social-players'), { recursive: true, force: true });

const failures = [];
const check = (ok, label) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failures.push(label);
};
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const server = spawn(process.execPath, [join(root, 'server', 'index.js')], {
  env: { ...process.env, PORT: String(PORT), AETHERIA_DATA: join(SHOTS, 'social-players') },
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
async function login(name) {
  const context = await browser.newContext({ viewport: { width: 1100, height: 760 } });
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(`${name}: ${error}`));
  page.on('console', (message) => {
    const text = message.text();
    if (message.type() !== 'error') return;
    if (/fonts\.(googleapis|gstatic)\.com/.test(text) || text.includes('Failed to load resource')) return;
    errors.push(`${name}: ${text}`);
  });
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });
  await page.fill('#login-name', name);
  await page.fill('#login-pass', 'hunter2');
  await page.click('#login-create');
  await page.waitForSelector('#hud:not([hidden])', { timeout: 15000 });
  await wait(2000);
  return page;
}

const chatLines = (page) =>
  page.evaluate(() => [...document.querySelectorAll('#chatlog div')].map((line) => line.textContent));
const self = (page) => page.evaluate(() => ({ ...window.__aetheria.latest.self }));

try {
  const alice = await login('alice');
  const bob = await login('bob');
  check(true, 'two players logged into one world');

  // Names are unique across the server, capitals and all.
  const impostor = await browser.newContext({ viewport: { width: 900, height: 700 } });
  const impostorPage = await impostor.newPage();
  await impostorPage.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });
  await impostorPage.fill('#login-name', 'Alice');
  await impostorPage.fill('#login-pass', 'notalice');
  await impostorPage.click('#login-create');
  await wait(1000);
  const taken = await impostorPage.textContent('#login-error');
  check(/already taken/i.test(taken), `a second Alice is refused (${taken})`);

  // And the real Alice cannot be logged in twice at once.
  await impostorPage.fill('#login-pass', 'hunter2');
  await impostorPage.click('#login-go');
  await wait(1000);
  const doubled = await impostorPage.textContent('#login-error');
  check(/already logged in/i.test(doubled), `one session per character (${doubled})`);
  await impostor.close();

  // Each should see the other in the world.
  const aliceSees = await alice.evaluate(() => window.__aetheria.latest.players.map((p) => p.name));
  check(aliceSees.includes('Bob'), `alice sees bob in the world (${aliceSees.join(', ')})`);

  // --- Friends -----------------------------------------------------------
  await alice.click('.tab[data-tab="social"]');
  await alice.fill('#friend-name', 'bob');
  await alice.click('#friend-add');
  await wait(900);
  const friendRow = await alice.locator('#friends-list .friend-row.online').count();
  check(friendRow === 1, `bob appears on alice's friends list as online (${friendRow})`);
  await alice.screenshot({ path: join(SHOTS, 'social-01-friends.png') });

  // --- Friend shows as a green dot on the minimap -------------------------
  // Both players spawn on the same tile, where the "you" marker is drawn last
  // and covers everything, so step bob aside before looking.
  const spawn = await self(bob);
  await bob.evaluate(({ x, y }) => window.__aetheria.net.send('walk', { x: x + 6, y }), spawn);
  await wait(4000);
  const greenDot = await alice.evaluate(() => {
    const canvas = document.getElementById('minimap');
    const ctx = canvas.getContext('2d');
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    for (let i = 0; i < data.length; i += 4) {
      // #4ade80, the friend colour
      if (data[i] === 74 && data[i + 1] === 222 && data[i + 2] === 128) return true;
    }
    return false;
  });
  check(greenDot, 'the friend is drawn as a green dot on the minimap');

  // --- Private message ----------------------------------------------------
  await alice.evaluate(() => window.__aetheria.net.send('pm', { to: 'bob', text: 'meet me at the bank' }));
  await wait(900);
  const bobChat = await chatLines(bob);
  check(
    bobChat.some((line) => line.includes('Alice tells you: meet me at the bank')),
    'bob received the private message',
  );
  check(
    (await chatLines(alice)).some((line) => line.includes('You tell Bob: meet me at the bank')),
    'alice sees her sent message',
  );

  // --- Follow -------------------------------------------------------------
  const bobStart = await self(bob);
  await bob.evaluate(({ x, y }) => window.__aetheria.net.send('walk', { x: x + 5, y: y + 3 }), bobStart);
  await wait(1200);
  const bobId = await alice.evaluate(() => window.__aetheria.latest.players.find((p) => p.name === 'Bob').id);
  await alice.evaluate((id) => window.__aetheria.net.send('action', { kind: 'player', id, option: 'follow' }), bobId);
  await wait(7000);
  const [aliceAt, bobAt] = [await self(alice), await self(bob)];
  const gap = Math.max(Math.abs(aliceAt.x - bobAt.x), Math.abs(aliceAt.y - bobAt.y));
  check(gap <= 1, `alice followed bob across the map (gap ${gap} tiles)`);

  // --- Trade --------------------------------------------------------------
  const aliceId = await bob.evaluate(() => window.__aetheria.latest.players.find((p) => p.name === 'Alice').id);
  await alice.evaluate((id) => window.__aetheria.net.send('action', { kind: 'player', id, option: 'trade' }), bobId);
  await wait(700);
  const tradeOpenEarly = await alice.locator('#trade-window').count();
  check(tradeOpenEarly === 0, 'one request alone does not open the trade screen');

  await bob.evaluate((id) => window.__aetheria.net.send('action', { kind: 'player', id, option: 'trade' }), aliceId);
  await wait(1200);
  check((await alice.locator('#trade-window').count()) === 1, 'both asked, so the trade screen opened for alice');
  check((await bob.locator('#trade-window').count()) === 1, 'and for bob');

  // Alice offers her coins; bob offers bread.
  await alice.evaluate(() => {
    const slot = window.__aetheria.inventory.findIndex((entry) => entry?.id === 'coins');
    window.__aetheria.net.send('trade', { act: 'offer', slot, count: 50 });
  });
  await bob.evaluate(() => {
    const slot = window.__aetheria.inventory.findIndex((entry) => entry?.id === 'bread');
    window.__aetheria.net.send('trade', { act: 'offer', slot, count: 1 });
  });
  await wait(900);
  const theirs = await alice.locator('#trade-theirs .slot').count();
  check(theirs === 1, `alice sees bob's offer (${theirs} item)`);
  await alice.screenshot({ path: join(SHOTS, 'social-02-trade.png') });

  // Accept twice on both sides: offer screen, then confirmation.
  await alice.click('#trade-accept');
  await wait(500);
  await bob.click('#trade-accept');
  await wait(900);
  const stage = await alice.evaluate(() => window.__aetheria.ui?.trade?.stage ?? null);
  check(stage === 2 || (await alice.locator('#trade-accept').textContent()).includes('Confirm'), 'the confirmation screen appeared');
  await alice.screenshot({ path: join(SHOTS, 'social-03-confirm.png') });

  await alice.click('#trade-accept');
  await wait(500);
  await bob.click('#trade-accept');
  await wait(1500);

  check((await alice.locator('#trade-window').count()) === 0, 'the trade screen closed');
  const aliceBread = await alice.evaluate(() =>
    window.__aetheria.inventory.filter((slot) => slot?.id === 'bread').length);
  const bobCoins = await bob.evaluate(() => {
    const slot = window.__aetheria.inventory.find((entry) => entry?.id === 'coins');
    return slot ? slot.count : 0;
  });
  check(aliceBread === 4, `alice received the bread (${aliceBread} loaves, started with 3)`);
  check(bobCoins === 100, `bob received the coins (${bobCoins}, started with 50)`);

  // --- Presence on logout -------------------------------------------------
  await bob.close();
  await wait(1500);
  const offline = await alice.locator('#friends-list .friend-row:not(.online)').count();
  check(offline === 1, 'bob shows as offline once he leaves');
  check(
    (await chatLines(alice)).some((line) => line.includes('Bob has logged out')),
    'alice was told he logged out',
  );

  check(errors.length === 0, `no console errors (${errors.slice(0, 3).join(' | ') || 'none'})`);
} catch (error) {
  console.error('social test threw:', error);
  failures.push(String(error));
} finally {
  await browser.close();
  server.kill('SIGTERM');
}

console.log(failures.length === 0 ? '\nAll social checks passed.' : `\n${failures.length} check(s) failed.`);
process.exit(failures.length === 0 ? 0 : 1);
