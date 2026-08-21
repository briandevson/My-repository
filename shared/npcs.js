/**
 * NPC catalogue.
 *
 * Combat NPCs carry `stats` (attack/strength/defense/hits), an `armour`/`aim`/`power`
 * bonus block, an aggression radius and a weighted `drops` table. Non-combat NPCs
 * (shopkeepers, banker, quest givers) simply omit `stats`.
 *
 * Drop tables are `[itemId, weight, min, max]`. Weight 0 means "always drops".
 */

const npcs = {};

function define(id, def) {
  npcs[id] = {
    id,
    examine: def.name,
    respawn: 25, // ticks
    aggressive: false,
    aggroRadius: 0,
    wanderRadius: 4,
    attackable: false,
    scale: 1,
    ...def,
  };
  return npcs[id];
}

function combat(id, def) {
  return define(id, {
    attackable: true,
    ...def,
    stats: { attack: 1, strength: 1, defense: 1, hits: 5, ...def.stats },
    bonuses: { aim: 0, power: 0, armour: 0, ...def.bonuses },
  });
}

const BONE_DROP = ['bones', 0, 1, 1];

combat('rat', {
  name: 'Giant rat',
  examine: 'It is a giant rat.',
  level: 3,
  scale: 0.55,
  colour: 0x6b5b4a,
  shape: 'beast',
  stats: { attack: 3, strength: 2, defense: 1, hits: 5 },
  drops: [BONE_DROP, ['coins', 40, 1, 8], ['raw_shrimp', 20, 1, 1]],
});

combat('goblin', {
  name: 'Goblin',
  examine: 'An ugly green humanoid.',
  level: 5,
  colour: 0x4f7a34,
  shape: 'humanoid',
  aggressive: true,
  aggroRadius: 4,
  stats: { attack: 5, strength: 5, defense: 3, hits: 12 },
  bonuses: { aim: 2, power: 2, armour: 2 },
  drops: [BONE_DROP, ['coins', 60, 3, 24], ['bronze_dagger', 12, 1, 1], ['bronze_helmet', 8, 1, 1], ['air_rune', 10, 1, 6], ['mind_rune', 8, 1, 4]],
});

combat('cow', {
  name: 'Cow',
  examine: 'Converts grass into beef.',
  level: 2,
  scale: 0.9,
  colour: 0xd8d2c8,
  shape: 'beast',
  stats: { attack: 1, strength: 1, defense: 1, hits: 8 },
  drops: [BONE_DROP, ['cowhide', 0, 1, 1]],
});

combat('bandit', {
  name: 'Bandit',
  examine: 'A shifty looking sort.',
  level: 14,
  colour: 0x7a4a2c,
  shape: 'humanoid',
  aggressive: true,
  aggroRadius: 5,
  pickpocket: { level: 20, xp: 26, coins: [10, 40] },
  stats: { attack: 14, strength: 14, defense: 12, hits: 26 },
  bonuses: { aim: 8, power: 8, armour: 10 },
  drops: [BONE_DROP, ['coins', 70, 10, 90], ['iron_sword', 10, 1, 1], ['steel_dagger', 6, 1, 1], ['chaos_rune', 8, 1, 5], ['grimy_guam', 10, 1, 1]],
});

combat('skeleton', {
  name: 'Skeleton',
  examine: 'It rattles as it walks.',
  level: 21,
  colour: 0xdedbcf,
  shape: 'humanoid',
  aggressive: true,
  aggroRadius: 6,
  stats: { attack: 20, strength: 20, defense: 18, hits: 32 },
  bonuses: { aim: 12, power: 12, armour: 14 },
  drops: [BONE_DROP, ['coins', 60, 20, 150], ['steel_sword', 8, 1, 1], ['mithril_dagger', 4, 1, 1], ['death_rune', 5, 1, 3], ['gold_ore', 8, 1, 1]],
});

combat('ogre', {
  name: 'Ogre',
  examine: 'A big, angry brute.',
  level: 40,
  scale: 1.5,
  colour: 0x8a7a4a,
  shape: 'humanoid',
  aggressive: true,
  aggroRadius: 7,
  stats: { attack: 40, strength: 44, defense: 38, hits: 70 },
  bonuses: { aim: 26, power: 30, armour: 28 },
  drops: [
    ['big_bones', 0, 1, 1],
    ['coins', 60, 60, 400],
    ['mithril_longsword', 6, 1, 1],
    ['adamantite_helmet', 3, 1, 1],
    ['sapphire', 4, 1, 1],
    ['limpwurt_root', 10, 1, 2],
  ],
});

combat('dragon', {
  name: 'Green dragon',
  examine: 'It breathes fire. Bring a shield.',
  level: 79,
  scale: 2.2,
  colour: 0x3d6b3a,
  shape: 'dragon',
  aggressive: true,
  aggroRadius: 8,
  respawn: 60,
  breath: { max: 20, chance: 0.25 },
  stats: { attack: 68, strength: 70, defense: 68, hits: 130 },
  bonuses: { aim: 50, power: 55, armour: 60 },
  drops: [
    ['big_bones', 0, 1, 1],
    ['coins', 40, 400, 1800],
    ['nature_rune', 20, 8, 20],
    ['death_rune', 15, 3, 12],
    ['adamantite_platebody', 4, 1, 1],
    ['sapphire', 8, 1, 2],
  ],
});

// Peaceful NPCs -------------------------------------------------------------
define('banker', {
  name: 'Banker',
  examine: 'He looks after your valuables.',
  colour: 0x2d4a7a,
  shape: 'humanoid',
  wanderRadius: 0,
  role: 'bank',
  dialogue: ['Good day. Would you like to access your bank account?'],
});

define('shopkeeper', {
  name: 'Shopkeeper',
  examine: 'He owns the general store.',
  colour: 0x8a5a2c,
  shape: 'humanoid',
  wanderRadius: 0,
  role: 'shop',
  shop: 'general',
  dialogue: ['Welcome to my shop. Take a look at my wares.'],
});

define('smith', {
  name: 'Master smith',
  examine: 'He hammers metal all day.',
  colour: 0x555555,
  shape: 'humanoid',
  wanderRadius: 0,
  role: 'shop',
  shop: 'smith',
  dialogue: ['Smelt your ore in the furnace, then hammer bars on my anvil.'],
});

define('guide', {
  name: 'Village elder',
  examine: 'She knows the lay of the land.',
  colour: 0x6a3d7a,
  shape: 'humanoid',
  wanderRadius: 0,
  role: 'quest',
  quest: 'lost_heirloom',
  dialogue: [
    'Welcome to Ashford, traveller.',
    'Mine copper and tin to the north, smelt them at the furnace, and hammer bronze on the anvil.',
    'Bandits stole my family heirloom. Bring it back and I will reward you.',
  ],
});

export const SHOPS = {
  general: {
    name: 'General store',
    stock: [
      ['tinderbox', 10],
      ['hammer', 10],
      ['knife', 10],
      ['small_net', 10],
      ['fishing_rod', 10],
      ['bait', 500],
      ['needle', 10],
      ['thread', 500],
      ['bronze_pickaxe', 5],
      ['bronze_axe', 5],
      ['feather', 500],
      ['bow_string', 50],
      ['vial_of_water', 30],
      ['eye_of_newt', 30],
      ['bread', 20],
    ],
    buyMultiplier: 1.3,
    sellMultiplier: 0.5,
  },
  smith: {
    name: 'Smithing supplies',
    stock: [
      ['hammer', 10],
      ['iron_pickaxe', 4],
      ['iron_axe', 4],
      ['steel_pickaxe', 2],
      ['bronze_bar', 20],
      ['iron_bar', 10],
    ],
    buyMultiplier: 1.4,
    sellMultiplier: 0.5,
  },
};

export const NPCS = npcs;

export function getNpc(id) {
  const npc = npcs[id];
  if (!npc) throw new Error(`Unknown npc: ${id}`);
  return npc;
}

/** Roll a drop table: guaranteed entries (weight 0) plus at most one weighted roll. */
export function rollDrops(def, random = Math.random) {
  const results = [];
  const table = def.drops ?? [];
  const guaranteed = table.filter((d) => d[1] === 0);
  const weighted = table.filter((d) => d[1] > 0);
  for (const [id, , min, max] of guaranteed) {
    results.push({ id, count: min + Math.floor(random() * (max - min + 1)) });
  }
  const total = weighted.reduce((sum, d) => sum + d[1], 0);
  if (total > 0) {
    // A miss is possible: the table is rolled against 128 slots like the classic engine.
    let roll = random() * Math.max(total, 128);
    for (const [id, weight, min, max] of weighted) {
      roll -= weight;
      if (roll <= 0) {
        results.push({ id, count: min + Math.floor(random() * (max - min + 1)) });
        break;
      }
    }
  }
  return results;
}
