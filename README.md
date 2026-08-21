# Aetheria

A tick-based multiplayer 3D MMORPG built in the spirit of the original browser
RPGs of the early 2000s: click-to-move on a tile grid, a 600 ms game tick, eighteen skills
that level on the classic experience curve, and an authoritative server that
owns every roll of the dice.

Everything is original — the code, the world, the item and monster catalogues,
and all of the art, which is generated from primitives at runtime. There are no
external assets to download.

![Ashford, the starting village](docs/ashford.png)

![Mining in Coldiron Quarry](docs/quarry.png)

## Running it

```bash
npm install
npm start           # builds the client and serves on http://localhost:8080
```

Open <http://localhost:8080>, pick a name and a password, and choose **Create
character**. Names are unique across the server and ignore capitals, so `Gwyn`
and `gwyn` are the same character and only one person can have it.

## Hosting it so friends can just click a link

**Running it for free?** See [docs/hosting.md](docs/hosting.md) — free tiers
almost all have an ephemeral filesystem, so set `DATABASE_URL` to a free
Postgres and characters survive the restarts.


Everything needed to deploy is in the repo. Characters live on a mounted
volume, so a redeploy never wipes them.

**Fly.io** — the shape that suits a game server: WebSockets, a persistent
volume, and a machine that does not sleep.

```bash
fly launch --no-deploy          # claim an app name; keeps the fly.toml here
fly volumes create characters --size 1
fly deploy
```

**Any machine with Docker** — a VPS, a spare box, a Pi:

```bash
docker compose up -d            # serves on :8080, characters in a named volume
```

Put a reverse proxy in front for TLS (Caddy needs two lines), and set
`TRUST_PROXY=1` so the per-address limits see real client addresses rather than
the proxy's.

`GET /healthz` reports player count and uptime for the host's health checks.

### Once it is public

Defaults are set for a small server and can be raised with environment
variables: `MAX_PLAYERS` (100), `MAX_PER_ADDRESS` (4), `PORT`, `HOST`,
`AETHERIA_DATA`, and `DATABASE_URL` to keep characters in Postgres instead of
on disk. The server rate-limits every connection, meters chat
separately, throttles failed logins per address, caps message size, and pings
sockets to drop the ones phones left behind.

## Playing with friends

Everyone who connects to the same server shares one world, so friends just need
to reach your machine:

- **Same house or office** — they open `http://<your-computer's-ip>:8080`.
  `npm start` already listens on every interface; `HOST` and `PORT` override it.
- **Over the internet** — deploy it (above), or put a tunnel in front
  (`cloudflared`, `ngrok`) for a quick session. It is a plain HTTP + WebSocket
  server on one port.

Phones are first-class clients: the same world, the same social features, driven
by taps instead of clicks.

```bash
npm run dev         # esbuild in watch mode alongside the server
npm test            # unit and integration tests (no browser needed)
npm run test:browser     # drives the real client in a real browser end to end
npm run test:mobile      # an emulated iPhone joining the server with touch input
npm run test:social      # two browsers, two players: friends, chat, follow, trade
npm run build:demo       # dist/aetheria.html - a single-player demo in one file
```

## What is in the world

| Region | Where | What is there |
| --- | --- | --- |
| **Ashford** | centre | bank, general store, smithy (furnace, anvil, range), altar, village elder |
| **Coldiron Quarry** | north | copper and tin at the mouth, then iron, coal, gold, mithril, adamantite deeper in |
| **Whisperwood** | west | ordinary, oak, willow and maple trees |
| **Lake Mere** | east | net, rod and cage fishing spots |
| **Ashford Pasture** | east of town | cows, for hides and beginner combat |
| **Goblin Camp / Bandit Camp** | north-west / north-east | levels 5 and 14 |
| **Old Barrows** | south | skeletons, level 21 |
| **Wyrm's Hollow** | far south-east | ogres and green dragons, levels 40 and 79 |

## Features

**Combat.** Melee, ranged and magic, each with its own accuracy and damage
rolls. Four combat styles decide which skill earns the experience. Fights are
one-on-one: a second monster will not join in, and you cannot steal someone
else's kill. Death drops everything but your three most valuable items.

**Skills.** All eighteen train and matter: attack, defense, strength, hits,
ranged, prayer, magic, cooking, woodcutting, fletching, fishing, firemaking,
crafting, smithing, mining, herblore, agility and thieving. The production
chains connect — mine ore, smelt it into bars, hammer the bars into equipment
you can actually wear.

**Controls.** Mouse: left-click acts, right-click opens the full menu, right-drag
orbits, wheel zooms. Touch: tap acts, long press opens the menu, drag orbits,
pinch zooms. On phones the side panel becomes a bottom sheet that collapses to
its tab strip.

**Playing together.** A friends list with live presence — friends show as green
dots on the minimap and you are told when they log in or out. Private messages,
an ignore list, a Follow option that tails another player across the map, and
two-stage trading: both sides must ask, offered items sit in escrow, any change
resets both acceptances, and a confirmation screen shows exactly what is on the
table before it completes.

**The rest.** 30-slot inventory and 96-slot bank, eleven equipment slots,
shops, prayers that drain points while active, spells that consume runes,
a quest, ground items with drop ownership, resource respawn timers, run
energy, public chat with overhead bubbles, and per-character persistence.

## How it fits together

```
shared/   world generation, items, NPCs, objects, spells, xp — runs on both sides
server/   authoritative tick loop, combat, skills, pathfinding, persistence
client/   Three.js renderer, procedural models, HTML UI
tools/    esbuild bundler, browser play test
test/     unit and integration tests
```

The client and the server both call `buildWorld(seed)`, so the terrain you see
is the terrain the server collides against — no map files are shipped or
transferred. The server sends a snapshot every tick; the client interpolates
between them.

See `CLAUDE.md` for a deeper tour of the architecture and conventions.
