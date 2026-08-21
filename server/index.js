import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

import { GameWorld } from './world.js';
import { Player, giveStarterKit } from './player.js';
import { authenticate, persistPlayer, initStorage, describeStorage } from './persistence.js';
import { ConnectionLimiter, LoginThrottle, clientAddress } from './limits.js';
import { WORLD_SEED } from '../shared/constants.js';

const here = dirname(fileURLToPath(import.meta.url));
const CLIENT_DIR = join(here, '..', 'client');
const PORT = Number(process.env.PORT ?? 8080);
const HOST = process.env.HOST ?? '0.0.0.0';
const AUTOSAVE_TICKS = 100; // ~1 minute

// Public-server limits. Defaults suit a small host; raise them deliberately.
const MAX_PLAYERS = Number(process.env.MAX_PLAYERS ?? 100);
const MAX_PER_ADDRESS = Number(process.env.MAX_PER_ADDRESS ?? 4);
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const MAX_MESSAGE_BYTES = 4096;
const HEARTBEAT_MS = 30000;

const loginThrottle = new LoginThrottle();
/** address -> live connection count, so one machine cannot hog the world. */
const connectionsByAddress = new Map();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const world = new GameWorld(WORLD_SEED);
// Characters must be reachable before anyone can log in.
await initStorage();
world.start();

const httpServer = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    // Liveness probe for the host's health checks.
    if (url.pathname === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        players: world.players.size,
        maxPlayers: MAX_PLAYERS,
        tick: world.tickCount,
        uptime: Math.floor(process.uptime()),
      }));
      return;
    }

    let path = url.pathname === '/' ? '/index.html' : url.pathname;
    // Contain every request inside client/ regardless of what the caller sends.
    const resolved = join(CLIENT_DIR, normalize(path).replace(/^(\.\.[/\\])+/, ''));
    if (!resolved.startsWith(CLIENT_DIR)) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    const body = await readFile(resolved);
    res.writeHead(200, {
      'content-type': MIME[extname(resolved)] ?? 'application/octet-stream',
      'cache-control': 'no-cache',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
  }
});

const wss = new WebSocketServer({ server: httpServer, maxPayload: MAX_MESSAGE_BYTES });

wss.on('connection', (socket, request) => {
  let player = null;
  let authenticating = false;
  const address = clientAddress(request, TRUST_PROXY);
  const limiter = new ConnectionLimiter();
  let lastSlowNotice = 0;
  socket.isAlive = true;
  socket.on('pong', () => {
    socket.isAlive = true;
  });

  const open = connectionsByAddress.get(address) ?? 0;
  if (open >= MAX_PER_ADDRESS) {
    socket.send(JSON.stringify({ op: 'error', reason: 'Too many connections from your address.' }));
    socket.close();
    return;
  }
  connectionsByAddress.set(address, open + 1);

  socket.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (!msg || typeof msg.op !== 'string') return;

    const verdict = limiter.check(msg.op);
    if (verdict === 'flood') {
      console.warn(`[flood] closing ${address}`);
      socket.close();
      return;
    }
    if (verdict === 'slow') {
      // Dropping a chat line without saying so just looks broken, so tell them
      // - but at most once every few seconds, or the notice becomes the spam.
      if ((msg.op === 'chat' || msg.op === 'pm') && player && Date.now() - lastSlowNotice > 5000) {
        lastSlowNotice = Date.now();
        player.message('You are talking too quickly. Give it a moment.');
      }
      return;
    }

    if (!player) {
      if (msg.op !== 'login') return;
      // Authentication awaits storage; without this a client could fire two
      // logins and end up with two Players on one socket.
      if (authenticating) return;
      if (world.players.size >= MAX_PLAYERS) {
        socket.send(JSON.stringify({ op: 'error', reason: 'The world is full. Please try again shortly.' }));
        return;
      }
      if (!loginThrottle.allowed(address)) {
        socket.send(JSON.stringify({ op: 'error', reason: 'Too many failed attempts. Wait a few minutes and try again.' }));
        return;
      }
      authenticating = true;
      let result;
      try {
        result = await authenticate(msg.name, msg.password, !!msg.create);
      } catch (error) {
        console.error('[login]', error);
        socket.send(JSON.stringify({ op: 'error', reason: 'The character store is unavailable. Try again shortly.' }));
        return;
      } finally {
        authenticating = false;
      }
      if (!result.ok) {
        loginThrottle.fail(address);
        socket.send(JSON.stringify({ op: 'error', reason: result.reason }));
        return;
      }
      loginThrottle.succeed(address);
      // The socket may have closed while we were waiting on storage.
      if (socket.readyState !== 1) return;
      // One session per character, so a name is never in the world twice.
      for (const online of world.players.values()) {
        if (online.name === result.name) {
          socket.send(JSON.stringify({ op: 'error', reason: 'That character is already logged in.' }));
          return;
        }
      }
      player = new Player(result.name, socket);
      if (result.account.save) {
        player.loadSave(result.account.save);
      } else {
        giveStarterKit(player);
      }
      world.addPlayer(player);
      console.log(`[login] ${player.display} (${world.players.size} online)`);
      return;
    }

    if (msg.op === 'logout') {
      socket.close();
      return;
    }
    world.handleMessage(player, msg);
  });

  socket.on('close', () => {
    const remaining = (connectionsByAddress.get(address) ?? 1) - 1;
    if (remaining <= 0) connectionsByAddress.delete(address);
    else connectionsByAddress.set(address, remaining);
    if (!player) return;
    const leaving = player;
    persistPlayer(leaving).catch((error) => console.error('[save]', error));
    world.removePlayer(leaving);
    console.log(`[logout] ${leaving.display} (${world.players.size} online)`);
  });

  socket.on('error', (error) => console.error('[socket]', error.message));
});

// Periodic autosave so a crash costs at most a minute of progress.
setInterval(() => {
  saveEveryone().catch((error) => console.error('[autosave]', error));
}, AUTOSAVE_TICKS * 600);

async function saveEveryone() {
  const saves = [...world.players.values()].map((player) =>
    persistPlayer(player).catch((error) => console.error(`[save] ${player.name}:`, error)),
  );
  await Promise.all(saves);
}

// Phones suspend sockets without closing them; ping to find the dead ones.
setInterval(() => {
  for (const socket of wss.clients) {
    if (socket.isAlive === false) {
      socket.terminate();
      continue;
    }
    socket.isAlive = false;
    socket.ping();
  }
  loginThrottle.sweep();
}, HEARTBEAT_MS).unref();

httpServer.listen(PORT, HOST, () => {
  console.log(`Aetheria server listening on http://${HOST}:${PORT}`);
  console.log(`Limits: ${MAX_PLAYERS} players, ${MAX_PER_ADDRESS} connections per address, proxy headers ${TRUST_PROXY ? 'trusted' : 'ignored'}`);
  console.log(`World seed ${WORLD_SEED}, ${world.npcs.length} NPCs, ${world.world.objects.length} objects`);
  console.log(`Characters stored in ${describeStorage()}`);
});

let shuttingDown = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('\nSaving players and shutting down...');
    world.stop();
    // Hosts send SIGTERM before stopping the container, so the save has to
    // finish before the process exits - but never hang the shutdown on it.
    const deadline = setTimeout(() => process.exit(0), 5000);
    deadline.unref();
    saveEveryone()
      .catch((error) => console.error('[shutdown]', error))
      .finally(() => {
        clearTimeout(deadline);
        httpServer.close(() => process.exit(0));
        setTimeout(() => process.exit(0), 1000).unref();
      });
  });
}
