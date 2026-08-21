# CLAUDE.md

Guidance for AI assistants working in this repository.

## What this is

Aetheria is a tick-based multiplayer 3D MMORPG: an authoritative Node.js game
server over WebSockets plus a Three.js browser client. It is online only -
there is no offline or single-player mode, and every client is a real player in
one shared world. It is a single npm package with no
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
npm run test:mobile       # an emulated iPhone joining the server, touch input
npm run test:social       # two browsers, two players: friends, PMs, follow, trade
```

Environment: `PORT`, `HOST`, `AETHERIA_DATA` (character saves), and the public
server limits `MAX_PLAYERS`, `MAX_PER_ADDRESS`, `TRUST_PROXY`.

**Always rebuild the bundle after touching anything under `client/` or
`shared/`** — the server serves `client/dist/bundle.js`, which is gitignored and
not regenerated automatically by `npm run serve`.

If Playwright cannot find its browser, `tools/playtest.js` already falls back to
`/opt/pw-browsers/chromium-*/chrome-linux/chrome`; `CHROMIUM_PATH` overrides it.

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
  social.js      friends, presence, private messages, trade sessions
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

## Deployment

`Dockerfile` builds the client with the full toolchain and ships a runtime with
production dependencies only - so **nothing under `server/` or `shared/` may
import a devDependency**, `three` included. `fly.toml` and `docker-compose.yml`
both mount a volume at `/data` for `AETHERIA_DATA`; character saves are the only
state worth keeping, and losing them is the one unrecoverable mistake here.

`server/limits.js` holds the abuse limits, which exist because the port is
public: a token bucket per connection, a tighter one for chat, a per-address
failed-login throttle, a connection cap per address, and a heartbeat that drops
sockets phones abandoned. Tune the numbers, but do not remove the layers. The
tests assert that ordinary heavy play is never throttled - if that test starts
failing, the limits are too tight for real players, not too loose.

Set `TRUST_PROXY=1` only when something really does sit in front: the
forwarded header is trivially forged, and trusting it without a proxy lets one
client bypass every per-address limit.

## Accounts

Character names are unique and case-insensitive. `normaliseName` in
`shared/names.js` lowercases and underscores a name before anything looks at
it, and that canonical form is both the save key and the identity used for
friends, private messages and trade. `authenticate(name, password, create)`
takes an explicit `create` flag: registering a name that exists is refused,
and logging in to one that does not exist is too - never merge the two, or a
typo silently creates a second character. `server/index.js` additionally allows
only one live session per character.

Passwords are scrypt-hashed with a per-account salt and compared with
`timingSafeEqual`. Save files are named by a hash of the character name, so a
name can never escape into a file path.

## Trading

The rules in `server/social.js` exist to make trading unscammable, and changes
must preserve all four:

1. **Both sides must ask.** A trade only opens when each player has requested
   the other; a single request is just a message.
2. **Offered items leave the inventory immediately** and sit in the session's
   escrow container, so the same item can never be offered and spent at once.
3. **Any change resets both acceptances** and returns the session to stage one.
   This is what stops an item being swapped out after the other side agrees.
4. **Two stages.** Stage one is the offer screen, stage two is a confirmation
   of exactly what is on the table. Both sides accept in both stages.

Anything that ends a trade - decline, logout, death - goes through
`cancelTrade`, which returns every escrowed item first. There are tests for
each of these; treat a failure as a duplication bug, not a flaky test.

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
- Trading pins both players in place rather than letting them walk.
- There is no rate limiting on client messages.
