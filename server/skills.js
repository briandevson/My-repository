import { getItem, SMITHING_RECIPES } from '../shared/items.js';
import { getObject } from '../shared/objects.js';
import { addItem, countOf, freeSlots, hasItems, removeItem, removeItems } from './container.js';

/**
 * Non-combat skills.
 *
 * Gathering skills (mining, woodcutting, fishing) run as a repeating action:
 * `beginGather` validates once, then `tickGather` rolls for success every tick
 * until the player moves, the object depletes, or the inventory fills up.
 *
 * Production skills resolve immediately, usually through a menu the player picks
 * from (`openMenu` in world.js).
 */

export const SMELTING = {
  bronze_bar: { level: 1, xp: 6.2, inputs: { copper_ore: 1, tin_ore: 1 } },
  iron_bar: { level: 15, xp: 12.5, inputs: { iron_ore: 1 }, failChance: 0.5 },
  silver_or_steel: null, // placeholder removed
  steel_bar: { level: 30, xp: 17.5, inputs: { iron_ore: 1, coal: 2 } },
  gold_bar: { level: 40, xp: 22.5, inputs: { gold_ore: 1 } },
  mithril_bar: { level: 50, xp: 30, inputs: { mithril_ore: 1, coal: 4 } },
  adamantite_bar: { level: 70, xp: 37.5, inputs: { adamantite_ore: 1, coal: 6 } },
};
delete SMELTING.silver_or_steel;

export const CRAFTING = [
  { id: 'leather_gloves', level: 1, xp: 13.8, inputs: { leather: 1 }, tools: ['needle'], uses: { thread: 1 } },
  { id: 'boots', level: 7, xp: 16.25, inputs: { leather: 1 }, tools: ['needle'], uses: { thread: 1 } },
  { id: 'leather_body', level: 14, xp: 25, inputs: { leather: 1 }, tools: ['needle'], uses: { thread: 1 } },
  { id: 'gold_ring', level: 5, xp: 15, inputs: { gold_bar: 1 } },
  { id: 'gold_amulet', level: 8, xp: 30, inputs: { gold_bar: 1 } },
  { id: 'sapphire_amulet', level: 24, xp: 65, inputs: { gold_bar: 1, sapphire: 1 } },
];

export const FLETCHING = [
  { id: 'arrow_shaft', count: 15, level: 1, xp: 5, log: 'logs' },
  { id: 'shortbow', level: 5, xp: 5, log: 'logs', uses: { bow_string: 1 } },
  { id: 'longbow', level: 10, xp: 10, log: 'logs', uses: { bow_string: 1 } },
  { id: 'oak_shortbow', level: 20, xp: 16.5, log: 'oak_logs', uses: { bow_string: 1 } },
  { id: 'oak_longbow', level: 25, xp: 25, log: 'oak_logs', uses: { bow_string: 1 } },
  { id: 'willow_shortbow', level: 35, xp: 33.3, log: 'willow_logs', uses: { bow_string: 1 } },
  { id: 'maple_shortbow', level: 50, xp: 50, log: 'maple_logs', uses: { bow_string: 1 } },
];

export const HERBLORE = [
  { id: 'attack_potion', level: 3, xp: 25, inputs: { vial_of_water: 1, guam_leaf: 1, eye_of_newt: 1 } },
  { id: 'strength_potion', level: 12, xp: 50, inputs: { vial_of_water: 1, guam_leaf: 1, limpwurt_root: 1 } },
];

// ---------------------------------------------------------------------------
// Gathering
// ---------------------------------------------------------------------------

/** Find an equipped-or-carried tool of `type`, best first. */
export function findTool(player, type) {
  let best = null;
  const consider = (id) => {
    const item = getItem(id);
    if (item.tool?.type !== type) return;
    if (!best || item.tool.power > best.tool.power) best = item;
  };
  for (const slot of player.inventory) if (slot) consider(slot.id);
  const weapon = player.equipment.weapon;
  if (weapon) consider(weapon.id);
  return best;
}

const TOOL_NAMES = {
  axe: 'axe',
  pickaxe: 'pickaxe',
  net: 'small fishing net',
  rod: 'fishing rod',
  harpoon: 'harpoon',
  pot: 'lobster pot',
  tinderbox: 'tinderbox',
  hammer: 'hammer',
  knife: 'knife',
  needle: 'needle',
};

/**
 * Validate a gather attempt and store it as the player's repeating action.
 * @returns {{ok:boolean, reason?:string, action?:object}}
 */
export function beginGather(player, objectState) {
  const def = getObject(objectState.type);
  if (objectState.depleted) return { ok: false, reason: 'There is nothing left to take here.' };

  // Fishing spots offer several options; pick the best one the player qualifies for.
  const candidates = def.gather ? [def.gather] : def.options ?? [];
  if (candidates.length === 0) return { ok: false, reason: 'Nothing interesting happens.' };

  const usable = candidates
    .filter((option) => findTool(player, option.tool))
    .filter((option) => player.level(option.skill ?? skillForOption(def)) >= option.level);
  if (usable.length === 0) {
    const first = candidates[0];
    const skill = first.skill ?? skillForOption(def);
    if (!findTool(player, first.tool)) {
      return { ok: false, reason: `You need a ${TOOL_NAMES[first.tool] ?? first.tool} to do that.` };
    }
    return { ok: false, reason: `You need ${skill} level ${first.level} to do that.` };
  }
  const option = usable[usable.length - 1];
  const skill = option.skill ?? skillForOption(def);
  return {
    ok: true,
    action: {
      type: 'gather',
      objectIndex: objectState.index,
      option: { ...option, skill },
      startedAt: 0,
    },
  };
}

function skillForOption(def) {
  if (def.kind === 'fishing') return 'fishing';
  if (def.kind === 'tree') return 'woodcutting';
  if (def.kind === 'rock') return 'mining';
  return 'thieving';
}

/** Probability of succeeding on any given tick. */
export function gatherChance(player, option) {
  const tool = findTool(player, option.tool);
  const level = player.effectiveLevel(option.skill);
  const chance = option.baseChance + (level - option.level) * 0.012 + (tool?.tool.power ?? 0) * 0.006;
  return Math.max(0.05, Math.min(0.92, chance));
}

// ---------------------------------------------------------------------------
// Production
// ---------------------------------------------------------------------------

export function smeltOptions(player) {
  return Object.entries(SMELTING).map(([barId, recipe]) => ({
    id: barId,
    label: getItem(barId).name,
    level: recipe.level,
    enabled: player.level('smithing') >= recipe.level && hasItems(player.inventory, recipe.inputs),
  }));
}

export function smelt(player, barId) {
  const recipe = SMELTING[barId];
  if (!recipe) return { ok: false, reason: 'You cannot smelt that.' };
  if (player.level('smithing') < recipe.level) {
    return { ok: false, reason: `You need smithing level ${recipe.level} to smelt that.` };
  }
  if (!hasItems(player.inventory, recipe.inputs)) {
    return { ok: false, reason: 'You do not have the ore you need.' };
  }
  removeItems(player.inventory, recipe.inputs);
  if (recipe.failChance && Math.random() < recipe.failChance) {
    return { ok: true, message: 'The ore is too impure and you fail to refine it.' };
  }
  addItem(player.inventory, barId, 1);
  player.addXp('smithing', recipe.xp);
  return { ok: true, message: `You smelt a ${getItem(barId).name.toLowerCase()}.`, xp: recipe.xp };
}

export function smithOptions(player, barId) {
  const level = player.level('smithing');
  const bars = countOf(player.inventory, barId);
  return SMITHING_RECIPES.filter((recipe) => recipe.bar === barId).map((recipe) => ({
    id: recipe.id,
    label: `${getItem(recipe.id).name} (${recipe.bars} bar${recipe.bars > 1 ? 's' : ''})`,
    level: recipe.level,
    enabled: level >= recipe.level && bars >= recipe.bars,
  }));
}

export function smith(player, itemId) {
  const recipe = SMITHING_RECIPES.find((entry) => entry.id === itemId);
  if (!recipe) return { ok: false, reason: 'You cannot make that.' };
  if (player.level('smithing') < recipe.level) {
    return { ok: false, reason: `You need smithing level ${recipe.level} to make that.` };
  }
  if (countOf(player.inventory, recipe.bar) < recipe.bars) {
    return { ok: false, reason: `You need ${recipe.bars} ${getItem(recipe.bar).name.toLowerCase()}.` };
  }
  if (!findTool(player, 'hammer')) return { ok: false, reason: 'You need a hammer to work the metal.' };
  removeItem(player.inventory, recipe.bar, recipe.bars);
  const made = getItem(itemId);
  addItem(player.inventory, itemId, made.stackable ? 15 : 1);
  player.addXp('smithing', recipe.xp);
  return { ok: true, message: `You hammer out a ${made.name.toLowerCase()}.`, xp: recipe.xp };
}

export function cook(player, slotIndex, onRange) {
  const slot = player.inventory[slotIndex];
  if (!slot) return { ok: false, reason: 'Nothing to cook.' };
  const item = getItem(slot.id);
  if (!item.cookable) return { ok: false, reason: `You cannot cook the ${item.name.toLowerCase()}.` };
  const recipe = item.cookable;
  const level = player.level('cooking');
  if (level < recipe.level) return { ok: false, reason: `You need cooking level ${recipe.level} to cook that.` };

  removeItem(player.inventory, slot.id, 1);
  const span = Math.max(1, recipe.burnLevel - recipe.level);
  let burnChance = Math.max(0, (recipe.burnLevel - level) / span) * 0.55;
  if (onRange) burnChance *= 0.6;
  if (Math.random() < burnChance) {
    addItem(player.inventory, 'burnt_fish', 1);
    return { ok: true, message: 'You accidentally burn it.' };
  }
  addItem(player.inventory, recipe.result, 1);
  player.addXp('cooking', recipe.xp);
  return { ok: true, message: `You cook the ${item.name.toLowerCase().replace('raw ', '')}.`, xp: recipe.xp };
}

export function lightFire(player, slotIndex) {
  const slot = player.inventory[slotIndex];
  if (!slot) return { ok: false, reason: 'Nothing to burn.' };
  const item = getItem(slot.id);
  if (!item.firemaking) return { ok: false, reason: 'You cannot light that.' };
  if (!findTool(player, 'tinderbox')) return { ok: false, reason: 'You need a tinderbox to light a fire.' };
  if (player.level('firemaking') < item.firemaking.level) {
    return { ok: false, reason: `You need firemaking level ${item.firemaking.level} to light those.` };
  }
  const success = 0.35 + (player.level('firemaking') - item.firemaking.level) * 0.01;
  removeItem(player.inventory, slot.id, 1);
  if (Math.random() > Math.min(0.95, success)) {
    return { ok: true, message: 'You fail to light the logs.', burnt: true };
  }
  player.addXp('firemaking', item.firemaking.xp);
  return { ok: true, message: 'The fire catches and the logs begin to burn.', lit: true, xp: item.firemaking.xp };
}

export function fletchOptions(player, logId) {
  const level = player.level('fletching');
  return FLETCHING.filter((recipe) => recipe.log === logId).map((recipe) => ({
    id: recipe.id,
    label: recipe.count ? `${getItem(recipe.id).name} x${recipe.count}` : getItem(recipe.id).name,
    level: recipe.level,
    enabled: level >= recipe.level && (!recipe.uses || hasItems(player.inventory, recipe.uses)),
  }));
}

export function fletch(player, itemId, logId) {
  const recipe = FLETCHING.find((entry) => entry.id === itemId && entry.log === logId);
  if (!recipe) return { ok: false, reason: 'You cannot make that.' };
  if (player.level('fletching') < recipe.level) {
    return { ok: false, reason: `You need fletching level ${recipe.level} to make that.` };
  }
  if (!findTool(player, 'knife')) return { ok: false, reason: 'You need a knife.' };
  if (countOf(player.inventory, logId) < 1) return { ok: false, reason: 'You have no logs.' };
  if (recipe.uses && !hasItems(player.inventory, recipe.uses)) {
    return { ok: false, reason: 'You need a bow string for that.' };
  }
  removeItem(player.inventory, logId, 1);
  if (recipe.uses) removeItems(player.inventory, recipe.uses);
  addItem(player.inventory, recipe.id, recipe.count ?? 1);
  player.addXp('fletching', recipe.xp);
  return { ok: true, message: `You make ${getItem(recipe.id).name.toLowerCase()}.`, xp: recipe.xp };
}

export function craftOptions(player) {
  const level = player.level('crafting');
  return CRAFTING.map((recipe) => ({
    id: recipe.id,
    label: getItem(recipe.id).name,
    level: recipe.level,
    enabled:
      level >= recipe.level &&
      hasItems(player.inventory, recipe.inputs) &&
      (!recipe.uses || hasItems(player.inventory, recipe.uses)) &&
      (recipe.tools ?? []).every((tool) => findTool(player, tool)),
  }));
}

export function craft(player, itemId) {
  const recipe = CRAFTING.find((entry) => entry.id === itemId);
  if (!recipe) return { ok: false, reason: 'You cannot make that.' };
  if (player.level('crafting') < recipe.level) {
    return { ok: false, reason: `You need crafting level ${recipe.level} to make that.` };
  }
  for (const tool of recipe.tools ?? []) {
    if (!findTool(player, tool)) return { ok: false, reason: `You need a ${TOOL_NAMES[tool] ?? tool}.` };
  }
  if (!hasItems(player.inventory, recipe.inputs)) return { ok: false, reason: 'You lack the materials.' };
  if (recipe.uses && !hasItems(player.inventory, recipe.uses)) return { ok: false, reason: 'You lack the materials.' };
  removeItems(player.inventory, recipe.inputs);
  if (recipe.uses) removeItems(player.inventory, recipe.uses);
  addItem(player.inventory, itemId, 1);
  player.addXp('crafting', recipe.xp);
  return { ok: true, message: `You craft a ${getItem(itemId).name.toLowerCase()}.`, xp: recipe.xp };
}

export function mixPotion(player, itemId) {
  const recipe = HERBLORE.find((entry) => entry.id === itemId);
  if (!recipe) return { ok: false, reason: 'Nothing happens.' };
  if (player.level('herblore') < recipe.level) {
    return { ok: false, reason: `You need herblore level ${recipe.level} to mix that.` };
  }
  if (!hasItems(player.inventory, recipe.inputs)) return { ok: false, reason: 'You lack the ingredients.' };
  removeItems(player.inventory, recipe.inputs);
  addItem(player.inventory, itemId, 1);
  player.addXp('herblore', recipe.xp);
  return { ok: true, message: `You mix a ${getItem(itemId).name.toLowerCase()}.`, xp: recipe.xp };
}

export function cleanHerb(player, slotIndex) {
  const slot = player.inventory[slotIndex];
  const item = slot && getItem(slot.id);
  if (!item?.cleanable) return { ok: false, reason: 'Nothing happens.' };
  if (player.level('herblore') < item.cleanable.level) {
    return { ok: false, reason: `You need herblore level ${item.cleanable.level} to identify that.` };
  }
  removeItem(player.inventory, slot.id, 1);
  addItem(player.inventory, item.cleanable.result, 1);
  player.addXp('herblore', item.cleanable.xp);
  return { ok: true, message: `It is a ${getItem(item.cleanable.result).name.toLowerCase()}.` };
}

export function buryBones(player, slotIndex) {
  const slot = player.inventory[slotIndex];
  const item = slot && getItem(slot.id);
  if (!item?.prayerXp) return { ok: false, reason: 'You cannot bury that.' };
  removeItem(player.inventory, slot.id, 1);
  player.addXp('prayer', item.prayerXp);
  return { ok: true, message: 'You dig a hole and bury the bones.', xp: item.prayerXp };
}

export function eat(player, slotIndex) {
  const slot = player.inventory[slotIndex];
  const item = slot && getItem(slot.id);
  if (!item?.edible) return { ok: false, reason: 'You cannot eat that.' };
  removeItem(player.inventory, slot.id, 1);
  player.heal(item.edible.heals);
  return { ok: true, message: `You eat the ${item.name.toLowerCase()}. It heals some health.` };
}

export function drink(player, slotIndex) {
  const slot = player.inventory[slotIndex];
  const item = slot && getItem(slot.id);
  if (!item?.drinkable) return { ok: false, reason: 'You cannot drink that.' };
  removeItem(player.inventory, slot.id, 1);
  addItem(player.inventory, 'vial_of_water', 1);
  const { skill, boost } = item.drinkable;
  const amount = Math.max(1, Math.floor(player.level(skill) * 0.1) + boost);
  player.boosts[skill] = { amount, ticks: 200 };
  return { ok: true, message: `You drink the potion. Your ${skill} feels stronger.` };
}

export function pickpocket(player, npc) {
  const info = npc.def.pickpocket;
  if (!info) return { ok: false, reason: 'You cannot steal from them.' };
  if (player.level('thieving') < info.level) {
    return { ok: false, reason: `You need thieving level ${info.level} to pick their pocket.` };
  }
  const chance = 0.35 + (player.level('thieving') - info.level) * 0.012;
  if (Math.random() > Math.min(0.9, chance)) {
    return { ok: false, caught: true, reason: 'You fail and they spot you!' };
  }
  const [min, max] = info.coins;
  const amount = min + Math.floor(Math.random() * (max - min + 1));
  if (freeSlots(player.inventory) === 0 && countOf(player.inventory, 'coins') === 0) {
    return { ok: false, reason: 'Your inventory is too full.' };
  }
  addItem(player.inventory, 'coins', amount);
  player.addXp('thieving', info.xp);
  return { ok: true, message: `You steal ${amount} coins.`, xp: info.xp };
}

export function stealFromStall(player, objectState) {
  const def = getObject(objectState.type);
  const info = def.thieving;
  if (!info) return { ok: false, reason: 'Nothing happens.' };
  if (objectState.depleted) return { ok: false, reason: 'The stall has been picked clean.' };
  if (player.level('thieving') < info.level) {
    return { ok: false, reason: `You need thieving level ${info.level} to steal from that.` };
  }
  const [min, max] = info.count;
  const amount = min + Math.floor(Math.random() * (max - min + 1));
  addItem(player.inventory, info.item, amount);
  player.addXp('thieving', info.xp);
  return { ok: true, message: `You steal from the ${def.name.toLowerCase()}.`, deplete: true, xp: info.xp };
}

export function useObstacle(player, objectState) {
  const def = getObject(objectState.type);
  const info = def.agility;
  if (!info) return { ok: false, reason: 'Nothing happens.' };
  if (player.level('agility') < info.level) {
    return { ok: false, reason: `You need agility level ${info.level} to attempt that.` };
  }
  player.addXp('agility', info.xp);
  return {
    ok: true,
    message: `You cross the ${def.name.toLowerCase()}.`,
    move: { x: objectState.x + info.dx, y: objectState.y + info.dy },
    xp: info.xp,
  };
}
