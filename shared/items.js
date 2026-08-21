import { levelForXp } from './xp.js';

/**
 * Item catalogue.
 *
 * Every entry is `{ id, name, examine, value, stackable, equip?, edible?, tags? }`.
 * `equip` carries `{ slot, reqs, bonuses }` where bonuses are:
 *   aim/power  - melee accuracy and damage
 *   armour     - defensive value
 *   ranged     - ranged accuracy and damage
 *   magic      - magic accuracy
 *   prayer     - prayer point drain resistance
 */

const items = {};

function define(id, def) {
  items[id] = { id, stackable: false, value: 1, examine: def.name, ...def };
  return items[id];
}

// ---------------------------------------------------------------------------
// Currency and junk
// ---------------------------------------------------------------------------
define('coins', { name: 'Coins', examine: 'Lovely money!', stackable: true, value: 1 });
define('bones', { name: 'Bones', examine: 'Bury them for prayer experience.', value: 1, tags: ['buryable'], prayerXp: 4.5 });
define('big_bones', { name: 'Big bones', examine: 'Bury them for prayer experience.', value: 3, tags: ['buryable'], prayerXp: 15 });
define('feather', { name: 'Feather', examine: 'A soft feather.', stackable: true, value: 2 });
define('ashes', { name: 'Ashes', examine: 'All that is left of a fire.', value: 1 });
define('heirloom', { name: 'Silver locket', examine: 'The village elder is looking for this.', value: 200, tags: ['quest'] });

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------
const TOOL_TIERS = [
  ['bronze', 1, 20],
  ['iron', 1, 60],
  ['steel', 6, 200],
  ['mithril', 21, 900],
  ['adamantite', 31, 3200],
];
for (const [tier, level, value] of TOOL_TIERS) {
  const label = tier[0].toUpperCase() + tier.slice(1);
  define(`${tier}_pickaxe`, {
    name: `${label} pickaxe`,
    examine: 'Used for mining rock.',
    value,
    tool: { type: 'pickaxe', level, power: level },
    equip: { slot: 'weapon', reqs: { attack: level === 1 ? 1 : level }, bonuses: { aim: level, power: level } },
  });
  define(`${tier}_axe`, {
    name: `${label} axe`,
    examine: 'Good for chopping trees.',
    value,
    tool: { type: 'axe', level, power: level },
    equip: { slot: 'weapon', reqs: { attack: level === 1 ? 1 : level }, bonuses: { aim: level, power: level + 2 } },
  });
}
define('tinderbox', { name: 'Tinderbox', examine: 'Useful for lighting fires.', value: 5, tool: { type: 'tinderbox', level: 1 } });
define('hammer', { name: 'Hammer', examine: 'Good for hitting things.', value: 5, tool: { type: 'hammer', level: 1 } });
define('knife', { name: 'Knife', examine: 'Sharp and pointy.', value: 6, tool: { type: 'knife', level: 1 } });
define('small_net', { name: 'Small fishing net', examine: 'Useful for catching small fish.', value: 5, tool: { type: 'net', level: 1 } });
define('fishing_rod', { name: 'Fishing rod', examine: 'Useful for catching fish.', value: 5, tool: { type: 'rod', level: 1 } });
define('harpoon', { name: 'Harpoon', examine: 'Useful for catching big fish.', value: 45, tool: { type: 'harpoon', level: 1 } });
define('lobster_pot', { name: 'Lobster pot', examine: 'Useful for catching lobsters.', value: 20, tool: { type: 'pot', level: 1 } });
define('bait', { name: 'Fishing bait', examine: 'Wriggly.', stackable: true, value: 1 });
define('needle', { name: 'Needle', examine: 'Used in crafting.', value: 3, tool: { type: 'needle', level: 1 } });
define('thread', { name: 'Thread', examine: 'Fine string.', stackable: true, value: 1 });
define('chisel', { name: 'Chisel', examine: 'For cutting gems.', value: 6, tool: { type: 'chisel', level: 1 } });

// ---------------------------------------------------------------------------
// Mining and smithing
// ---------------------------------------------------------------------------
const ORES = [
  ['copper_ore', 'Copper ore', 3],
  ['tin_ore', 'Tin ore', 3],
  ['iron_ore', 'Iron ore', 17],
  ['coal', 'Coal', 45],
  ['gold_ore', 'Gold ore', 150],
  ['mithril_ore', 'Mithril ore', 243],
  ['adamantite_ore', 'Adamantite ore', 480],
];
for (const [id, name, value] of ORES) define(id, { name, examine: 'Needs refining.', value });

const BARS = [
  ['bronze_bar', 'Bronze bar', 8],
  ['iron_bar', 'Iron bar', 30],
  ['steel_bar', 'Steel bar', 90],
  ['gold_bar', 'Gold bar', 300],
  ['mithril_bar', 'Mithril bar', 486],
  ['adamantite_bar', 'Adamantite bar', 960],
];
for (const [id, name, value] of BARS) define(id, { name, examine: 'A bar of refined metal.', value });

// ---------------------------------------------------------------------------
// Weapons and armour, generated per metal tier
// ---------------------------------------------------------------------------
export const METAL_TIERS = {
  bronze: { req: 1, mult: 1, bar: 'bronze_bar', value: 1 },
  iron: { req: 1, mult: 1.6, bar: 'iron_bar', value: 3 },
  steel: { req: 5, mult: 2.4, bar: 'steel_bar', value: 10 },
  mithril: { req: 20, mult: 3.6, bar: 'mithril_bar', value: 40 },
  adamantite: { req: 30, mult: 5.0, bar: 'adamantite_bar', value: 130 },
};

// [suffix, label, slot, bars, smithLevel, aim, power, armour]
const SMITHABLE = [
  ['dagger', 'dagger', 'weapon', 1, 1, 4, 4, 0],
  ['sword', 'sword', 'weapon', 1, 4, 7, 6, 0],
  ['mace', 'mace', 'weapon', 1, 2, 6, 7, 0],
  ['longsword', 'longsword', 'weapon', 2, 6, 10, 9, 0],
  ['battleaxe', 'battleaxe', 'weapon', 3, 10, 12, 13, 0],
  ['helmet', 'helmet', 'head', 1, 3, 0, 0, 6],
  ['shield', 'kiteshield', 'shield', 3, 12, 0, 0, 10],
  ['platebody', 'platebody', 'body', 5, 18, 0, 0, 16],
  ['platelegs', 'platelegs', 'legs', 3, 16, 0, 0, 11],
  ['nails', 'nails', null, 1, 4, 0, 0, 0],
];

export const SMITHING_RECIPES = [];

for (const [tier, meta] of Object.entries(METAL_TIERS)) {
  const label = tier[0].toUpperCase() + tier.slice(1);
  for (const [suffix, kind, slot, bars, baseLevel, aim, power, armour] of SMITHABLE) {
    const id = `${tier}_${suffix}`;
    const smithLevel = Math.max(1, Math.round(baseLevel + (meta.req === 1 ? 0 : meta.req)));
    const value = Math.round((bars * 20 + aim * 4 + armour * 6) * meta.value);
    if (slot) {
      define(id, {
        name: `${label} ${kind}`,
        examine: `A ${tier} ${kind}.`,
        value,
        equip: {
          slot,
          reqs: slot === 'weapon' ? { attack: meta.req } : { defense: meta.req },
          bonuses: {
            aim: Math.round(aim * meta.mult),
            power: Math.round(power * meta.mult),
            armour: Math.round(armour * meta.mult),
          },
          twoHanded: suffix === 'battleaxe',
          speed: suffix === 'dagger' ? 4 : suffix === 'battleaxe' ? 6 : 5,
        },
      });
    } else {
      define(id, { name: `${label} nails`, examine: 'Used in construction.', stackable: true, value });
    }
    SMITHING_RECIPES.push({ id, bar: meta.bar, bars, level: smithLevel, xp: bars * 12.5 * (1 + meta.req / 20) });
  }
}

// Leather / ranged gear
define('leather', { name: 'Leather', examine: 'Cured cowhide.', value: 6 });
define('cowhide', { name: 'Cowhide', examine: 'This needs tanning.', value: 4 });
define('leather_body', { name: 'Leather body', examine: 'Light armour.', value: 24, equip: { slot: 'body', reqs: {}, bonuses: { armour: 5, ranged: 2 } } });
define('leather_gloves', { name: 'Leather gloves', examine: 'Light gloves.', value: 12, equip: { slot: 'hands', reqs: {}, bonuses: { armour: 2 } } });
define('boots', { name: 'Leather boots', examine: 'Sturdy boots.', value: 12, equip: { slot: 'feet', reqs: {}, bonuses: { armour: 2 } } });
define('cape', { name: 'Cape', examine: 'A woollen cape.', value: 10, equip: { slot: 'cape', reqs: {}, bonuses: { armour: 1 } } });

const BOWS = [
  ['shortbow', 'Shortbow', 1, 8, 50],
  ['longbow', 'Longbow', 1, 10, 80],
  ['oak_shortbow', 'Oak shortbow', 5, 14, 160],
  ['oak_longbow', 'Oak longbow', 10, 18, 240],
  ['willow_shortbow', 'Willow shortbow', 20, 24, 400],
  ['maple_shortbow', 'Maple shortbow', 30, 32, 800],
];
for (const [id, name, req, ranged, value] of BOWS) {
  define(id, {
    name,
    examine: 'A finely strung bow.',
    value,
    equip: { slot: 'weapon', reqs: { ranged: req }, bonuses: { ranged }, twoHanded: true, ranged: true, speed: id.includes('long') ? 6 : 5 },
  });
}

for (const [tier, meta] of Object.entries(METAL_TIERS)) {
  const label = tier[0].toUpperCase() + tier.slice(1);
  define(`${tier}_arrows`, {
    name: `${label} arrows`,
    examine: 'Arrows with a metal tip.',
    stackable: true,
    value: Math.max(1, Math.round(meta.value * 3)),
    equip: { slot: 'ammo', reqs: { ranged: meta.req }, bonuses: { ranged: Math.round(4 * meta.mult) } },
  });
  define(`${tier}_arrowtips`, { name: `${label} arrowtips`, examine: 'Arrow tips.', stackable: true, value: meta.value * 2 });
}
define('arrow_shaft', { name: 'Arrow shaft', examine: 'A wooden shaft.', stackable: true, value: 1 });
define('headless_arrow', { name: 'Headless arrow', examine: 'A shaft with a feather.', stackable: true, value: 2 });
define('bow_string', { name: 'Bow string', examine: 'Made from flax.', stackable: true, value: 30 });

// Jewellery
define('gold_ring', { name: 'Gold ring', examine: 'A valuable ring.', value: 350, equip: { slot: 'ring', reqs: {}, bonuses: { armour: 1 } } });
define('gold_amulet', { name: 'Gold amulet', examine: 'A valuable amulet.', value: 450, equip: { slot: 'amulet', reqs: {}, bonuses: { aim: 4, armour: 2 } } });
define('sapphire', { name: 'Sapphire', examine: 'A blue gem.', value: 900 });
define('sapphire_amulet', { name: 'Sapphire amulet', examine: 'A gem-set amulet.', value: 1800, equip: { slot: 'amulet', reqs: {}, bonuses: { aim: 8, armour: 3, magic: 4 } } });

// ---------------------------------------------------------------------------
// Woodcutting / firemaking / fletching
// ---------------------------------------------------------------------------
const LOGS = [
  ['logs', 'Logs', 1, 4, 40, 'shortbow', 'longbow'],
  ['oak_logs', 'Oak logs', 15, 12, 60, 'oak_shortbow', 'oak_longbow'],
  ['willow_logs', 'Willow logs', 30, 30, 90, 'willow_shortbow', null],
  ['maple_logs', 'Maple logs', 45, 60, 135, 'maple_shortbow', null],
];
for (const [id, name, fmLevel, value, fmXp] of LOGS) {
  define(id, { name, examine: 'A bundle of logs.', value, firemaking: { level: fmLevel, xp: fmXp } });
}

// ---------------------------------------------------------------------------
// Fishing and cooking
// ---------------------------------------------------------------------------
const FOOD = [
  ['shrimp', 'Shrimp', 1, 30, 3, 5],
  ['sardine', 'Sardine', 5, 40, 4, 8],
  ['trout', 'Trout', 15, 70, 7, 20],
  ['salmon', 'Salmon', 25, 90, 9, 40],
  ['tuna', 'Tuna', 30, 100, 10, 60],
  ['lobster', 'Lobster', 40, 120, 12, 100],
  ['swordfish', 'Swordfish', 45, 140, 14, 180],
];
for (const [id, name, cookLevel, cookXp, heals, value] of FOOD) {
  define(`raw_${id}`, { name: `Raw ${name.toLowerCase()}`, examine: 'I should cook this first.', value: Math.round(value * 0.6), cookable: { level: cookLevel, xp: cookXp, result: id, burnLevel: cookLevel + 34 } });
  define(id, { name, examine: 'Tasty and filling.', value, edible: { heals } });
}
define('burnt_fish', { name: 'Burnt fish', examine: 'Oops.', value: 1 });
define('bread', { name: 'Bread', examine: 'Freshly baked.', value: 12, edible: { heals: 5 } });
define('cake', { name: 'Cake', examine: 'A slice of heaven.', value: 100, edible: { heals: 12 } });

// ---------------------------------------------------------------------------
// Magic
// ---------------------------------------------------------------------------
const RUNES = [
  ['air_rune', 'Air-rune', 4],
  ['water_rune', 'Water-rune', 4],
  ['earth_rune', 'Earth-rune', 4],
  ['fire_rune', 'Fire-rune', 4],
  ['mind_rune', 'Mind-rune', 3],
  ['chaos_rune', 'Chaos-rune', 27],
  ['death_rune', 'Death-rune', 180],
  ['body_rune', 'Body-rune', 4],
  ['nature_rune', 'Nature-rune', 210],
];
for (const [id, name, value] of RUNES) define(id, { name, examine: 'A magical rune stone.', stackable: true, value });

define('staff_of_air', { name: 'Staff of air', examine: 'It supplies unlimited air runes.', value: 1500, equip: { slot: 'weapon', reqs: { magic: 1 }, bonuses: { aim: 5, power: 5, magic: 10 }, twoHanded: true, speed: 5, suppliesRune: 'air_rune' } });
define('wizard_hat', { name: 'Wizard hat', examine: 'A pointy hat.', value: 60, equip: { slot: 'head', reqs: {}, bonuses: { magic: 3 } } });
define('wizard_robe', { name: 'Wizard robe', examine: 'A magical robe.', value: 90, equip: { slot: 'body', reqs: {}, bonuses: { magic: 5 } } });

// ---------------------------------------------------------------------------
// Herblore
// ---------------------------------------------------------------------------
define('vial_of_water', { name: 'Vial of water', examine: 'A vial of water.', value: 6 });
define('grimy_guam', { name: 'Grimy guam', examine: 'A dirty herb.', value: 12, cleanable: { level: 3, xp: 2.5, result: 'guam_leaf' } });
define('guam_leaf', { name: 'Guam leaf', examine: 'A clean herb.', value: 20 });
define('eye_of_newt', { name: 'Eye of newt', examine: 'Yuck.', stackable: true, value: 10 });
define('attack_potion', { name: 'Attack potion', examine: 'Boosts your attack.', value: 90, drinkable: { skill: 'attack', boost: 3 } });
define('strength_potion', { name: 'Strength potion', examine: 'Boosts your strength.', value: 120, drinkable: { skill: 'strength', boost: 3 } });
define('limpwurt_root', { name: 'Limpwurt root', examine: 'A strange root.', value: 30 });

export const ITEMS = items;

export function getItem(id) {
  const item = items[id];
  if (!item) throw new Error(`Unknown item: ${id}`);
  return item;
}

export function itemExists(id) {
  return Object.hasOwn(items, id);
}

export function isStackable(id) {
  return !!items[id]?.stackable;
}

/** True when `stats` satisfy every requirement on the item's equip block. */
export function meetsRequirements(stats, item) {
  const reqs = item.equip?.reqs ?? {};
  for (const [skill, level] of Object.entries(reqs)) {
    if (levelForXp(stats[skill]?.xp ?? 0) < level) return { ok: false, skill, level };
  }
  return { ok: true };
}
