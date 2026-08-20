# Aetheria

A tick-based 3D MMORPG built in the spirit of the original browser RPGs of the
early 2000s: click-to-move on a tile grid, a 600 ms game tick, eighteen skills
that level on the classic experience curve, and an authoritative server that
owns every roll of the dice.

Everything is original — the code, the world, the item and monster catalogues,
and all of the art, which is generated from primitives at runtime. There are no
external assets to download.

![Ashford, the starting village](tools/shots/01-world.png)

## Running it

```bash
npm install
npm start           # builds the client bundle and serves on http://localhost:8080
```

Then open <http://localhost:8080>, pick any name and password, and you are in.
A name that has never been used creates a new character.

```bash
npm run dev         # esbuild in watch mode alongside the server
npm test            # unit and integration tests (no browser needed)
node tools/playtest.js   # drives the real client in a real browser end to end
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
