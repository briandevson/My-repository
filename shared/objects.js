/**
 * World object definitions: scenery the player can click.
 *
 * `blocks` marks a tile impassable. `gather` drives the skilling loop in
 * server/skills.js - a gather action rolls success once per tick until it wins,
 * then hands out `item` and `xp` and (for depleting objects) starts `respawn`.
 */
const objects = {};

function define(id, def) {
  objects[id] = { id, blocks: true, respawn: 0, model: id, ...def };
  return objects[id];
}

// --- Trees -----------------------------------------------------------------
const TREES = [
  ['tree', 'Tree', 1, 25, 'logs', 8, 0x3f7a34],
  ['oak_tree', 'Oak tree', 15, 37.5, 'oak_logs', 14, 0x4a6b2a],
  ['willow_tree', 'Willow tree', 30, 67.5, 'willow_logs', 22, 0x6f8f3a],
  ['maple_tree', 'Maple tree', 45, 100, 'maple_logs', 40, 0xa05a2a],
];
for (const [id, name, level, xp, item, respawn, colour] of TREES) {
  define(id, {
    name,
    examine: 'A sturdy tree.',
    colour,
    kind: 'tree',
    respawn,
    gather: { skill: 'woodcutting', tool: 'axe', level, xp, item, baseChance: 0.28, depletes: true },
  });
}
define('stump', { name: 'Tree stump', examine: 'The tree has been cut down.', colour: 0x6b4a2a, kind: 'stump', blocks: true });

// --- Rocks -----------------------------------------------------------------
const ROCKS = [
  ['copper_rock', 'Copper rock', 1, 17.5, 'copper_ore', 6, 0xc07a3a],
  ['tin_rock', 'Tin rock', 1, 17.5, 'tin_ore', 6, 0xa8a8b0],
  ['iron_rock', 'Iron rock', 15, 35, 'iron_ore', 10, 0x8a4a32],
  ['coal_rock', 'Coal rock', 30, 50, 'coal', 25, 0x2f2f33],
  ['gold_rock', 'Gold rock', 40, 65, 'gold_ore', 50, 0xd4af37],
  ['mithril_rock', 'Mithril rock', 55, 80, 'mithril_ore', 100, 0x4a5fb0],
  ['adamantite_rock', 'Adamantite rock', 70, 95, 'adamantite_ore', 150, 0x3f7a5a],
];
for (const [id, name, level, xp, item, respawn, colour] of ROCKS) {
  define(id, {
    name,
    examine: 'A rock containing ore.',
    colour,
    kind: 'rock',
    respawn,
    gather: { skill: 'mining', tool: 'pickaxe', level, xp, item, baseChance: 0.22, depletes: true },
  });
}
define('depleted_rock', { name: 'Rocks', examine: 'The ore has been mined.', colour: 0x777777, kind: 'rock', blocks: true });

// --- Fishing ---------------------------------------------------------------
define('net_spot', {
  name: 'Fishing spot',
  examine: 'You can catch small fish here.',
  kind: 'fishing',
  blocks: false,
  colour: 0x4a9fd4,
  options: [
    { label: 'Net', tool: 'net', level: 1, xp: 10, item: 'raw_shrimp', baseChance: 0.3 },
    { label: 'Bait', tool: 'rod', level: 5, xp: 20, item: 'raw_sardine', baseChance: 0.28, consumes: 'bait' },
  ],
});
define('rod_spot', {
  name: 'Fishing spot',
  examine: 'You can catch river fish here.',
  kind: 'fishing',
  blocks: false,
  colour: 0x4a9fd4,
  options: [
    { label: 'Lure', tool: 'rod', level: 15, xp: 50, item: 'raw_trout', baseChance: 0.26, consumes: 'feather' },
    { label: 'Lure', tool: 'rod', level: 25, xp: 70, item: 'raw_salmon', baseChance: 0.2, consumes: 'feather' },
  ],
});
define('cage_spot', {
  name: 'Fishing spot',
  examine: 'You can catch deep sea fish here.',
  kind: 'fishing',
  blocks: false,
  colour: 0x2f7fb0,
  options: [
    { label: 'Cage', tool: 'pot', level: 40, xp: 90, item: 'raw_lobster', baseChance: 0.18 },
    { label: 'Harpoon', tool: 'harpoon', level: 35, xp: 80, item: 'raw_tuna', baseChance: 0.18 },
    { label: 'Harpoon', tool: 'harpoon', level: 45, xp: 100, item: 'raw_swordfish', baseChance: 0.14 },
  ],
});

// --- Village fixtures ------------------------------------------------------
define('furnace', { name: 'Furnace', examine: 'Hot enough to melt ore.', kind: 'furnace', colour: 0x7a2f2f });
define('anvil', { name: 'Anvil', examine: 'Hammer bars into equipment here.', kind: 'anvil', colour: 0x4a4a52 });
define('bank_booth', { name: 'Bank booth', examine: 'Store your valuables here.', kind: 'bank', colour: 0x8a6a3a });
define('range', { name: 'Cooking range', examine: 'Cook food here without burning it so easily.', kind: 'range', colour: 0x8a4a2a });
define('altar', { name: 'Altar', examine: 'Recharges prayer points.', kind: 'altar', colour: 0xe0dcc8 });
define('fire', { name: 'Fire', examine: 'A warm, crackling fire.', kind: 'fire', colour: 0xff8a2a, temporary: true });
define('stall', { name: 'Silk stall', examine: 'Looks stealable.', kind: 'stall', colour: 0xb04a7a, respawn: 20, thieving: { level: 20, xp: 24, item: 'coins', count: [15, 60] } });
define('wall', { name: 'Wall', examine: 'A stone wall.', kind: 'wall', colour: 0xa89f8c });
define('door', { name: 'Door', examine: 'A wooden door.', kind: 'door', blocks: false, colour: 0x6b4a2a });
define('gate', { name: 'Gate', examine: 'It swings open.', kind: 'door', blocks: false, colour: 0x6b4a2a });
define('fence', { name: 'Fence', examine: 'A wooden fence.', kind: 'wall', colour: 0x8a6a4a });
define('rock_scenery', { name: 'Rocks', examine: 'Just rocks.', kind: 'scenery', colour: 0x8a8a8a });
define('bush', { name: 'Bush', examine: 'A leafy bush.', kind: 'scenery', blocks: false, colour: 0x2f6b2a });
define('log_pile', { name: 'Log pile', examine: 'Firewood.', kind: 'scenery', colour: 0x7a5a2a });

// --- Agility course --------------------------------------------------------
define('log_balance', { name: 'Log balance', examine: 'Careful now.', kind: 'agility', blocks: false, colour: 0x7a5a2a, agility: { level: 1, xp: 15, dx: 0, dy: -3 } });
define('rope_swing', { name: 'Rope swing', examine: 'Swing across the gap.', kind: 'agility', blocks: false, colour: 0x9a8a5a, agility: { level: 10, xp: 25, dx: 3, dy: 0 } });
define('climbing_wall', { name: 'Climbing wall', examine: 'Scale it for experience.', kind: 'agility', blocks: false, colour: 0x8a8a8a, agility: { level: 20, xp: 40, dx: 0, dy: 3 } });

export const OBJECTS = objects;

export function getObject(id) {
  const def = objects[id];
  if (!def) throw new Error(`Unknown object: ${id}`);
  return def;
}
