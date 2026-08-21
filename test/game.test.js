import { test } from 'node:test';
import assert from 'node:assert/strict';

import { XP_TABLE, levelForXp, xpForLevel, combatLevel, newStats } from '../shared/xp.js';
import { getItem, SMITHING_RECIPES } from '../shared/items.js';
import { OBJECTS } from '../shared/objects.js';
import { NPCS, rollDrops } from '../shared/npcs.js';
import { buildWorld } from '../shared/worldgen.js';
import { SPELLS } from '../shared/spells.js';
import { addItem, countOf, createContainer, freeSlots, removeItem, canHold } from '../server/container.js';
import { findPath } from '../server/pathfind.js';
import { hitChance, maxHit } from '../server/combat.js';
import { GameWorld } from '../server/world.js';
import { Player, giveStarterKit } from '../server/player.js';

// --- Experience -------------------------------------------------------------

test('experience table matches the classic curve', () => {
  assert.equal(XP_TABLE[0], 0);
  assert.equal(xpForLevel(2), 83);
  assert.equal(xpForLevel(10), 1154);
  assert.equal(xpForLevel(50), 101333);
  assert.equal(xpForLevel(99), 13034431);
  assert.equal(levelForXp(0), 1);
  assert.equal(levelForXp(82), 1);
  assert.equal(levelForXp(83), 2);
  assert.equal(levelForXp(13034431), 99);
});

test('a fresh character starts at 10 hits and combat level 3', () => {
  const stats = newStats();
  assert.equal(levelForXp(stats.hits.xp), 10);
  assert.equal(combatLevel(stats), 3);
});

// --- Content integrity ------------------------------------------------------

test('every drop, recipe and spell references a real item', () => {
  for (const npc of Object.values(NPCS)) {
    for (const [id] of npc.drops ?? []) assert.doesNotThrow(() => getItem(id), `bad drop ${id}`);
  }
  for (const recipe of SMITHING_RECIPES) {
    assert.doesNotThrow(() => getItem(recipe.id));
    assert.doesNotThrow(() => getItem(recipe.bar));
  }
  for (const object of Object.values(OBJECTS)) {
    for (const option of object.gather ? [object.gather] : object.options ?? []) {
      assert.doesNotThrow(() => getItem(option.item), `bad gather item ${option.item}`);
    }
  }
  for (const spell of Object.values(SPELLS)) {
    for (const rune of Object.keys(spell.runes)) assert.doesNotThrow(() => getItem(rune));
  }
});

test('world generation is deterministic for a given seed', () => {
  const a = buildWorld(1234);
  const b = buildWorld(1234);
  assert.equal(a.objects.length, b.objects.length);
  assert.deepEqual(a.objects[500], b.objects[500]);
  assert.deepEqual([...a.tiles.slice(0, 400)], [...b.tiles.slice(0, 400)]);
  assert.notEqual(buildWorld(4321).objects.length, 0);
});

// --- Containers -------------------------------------------------------------

test('stackables share a slot, everything else takes one each', () => {
  const container = createContainer(4);
  addItem(container, 'coins', 100);
  addItem(container, 'coins', 50);
  assert.equal(countOf(container, 'coins'), 150);
  assert.equal(freeSlots(container), 3);

  assert.equal(addItem(container, 'bronze_sword', 5), 3); // only three slots left
  assert.equal(freeSlots(container), 0);
  assert.equal(canHold(container, 'iron_sword', 1), 0);
  assert.equal(canHold(container, 'coins', 10), 10, 'existing stack still accepts more');

  removeItem(container, 'bronze_sword', 2);
  assert.equal(countOf(container, 'bronze_sword'), 1);
});

// --- Pathfinding ------------------------------------------------------------

test('pathfinding walks around a wall and refuses to cut corners', () => {
  const walls = new Set(['5,4', '5,5', '5,6', '5,7']);
  const blocked = (x, y) => x < 0 || y < 0 || x > 10 || y > 10 || walls.has(`${x},${y}`);
  const path = findPath(blocked, 3, 5, 8, 5, 0, 11);
  assert.ok(path.length > 0, 'a route exists around the wall');
  assert.deepEqual(path.at(-1), { x: 8, y: 5 });
  for (const step of path) assert.ok(!walls.has(`${step.x},${step.y}`));

  const sealed = new Set(['1,0', '1,1', '1,2', '0,2']);
  const boxed = (x, y) => x < 0 || y < 0 || x > 4 || y > 4 || sealed.has(`${x},${y}`);
  assert.equal(findPath(boxed, 0, 0, 4, 4, 0, 5).length, 0, 'no route out of a sealed corner');
});

// --- Combat maths -----------------------------------------------------------

test('better gear and levels raise accuracy and damage', () => {
  const weak = fakeFighter({ attack: 1, strength: 1, defense: 1 }, { aim: 0, power: 0, armour: 0 });
  const strong = fakeFighter({ attack: 60, strength: 60, defense: 60 }, { aim: 40, power: 40, armour: 40 });
  assert.ok(hitChance(strong, weak) > hitChance(weak, strong));
  assert.ok(maxHit(strong) > maxHit(weak));
  const chance = hitChance(weak, weak);
  assert.ok(chance > 0 && chance < 1);
});

function fakeFighter(levels, bonuses) {
  return {
    kind: 'npc',
    def: { bonuses },
    level: (skill) => levels[skill] ?? 1,
  };
}

// --- Integration ------------------------------------------------------------

function makeWorld() {
  const world = new GameWorld(0x5eed1234);
  const sent = [];
  const socket = { readyState: 1, send: (data) => sent.push(JSON.parse(data)) };
  const player = new Player('tester', socket);
  giveStarterKit(player);
  world.addPlayer(player);
  return { world, player, sent };
}

/** Walk a player next to the first object of `type` and return its state. */
function standBy(world, player, type) {
  const state = world.objectStates.find((entry) => entry.type === type);
  assert.ok(state, `world contains a ${type}`);
  const spot = [[1, 0], [-1, 0], [0, 1], [0, -1]]
    .map(([dx, dy]) => ({ x: state.x + dx, y: state.y + dy }))
    .find((tile) => !world.isBlockedTile(tile.x, tile.y));
  assert.ok(spot, 'there is a free tile beside it');
  player.x = spot.x;
  player.y = spot.y;
  return state;
}

test('mining a rock yields ore, experience and a depleted rock that respawns', () => {
  const { world, player } = makeWorld();
  const rock = standBy(world, player, 'copper_rock');

  world.handleObjectAction(player, { index: rock.index, option: 'use' });
  assert.equal(player.action?.type, 'gather');

  for (let i = 0; i < 200 && countOf(player.inventory, 'copper_ore') === 0; i++) world.tick();
  assert.equal(countOf(player.inventory, 'copper_ore'), 1);
  assert.ok(player.stats.mining.xp > 0);
  assert.equal(world.objectStates[rock.index].type, 'depleted_rock');
  assert.ok(world.isBlockedTile(rock.x, rock.y));

  for (let i = 0; i < 40; i++) world.tick();
  assert.equal(world.objectStates[rock.index].type, 'copper_rock', 'the rock comes back');
});

test('mining without a pickaxe is refused', () => {
  const { world, player } = makeWorld();
  const rock = standBy(world, player, 'tin_rock');
  removeItem(player.inventory, 'bronze_pickaxe', 1);
  world.handleObjectAction(player, { index: rock.index, option: 'use' });
  assert.equal(player.action, null);
});

test('smelting bronze consumes both ores and grants smithing experience', () => {
  const { world, player } = makeWorld();
  addItem(player.inventory, 'copper_ore', 1);
  addItem(player.inventory, 'tin_ore', 1);
  const furnace = standBy(world, player, 'furnace');

  world.handleObjectAction(player, { index: furnace.index, option: 'use' });
  assert.ok(player.menu, 'the furnace opens a menu');
  const choice = player.menu.options.findIndex((option) => option.id === 'bronze_bar');
  world.handleMenu(player, { choice });

  assert.equal(countOf(player.inventory, 'bronze_bar'), 1);
  assert.equal(countOf(player.inventory, 'copper_ore'), 0);
  assert.ok(player.stats.smithing.xp > 0);
});

test('combat kills an npc, awards experience and leaves a drop', () => {
  const { world, player } = makeWorld();
  const rat = world.npcs.find((npc) => npc.type === 'rat');
  player.x = rat.x;
  player.y = rat.y - 1;
  player.stats.attack.xp = xpForLevel(40);
  player.stats.strength.xp = xpForLevel(40);
  world.handleNpcAction(player, { id: rat.id, option: 'attack' });

  for (let i = 0; i < 120 && !rat.dead; i++) world.tick();
  assert.ok(rat.dead, 'the rat dies');
  assert.ok(player.stats.hits.xp > xpForLevel(10), 'hits experience was awarded');
  assert.ok(world.groundItems.some((item) => item.id === 'bones'), 'bones dropped');

  for (let i = 0; i < 30; i++) world.tick();
  assert.equal(rat.dead, false, 'the rat respawns');
});

test('dying drops everything but the three most valuable items', () => {
  const { world, player } = makeWorld();
  addItem(player.inventory, 'coins', 5000);
  const before = player.inventory.filter(Boolean).length;
  player.currentHits = 1;
  world.killPlayer(player, null);

  assert.equal(player.inventory.filter(Boolean).length, 3);
  assert.ok(before > 3);
  assert.ok(world.groundItems.length > 0);
  assert.equal(player.currentHits, player.maxHits);
  assert.equal(player.x, 80);
});

test('banking moves items both ways and stacks them', () => {
  const { world, player } = makeWorld();
  addItem(player.inventory, 'copper_ore', 1);
  const slot = player.inventory.findIndex((entry) => entry?.id === 'copper_ore');

  world.handleBank(player, { act: 'deposit', slot, count: 1 });
  assert.equal(countOf(player.bank, 'copper_ore'), 1);
  assert.equal(countOf(player.inventory, 'copper_ore'), 0);

  world.handleBank(player, { act: 'withdraw', slot: 0, count: 1 });
  assert.equal(countOf(player.inventory, 'copper_ore'), 1);
});

test('equipment requirements are enforced', () => {
  const { world, player } = makeWorld();
  addItem(player.inventory, 'adamantite_sword', 1);
  const slot = player.inventory.findIndex((entry) => entry?.id === 'adamantite_sword');
  world.handleInventory(player, { act: 'equip', slot });
  assert.equal(player.equipment.weapon, null, 'level 30 attack is required');

  player.stats.attack.xp = xpForLevel(40);
  world.handleInventory(player, { act: 'equip', slot });
  assert.equal(player.equipment.weapon.id, 'adamantite_sword');
  assert.ok(player.bonuses().aim > 0);
});

test('casting a spell consumes runes', () => {
  const { world, player } = makeWorld();
  const before = countOf(player.inventory, 'mind_rune');
  const goblin = world.npcs.find((npc) => npc.type === 'goblin');
  player.autocast = true;
  player.spell = 'wind_strike';
  player.x = goblin.x;
  player.y = goblin.y - 1;
  world.performAttack(player, goblin);
  assert.equal(countOf(player.inventory, 'mind_rune'), before - 1);
  assert.ok(player.stats.magic.xp > 0);
});

test('drop tables always give the guaranteed entries', () => {
  const drops = rollDrops(NPCS.cow, () => 0.99);
  assert.ok(drops.some((drop) => drop.id === 'bones'));
  assert.ok(drops.some((drop) => drop.id === 'cowhide'));
});

test('combat is one-on-one: a second monster will not join a fight', () => {
  const { world, player } = makeWorld();
  const [first, second] = world.npcs.filter((npc) => npc.type === 'goblin');
  first.x = player.x + 1;
  first.y = player.y;
  second.x = player.x - 1;
  second.y = player.y;
  second.spawnX = second.x;
  second.spawnY = second.y;

  first.target = player;
  world.seekTarget(second);
  assert.equal(second.target, null, 'the second goblin stays out of it');

  first.target = null;
  world.seekTarget(second);
  assert.equal(second.target, player, 'and joins once the first has disengaged');
});

test('a monster another player is fighting cannot be stolen', () => {
  const { world, player } = makeWorld();
  const other = new Player('rival', { readyState: 1, send() {} });
  world.addPlayer(other);
  const goblin = world.npcs.find((npc) => npc.type === 'goblin');
  other.target = goblin;

  player.x = goblin.x;
  player.y = goblin.y - 1;
  world.handleNpcAction(player, { id: goblin.id, option: 'attack' });
  assert.equal(player.target, null);
});

test('lighting logs creates a fire that can be cooked on, then burns to ashes', () => {
  const { world, player } = makeWorld();
  player.stats.firemaking.xp = xpForLevel(50);
  player.stats.cooking.xp = xpForLevel(50);
  // Logs do not stack, so leave room in the pack for the fish.
  addItem(player.inventory, 'raw_shrimp', 1);
  addItem(player.inventory, 'logs', 10);
  const tinderbox = player.inventory.findIndex((slot) => slot?.id === 'tinderbox');

  // Lighting is a roll; at level 50 it is a near certainty within a few tries.
  for (let i = 0; i < 20 && world.temps.size === 0; i++) {
    const logs = player.inventory.findIndex((slot) => slot?.id === 'logs');
    world.handleMessage(player, { op: 'inv', act: 'use', slot: tinderbox, targetKind: 'item', to: logs });
  }
  assert.equal(world.temps.size, 1, 'a fire is burning');
  const fire = [...world.temps.values()][0];
  assert.ok(player.stats.firemaking.xp > 0);
  assert.ok(world.isBlockedTile(fire.x, fire.y), 'you cannot walk through a fire');

  // The fire is reachable and offers a cooking menu.
  player.x = fire.x + 1;
  player.y = fire.y;
  world.handleObjectAction(player, { index: fire.index, option: 'use' });
  assert.ok(player.menu, 'the fire opens a cooking menu');
  world.handleMenu(player, { choice: 0 });
  assert.equal(countOf(player.inventory, 'raw_shrimp'), 0, 'the raw fish was used');

  // It burns out and leaves ashes behind.
  for (let i = 0; i < 200 && world.temps.size > 0; i++) world.tick();
  assert.equal(world.temps.size, 0, 'the fire burns out');
  assert.ok(world.groundItems.some((item) => item.id === 'ashes'), 'ashes are left behind');
});

test('a fire lit under the player moves them clear of it', () => {
  const { world, player } = makeWorld();
  player.stats.firemaking.xp = xpForLevel(50);
  addItem(player.inventory, 'logs', 10);
  const tinderbox = player.inventory.findIndex((slot) => slot?.id === 'tinderbox');
  const from = { x: player.x, y: player.y };

  for (let i = 0; i < 20 && world.temps.size === 0; i++) {
    const logs = player.inventory.findIndex((slot) => slot?.id === 'logs');
    world.handleMessage(player, { op: 'inv', act: 'use', slot: tinderbox, targetKind: 'item', to: logs });
  }
  const fire = [...world.temps.values()][0];
  assert.deepEqual({ x: fire.x, y: fire.y }, from, 'the fire is where the player stood');
  assert.notDeepEqual({ x: player.x, y: player.y }, from, 'the player stepped aside');
});

// --- Social -----------------------------------------------------------------

function twoPlayers() {
  const world = new GameWorld(0x5eed1234);
  const make = (name) => {
    const sent = [];
    const player = new Player(name, { readyState: 1, send: (data) => sent.push(JSON.parse(data)) });
    giveStarterKit(player);
    world.addPlayer(player);
    player.sent = sent;
    return player;
  };
  const a = make('alice');
  const b = make('bob');
  b.x = a.x + 1;
  b.y = a.y;
  return { world, a, b };
}

const lastOf = (player, op) => player.sent.filter((msg) => msg.op === op).pop();

test('friends list tracks presence and survives a save', () => {
  const { world, a, b } = twoPlayers();
  world.handleMessage(a, { op: 'friend', act: 'add', name: 'Bob' });

  const list = lastOf(a, 'friends');
  assert.equal(list.friends.length, 1);
  assert.equal(list.friends[0].name, 'bob');
  assert.equal(list.friends[0].online, true, 'bob is logged in');

  world.removePlayer(b);
  const afterLogout = lastOf(a, 'friends');
  assert.equal(afterLogout.friends[0].online, false, 'and shows offline once he leaves');

  const restored = new Player('alice', { readyState: 1, send() {} });
  restored.loadSave(a.toSave());
  assert.ok(restored.friends.has('bob'), 'the list is saved with the character');
});

test('private messages reach the other player and respect the ignore list', () => {
  const { world, a, b } = twoPlayers();
  world.handleMessage(a, { op: 'pm', to: 'bob', text: 'meet me at the bank' });
  assert.ok(b.sent.some((msg) => msg.pm && msg.text === 'Alice tells you: meet me at the bank'));
  assert.ok(a.sent.some((msg) => msg.pm && msg.text === 'You tell Bob: meet me at the bank'));

  world.handleMessage(b, { op: 'friend', act: 'add', name: 'alice', list: 'ignore' });
  b.sent.length = 0;
  world.handleMessage(a, { op: 'pm', to: 'bob', text: 'hello?' });
  assert.equal(b.sent.filter((msg) => msg.pm).length, 0, 'an ignored sender gets through to nobody');

  b.sent.length = 0;
  world.handleMessage(a, { op: 'chat', text: 'public words' });
  assert.equal(b.sent.filter((msg) => msg.chat).length, 0, 'public chat is filtered too');
});

test('following walks you to the other player and stops when they log out', () => {
  const { world, a, b } = twoPlayers();
  b.x = a.x + 6;
  world.handleAction(a, { kind: 'player', id: b.id, option: 'follow' });
  assert.equal(a.following, b.id);

  for (let i = 0; i < 12; i++) world.tick();
  assert.ok(Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)) <= 1, 'caught up');

  world.removePlayer(b);
  assert.equal(a.following, null, 'following ends when they leave');
});

test('a trade needs both sides to ask, then both to accept twice', () => {
  const { world, a, b } = twoPlayers();
  addItem(a.inventory, 'coins', 500);
  addItem(b.inventory, 'iron_sword', 1);

  world.handleAction(a, { kind: 'player', id: b.id, option: 'trade' });
  assert.equal(a.trade, null, 'one request alone does not open a trade');
  world.handleAction(b, { kind: 'player', id: a.id, option: 'trade' });
  assert.ok(a.trade && b.trade, 'both asked, so the screen opens');

  // The starter kit already carries coins, so offer whatever the stack holds.
  const coins = a.inventory.findIndex((slot) => slot?.id === 'coins');
  const purse = a.inventory[coins].count;
  world.handleMessage(a, { op: 'trade', act: 'offer', slot: coins, count: purse });
  const sword = b.inventory.findIndex((slot) => slot?.id === 'iron_sword');
  world.handleMessage(b, { op: 'trade', act: 'offer', slot: sword, count: 1 });

  assert.equal(countOf(a.inventory, 'coins'), 0, 'offered items are held in escrow');
  assert.equal(countOf(b.inventory, 'iron_sword'), 0);

  const session = a.trade;
  world.handleMessage(a, { op: 'trade', act: 'accept' });
  world.handleMessage(b, { op: 'trade', act: 'accept' });
  assert.equal(session.stage, 2, 'both accepted, so the confirmation screen opens');
  assert.equal(session.accepted.get(a.id), false, 'and acceptance is asked for again');

  world.handleMessage(a, { op: 'trade', act: 'accept' });
  world.handleMessage(b, { op: 'trade', act: 'accept' });

  assert.equal(a.trade, null, 'the trade closes');
  assert.equal(countOf(a.inventory, 'iron_sword'), 1, 'alice got the sword');
  assert.equal(countOf(b.inventory, 'coins'), purse + 50, 'bob got the coins on top of his own');
});

test('changing an offer resets both acceptances', () => {
  const { world, a, b } = twoPlayers();
  addItem(a.inventory, 'coins', 100);
  world.handleAction(a, { kind: 'player', id: b.id, option: 'trade' });
  world.handleAction(b, { kind: 'player', id: a.id, option: 'trade' });
  const session = a.trade;

  world.handleMessage(a, { op: 'trade', act: 'accept' });
  world.handleMessage(b, { op: 'trade', act: 'accept' });
  assert.equal(session.stage, 2);

  // Sneaking an item out after agreement must throw both sides back.
  const coins = a.inventory.findIndex((slot) => slot?.id === 'coins');
  world.handleMessage(a, { op: 'trade', act: 'offer', slot: coins, count: 100 });
  assert.equal(session.stage, 1, 'back to the offer screen');
  assert.equal(session.accepted.get(a.id), false);
  assert.equal(session.accepted.get(b.id), false);
});

test('a cancelled trade returns every escrowed item', () => {
  const { world, a, b } = twoPlayers();
  addItem(a.inventory, 'coal', 7);
  const before = countOf(a.inventory, 'coal');

  world.handleAction(a, { kind: 'player', id: b.id, option: 'trade' });
  world.handleAction(b, { kind: 'player', id: a.id, option: 'trade' });
  const coal = a.inventory.findIndex((slot) => slot?.id === 'coal');
  world.handleMessage(a, { op: 'trade', act: 'offer', slot: coal, count: 7 });
  assert.equal(countOf(a.inventory, 'coal'), before - 1, 'coal does not stack, so one slot moved');

  world.handleMessage(b, { op: 'trade', act: 'decline' });
  assert.equal(a.trade, null);
  assert.equal(countOf(a.inventory, 'coal'), before, 'the escrowed coal came back');
});

test('logging out or dying mid-trade returns the items', () => {
  const { world, a, b } = twoPlayers();
  addItem(a.inventory, 'coins', 250);
  const purse = countOf(a.inventory, 'coins');
  world.handleAction(a, { kind: 'player', id: b.id, option: 'trade' });
  world.handleAction(b, { kind: 'player', id: a.id, option: 'trade' });
  const coins = a.inventory.findIndex((slot) => slot?.id === 'coins');
  world.handleMessage(a, { op: 'trade', act: 'offer', slot: coins, count: purse });

  world.removePlayer(b);
  assert.equal(a.trade, null, 'the trade is cancelled');
  assert.equal(countOf(a.inventory, 'coins'), purse, 'alice has her coins back');
});

test('you cannot walk away mid-trade', () => {
  const { world, a, b } = twoPlayers();
  world.handleAction(a, { kind: 'player', id: b.id, option: 'trade' });
  world.handleAction(b, { kind: 'player', id: a.id, option: 'trade' });
  const where = { x: a.x, y: a.y };
  world.handleMessage(a, { op: 'walk', x: a.x + 5, y: a.y + 5 });
  assert.equal(a.path.length, 0);
  assert.deepEqual({ x: a.x, y: a.y }, where);
});
