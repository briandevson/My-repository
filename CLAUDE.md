# CLAUDE.md

Guidance for AI assistants working in this repository.

## What this is

Aetheria is a tick-based 3D MMORPG: an authoritative Node.js game server over
WebSockets plus a Three.js browser client. It is a single npm package with no
framework, no build step for the server, and no external art or map assets —
the world and every model are generated from code at runtime.

All content is original. Do not add assets, names, or data copied from any
commercial game.

## Commands

```bash
npm install
npm start                 # build the client bundle, then serve on :8080
npm run dev               # esbuild --watch alongside the server
npm run build             # bundle client/src/main.js -> client/dist/bundle.js
npm test                  # node --test test/*.test.js  (fast, no browser)
npm run test:browser      # boots server + Chromium, plays the game, writes tools/shots/
npm run test:mobile       # standalone build on an emulated iPhone, touch input
npm run build:standalone  # dist/aetheria.html - single-player, whole game in one file
```

`PORT`, `HOST` and `AETHERIA_DATA` (character save directory) are the only
environment variables.

**Always rebuild the bundle after touching anything under `client/` or
`shared/`** — the server serves `client/dist/bundle.js`, which is gitignored and
not regenerated automatically by `npm run serve`.

If Playwright cannot find its browser, `tools/playtest.js` already falls back to
`/opt/pw-browsers/chromium-*/chrome-linux/chrome`; `CHROMIUM_PATH` overrides it.

## Two builds from one client

`tools/build.js` produces the served bundle, which talks to the dedicated server
over a WebSocket. `tools/bundle-standalone.js` produces `dist/aetheria.html`: a
single self-contained file where the same `GameWorld` runs inside the page.

The switch is `__AETHERIA_OFFLINE__`, replaced by esbuild's `define`, read once
in `client/src/transport.js`. `LocalNet` presents the same surface as `Net` —
`on`, `send`, `connect` — so `main.js` cannot tell which it has. Nothing in the
`server/` module graph may import `node:*` outside `index.js` and
`persistence.js`, or the standalone build breaks.

The standalone page is designed to be embedded somewhere that owns `<head>`, so
it injects its own viewport meta at runtime. Without it mobile browsers lay the
page out at 980px and the HUD renders desktop-sized on a phone.

## Layout

```
shared/    Code that MUST run unmodified in both Node and the browser bundle
  constants.js   tick length, world size, sizes, opcodes, tile and skill lists
  worldgen.js    deterministic terrain, scenery and spawn placement
  items.js       item catalogue (+ generated metal tiers and smithing recipes)
  npcs.js        NPC catalogue, drop tables, shop stock
  objects.js     clickable scenery definitions (trees, rocks, furnace, ...)
  spells.js      spells and prayers
  xp.js          experience curve, level and combat-level maths

server/    Authoritative game logic. Never trust the client here.
  index.js       HTTP static file server + WebSocket accept + login
  world.js       GameWorld: tick loop, message handling, snapshots  (largest file)
  player.js      Player entity: stats, equipment, inventory, death
  npc.js         Npc entity: hits, respawn, damage attribution
  combat.js      accuracy and damage rolls (pure functions)
  skills.js      gathering and production skills (pure-ish, take a player)
  pathfind.js    A* on the tile grid
  container.js   inventory/bank slot mechanics
  persistence.js scrypt-hashed accounts, JSON saves under server/data/players/

client/
  index.html, style.css
  src/main.js    entry: wires UI callbacks to the socket, input, render loop
  src/scene.js   GameScene: terrain mesh, object streaming, entity interpolation
  src/models.js  every mesh, built from Three.js primitives
  src/ui.js      all DOM: panels, chat, context menus, modals, minimap
  src/net.js     WebSocket wrapper
  src/localnet.js  in-page GameWorld + localStorage save (single-player build)
  src/transport.js chooses between them at build time

tools/     build.js (esbuild), playtest.js (browser end-to-end test)
test/      node:test unit + integration tests
```

## Core invariants

**The tick is the unit of time.** `TICK_MS = 600`. Nothing in `server/` should
use wall-clock time or `setTimeout` for gameplay; count ticks instead. Attack
speeds, respawns, gather rolls, fire lifetimes and ground-item decay are all in
ticks.

**The server decides everything.** The client sends intent (`walk`, `action`,
`inv`, `bank`, `shop`, `menu`, `setting`, `chat`) and renders snapshots. It
never computes damage, experience, or whether an action succeeded. Any new
feature needs its authoritative half in `server/`.

**`shared/` is the single source of truth for the world.** Both sides call
`buildWorld(seed)` and must get byte-identical results, so nothing in `shared/`
may use `Math.random`, `Date`, or any browser/Node-only API. Use the seeded
`mulberry32` PRNG. There is a test that asserts determinism — keep it passing.

**Positions are integer tiles.** `x`/`y` are tile coordinates; the third
dimension is terrain height, looked up with `heightAt()` and never stored on an
entity. In Three.js this maps to `(x, height, y)` — the game's `y` is the
scene's `z`.

**Entities are one of two shapes.** `Player` and `Npc` both expose
`kind`, `x`, `y`, `path`, `target`, `attackCooldown`, `damage()` and
`attackSpeed()`, which is what lets `tickCombatFor()` and `combat.js` treat
them interchangeably. Preserve that when adding entity types.

## How a player action flows

1. Client picks with a raycast (`scene.pick`) and sends e.g.
   `{op:'action', kind:'object', index, option}`.
2. `GameWorld.handleMessage` dispatches to `handleObjectAction`.
3. `queue(player, kind, id, range, run)` stores `player.pending` and paths
   toward the target; `resolvePending()` fires `run()` once in range.
4. Repeating work (mining, fishing, woodcutting) sets `player.action`, which
   `tickGatherFor()` rolls once per tick until it succeeds or is interrupted.
5. State changes set `player.dirty.{stats,inventory,equipment}`; the end of the
   tick flushes those as separate messages. Snapshots carry only per-tick data.

Multi-step choices (what to smelt, what to fletch) go through
`openMenu(player, title, options, handler)`, which keeps the handler closure on
the server; the client only ever sends the chosen index.

## Adding content

Most content needs no engine changes:

- **Item**: `define()` in `shared/items.js`. `equip` gives it stats, `cookable`
  / `firemaking` / `edible` / `prayerXp` / `cleanable` hook it into skills.
- **Monster**: `combat()` in `shared/npcs.js` with stats, bonuses and a drop
  table (`[itemId, weight, min, max]`, weight `0` = always). Spawn it from
  `buildWorld`'s `scatter()` calls.
- **Scenery**: `define()` in `shared/objects.js` with a `kind`, then handle that
  `kind` in `GameWorld.useObject` (server) and `createObjectMesh` (client).
- **Spell or prayer**: `shared/spells.js`.

There is a test asserting every drop, recipe and spell points at a real item —
new content that typos an id fails the suite rather than crashing at runtime.

## Conventions

- ES modules everywhere, `"type": "module"`. Node ≥ 20.
- Two-space indent, single quotes, semicolons, trailing commas in multiline
  literals. No linter is configured; match the surrounding style.
- British spelling in user-facing strings and colour-related identifiers
  (`armour`, `colour`), American in skill ids (`defense`) because those are
  wire values used in save files.
- Comments explain *why* (a rule, a formula's origin, a non-obvious ordering),
  not what the next line does.
- Item, NPC and object ids are `snake_case` strings and are persisted in save
  files — renaming one breaks existing characters.

## Testing

`test/game.test.js` covers the experience curve, containers, pathfinding,
combat maths, content integrity, and full loops driven through `GameWorld`
(mine → deplete → respawn, smelt, kill → drop → respawn, death, banking,
equip requirements, spell costs, single combat). Drive integration tests by
calling `world.handle*` and stepping `world.tick()` — do not open sockets.

`tools/playtest.js` is the real end-to-end check: it starts the server, drives
Chromium through login, movement, chat, panels, mining, a fight and lighting a
fire, and fails on any console error. Run it after client changes; rendering
bugs (back-face-culled terrain, an invisible overlay eating clicks) do not show
up in the unit tests.

## Known rough edges

- Snapshots are JSON and send full entity state each tick. Fine at this scale,
  the obvious thing to compress first if player counts grow.
- `findPath` scans its open list linearly; a heap would matter for big maps.
- The world is a single flat level — no floors, ladders or instances.
- Fletching produces strung bows directly instead of unstrung + bow string.
- The standalone build is single-player by definition; there is no peer sync.
- There is no rate limiting on client messages.
