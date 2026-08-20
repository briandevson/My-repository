import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

import { GameWorld } from './world.js';
import { Player, giveStarterKit } from './player.js';
import { authenticate, persistPlayer } from './persistence.js';
import { WORLD_SEED } from '../shared/constants.js';

const here = dirname(fileURLToPath(import.meta.url));
const CLIENT_DIR = join(here, '..', 'client');
const PORT = Number(process.env.PORT ?? 8080);
const HOST = process.env.HOST ?? '0.0.0.0';
const AUTOSAVE_TICKS = 100; // ~1 minute

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
world.start();

const httpServer = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
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
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
  }
});

const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (socket) => {
  let player = null;

  socket.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (!msg || typeof msg.op !== 'string') return;

    if (!player) {
      if (msg.op !== 'login') return;
      const result = authenticate(msg.name, msg.password);
      if (!result.ok) {
        socket.send(JSON.stringify({ op: 'error', reason: result.reason }));
        return;
      }
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
    if (!player) return;
    persistPlayer(player);
    world.removePlayer(player);
    console.log(`[logout] ${player.display} (${world.players.size} online)`);
  });

  socket.on('error', (error) => console.error('[socket]', error.message));
});

// Periodic autosave so a crash costs at most a minute of progress.
setInterval(() => {
  for (const player of world.players.values()) persistPlayer(player);
}, AUTOSAVE_TICKS * 600);

httpServer.listen(PORT, HOST, () => {
  console.log(`Aetheria server listening on http://${HOST}:${PORT}`);
  console.log(`World seed ${WORLD_SEED}, ${world.npcs.length} NPCs, ${world.world.objects.length} objects`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log('\nSaving players and shutting down...');
    for (const player of world.players.values()) persistPlayer(player);
    world.stop();
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  });
}
