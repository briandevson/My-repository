// Core tunables shared by the client and the server.
// Anything in shared/ must run unmodified in Node and in the browser bundle.

export const TICK_MS = 600; // one game tick, the unit every action is measured in
export const WORLD_SIZE = 160; // world is WORLD_SIZE x WORLD_SIZE tiles
export const TILE = 1; // world units per tile
export const WORLD_SEED = 0x5eed1234;
export const WATER_LEVEL = 1.0; // world-space height of the lake surface

export const INVENTORY_SIZE = 30;
export const BANK_SIZE = 96;
export const MAX_LEVEL = 99;
export const MAX_STACK = 2147483647;

// How far a player can see other entities, in tiles. Snapshots are clipped to this.
export const VIEW_RADIUS = 24;

// Movement: one tile per tick walking, two while running.
export const RUN_ENERGY_MAX = 100;
export const RUN_DRAIN_PER_TICK = 0.9;
export const RUN_REGEN_PER_TICK = 0.36;

export const RESPAWN_POINT = { x: 80, y: 96 };

// Damage/xp constants
export const XP_PER_DAMAGE = 4; // combat xp per point of damage dealt
export const HITS_XP_SHARE = 1.33;

export const EQUIP_SLOTS = [
  'weapon',
  'shield',
  'head',
  'body',
  'legs',
  'hands',
  'feet',
  'cape',
  'amulet',
  'ring',
  'ammo',
];

export const SKILLS = [
  'attack',
  'defense',
  'strength',
  'hits',
  'ranged',
  'prayer',
  'magic',
  'cooking',
  'woodcutting',
  'fletching',
  'fishing',
  'firemaking',
  'crafting',
  'smithing',
  'mining',
  'herblore',
  'agility',
  'thieving',
];

export const COMBAT_SKILLS = ['attack', 'defense', 'strength', 'hits', 'ranged', 'prayer', 'magic'];

// Combat styles change which skill receives experience and give small hidden bonuses,
// mirroring the four-way stance selector of the era.
export const COMBAT_STYLES = {
  controlled: { attack: 1, strength: 1, defense: 1, xp: ['attack', 'strength', 'defense'] },
  aggressive: { attack: 0, strength: 3, defense: 0, xp: ['strength'] },
  accurate: { attack: 3, strength: 0, defense: 0, xp: ['attack'] },
  defensive: { attack: 0, strength: 0, defense: 3, xp: ['defense'] },
};

export const TILE_TYPES = {
  GRASS: 0,
  DIRT: 1,
  PATH: 2,
  WATER: 3,
  SAND: 4,
  STONE: 5,
  FLOOR: 6,
};

export const OPS = {
  // client -> server
  LOGIN: 'login',
  WALK: 'walk',
  CHAT: 'chat',
  ACTION: 'action', // interact with an object / npc / ground item / player
  INV: 'inv', // inventory operations (use, drop, equip, swap)
  BANK: 'bank',
  SETTING: 'setting', // combat style, run toggle, prayer toggle, spell select
  LOGOUT: 'logout',
  // server -> client
  WELCOME: 'welcome',
  SNAPSHOT: 'snapshot',
  MESSAGE: 'message',
  STATS: 'stats',
  INVENTORY: 'inventory',
  EQUIPMENT: 'equipment',
  BANK_DATA: 'bankdata',
  DIE: 'die',
  ERROR: 'error',
};
