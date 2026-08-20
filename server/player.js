import {
  INVENTORY_SIZE,
  BANK_SIZE,
  EQUIP_SLOTS,
  RESPAWN_POINT,
  RUN_ENERGY_MAX,
  SKILLS,
  MAX_LEVEL,
} from '../shared/constants.js';
import { getItem, meetsRequirements } from '../shared/items.js';
import { PRAYERS } from '../shared/spells.js';
import { levelForXp, newStats, combatLevel, xpForLevel } from '../shared/xp.js';
import { createContainer, addItem, serialize, deserialize } from './container.js';

let nextId = 1;

export class Player {
  constructor(name, socket) {
    this.id = nextId++;
    this.kind = 'player';
    this.name = name; // canonical, lowercase - also the save key
    this.display = name.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
    this.socket = socket;

    this.x = RESPAWN_POINT.x;
    this.y = RESPAWN_POINT.y;
    this.dir = 0;

    this.stats = newStats();
    this.inventory = createContainer(INVENTORY_SIZE);
    this.bank = createContainer(BANK_SIZE);
    this.equipment = Object.fromEntries(EQUIP_SLOTS.map((slot) => [slot, null]));

    this.path = [];
    this.running = false;
    this.energy = RUN_ENERGY_MAX;

    /** Pending interaction, resolved once we are in range. See world.js. */
    this.action = null;
    this.target = null; // entity currently being fought
    this.combatStyle = 'controlled';
    this.spell = 'wind_strike';
    this.autocast = false;
    this.prayers = new Set();
    this.prayerPoints = levelForXp(this.stats.prayer.xp);

    this.attackCooldown = 0;
    this.actionCooldown = 0;
    this.lastAttackedBy = null;
    this.inCombatFor = 0;
    this.dead = false;
    this.respawnTimer = 0;
    this.boosts = {}; // skill -> { amount, ticks }
    this.quests = { lost_heirloom: 0 };
    this.chat = null; // { text, ticks }
    this.pending = null; // queued interaction waiting on movement
    this.menu = null; // open server-driven menu
    this.shop = null; // open shop id
    this.damageSplat = null;
    this.animation = null;
    this.dirty = { stats: true, inventory: true, equipment: true };
    this.appearance = {
      skin: 0xc98f5a,
      shirt: [0x3a5fb0, 0x7a2f2f, 0x2f7a4a, 0x7a5f2f][this.id % 4],
      legs: 0x40404a,
    };
  }

  // --- Stats ---------------------------------------------------------------

  level(skill) {
    return levelForXp(this.stats[skill].xp);
  }

  /** Level including any temporary potion boost. */
  effectiveLevel(skill) {
    const boost = this.boosts[skill]?.amount ?? 0;
    return this.level(skill) + boost;
  }

  get maxHits() {
    return this.level('hits');
  }

  get currentHits() {
    return this.stats.hits.current;
  }

  set currentHits(value) {
    this.stats.hits.current = Math.max(0, Math.min(this.maxHits, Math.round(value)));
  }

  get combatLevel() {
    return combatLevel(this.stats);
  }

  /**
   * Award experience and report any level ups so the caller can message the player.
   * @returns {Array<{skill:string,level:number}>}
   */
  addXp(skill, amount) {
    if (!SKILLS.includes(skill) || amount <= 0) return [];
    const before = this.level(skill);
    const cap = xpForLevel(MAX_LEVEL);
    this.stats[skill].xp = Math.min(cap, this.stats[skill].xp + amount);
    const after = this.level(skill);
    this.dirty.stats = true;
    if (after > before) {
      // Non-hits skills track "current" for boosts/drains; keep them in step.
      if (skill !== 'hits') this.stats[skill].current = after;
      else this.currentHits = this.currentHits + (after - before);
      if (skill === 'prayer') this.prayerPoints = Math.min(after, this.prayerPoints + (after - before));
      return [{ skill, level: after }];
    }
    return [];
  }

  // --- Equipment -----------------------------------------------------------

  /** Summed offensive/defensive bonuses from worn equipment. */
  bonuses() {
    const total = { aim: 0, power: 0, armour: 0, ranged: 0, magic: 0, prayer: 0 };
    for (const slot of EQUIP_SLOTS) {
      const worn = this.equipment[slot];
      if (!worn) continue;
      const bonuses = getItem(worn.id).equip?.bonuses ?? {};
      for (const [key, value] of Object.entries(bonuses)) total[key] = (total[key] ?? 0) + value;
    }
    return total;
  }

  weapon() {
    const worn = this.equipment.weapon;
    return worn ? getItem(worn.id) : null;
  }

  /** Attack interval in ticks; unarmed and most weapons swing every 3 ticks. */
  attackSpeed() {
    const weapon = this.weapon();
    return Math.max(2, Math.round((weapon?.equip?.speed ?? 5) / 1.6));
  }

  isRanged() {
    return !!this.weapon()?.equip?.ranged;
  }

  canEquip(item) {
    if (!item.equip) return { ok: false, reason: `You cannot wear ${item.name}.` };
    const check = meetsRequirements(this.stats, item);
    if (!check.ok) {
      return { ok: false, reason: `You need ${check.level} ${check.skill} to wear that.` };
    }
    return { ok: true };
  }

  // --- Prayer --------------------------------------------------------------

  prayerMultiplier(stat) {
    let multiplier = 1;
    for (const id of this.prayers) {
      const prayer = PRAYERS[id];
      if (prayer?.[stat]) multiplier *= prayer[stat];
    }
    return multiplier;
  }

  drainPrayer() {
    if (this.prayers.size === 0) return;
    let drain = 0;
    for (const id of this.prayers) drain += PRAYERS[id]?.drain ?? 0;
    const bonus = 1 + (this.bonuses().prayer ?? 0) / 60;
    this.prayerPoints -= drain / bonus;
    if (this.prayerPoints <= 0) {
      this.prayerPoints = 0;
      this.prayers.clear();
      this.send('message', { text: 'You have run out of prayer points.' });
    }
  }

  // --- Damage / death ------------------------------------------------------

  damage(amount, source = null) {
    const dealt = Math.max(0, Math.min(this.currentHits, Math.round(amount)));
    this.currentHits -= dealt;
    this.damageSplat = { amount: dealt, ticks: 2 };
    this.dirty.stats = true;
    if (source) {
      this.lastAttackedBy = source;
      this.inCombatFor = 16;
    }
    return dealt;
  }

  heal(amount) {
    this.currentHits = this.currentHits + amount;
    this.dirty.stats = true;
  }

  /** Reset for respawn; returns everything that should drop on the ground. */
  onDeath(keepCount = 3) {
    const droppable = [];
    for (let i = 0; i < this.inventory.length; i++) {
      const slot = this.inventory[i];
      if (slot) droppable.push({ ...slot });
      this.inventory[i] = null;
    }
    for (const slot of Object.keys(this.equipment)) {
      const worn = this.equipment[slot];
      if (worn) droppable.push({ ...worn });
      this.equipment[slot] = null;
    }
    // Highest-value items are kept, as in the classic death mechanic.
    droppable.sort((a, b) => getItem(b.id).value * b.count - getItem(a.id).value * a.count);
    const kept = droppable.splice(0, keepCount);
    for (const slot of kept) addItem(this.inventory, slot.id, slot.count);

    this.stats.hits.current = this.maxHits;
    for (const skill of SKILLS) if (skill !== 'hits') this.stats[skill].current = this.level(skill);
    this.boosts = {};
    this.prayers.clear();
    this.prayerPoints = this.level('prayer');
    this.path = [];
    this.action = null;
    this.target = null;
    this.x = RESPAWN_POINT.x;
    this.y = RESPAWN_POINT.y;
    this.dirty.stats = true;
    this.dirty.inventory = true;
    this.dirty.equipment = true;
    return droppable;
  }

  // --- Networking ----------------------------------------------------------

  send(op, payload = {}) {
    if (!this.socket || this.socket.readyState !== 1) return;
    this.socket.send(JSON.stringify({ op, ...payload }));
  }

  message(text) {
    this.send('message', { text });
  }

  /** Public state other players can see. */
  toSnapshot() {
    return {
      id: this.id,
      kind: 'player',
      name: this.display,
      x: this.x,
      y: this.y,
      dir: this.dir,
      hits: this.currentHits,
      maxHits: this.maxHits,
      combat: this.combatLevel,
      appearance: this.appearance,
      equipment: Object.fromEntries(
        Object.entries(this.equipment).map(([slot, worn]) => [slot, worn?.id ?? null]),
      ),
      chat: this.chat?.text ?? null,
      splat: this.damageSplat?.amount ?? null,
      animation: this.animation,
      running: this.running,
    };
  }

  toSave() {
    return {
      name: this.display,
      x: this.x,
      y: this.y,
      stats: this.stats,
      inventory: serialize(this.inventory),
      bank: serialize(this.bank),
      equipment: this.equipment,
      combatStyle: this.combatStyle,
      spell: this.spell,
      quests: this.quests,
      energy: this.energy,
      prayerPoints: this.prayerPoints,
    };
  }

  loadSave(save) {
    if (!save) return;
    this.x = Number.isFinite(save.x) ? save.x : this.x;
    this.y = Number.isFinite(save.y) ? save.y : this.y;
    if (save.stats) {
      for (const skill of SKILLS) {
        const stat = save.stats[skill];
        if (!stat) continue;
        this.stats[skill].xp = Math.max(0, Number(stat.xp) || 0);
        this.stats[skill].current = Number.isFinite(stat.current) ? stat.current : levelForXp(this.stats[skill].xp);
      }
      this.currentHits = Math.max(1, Math.min(this.maxHits, this.stats.hits.current));
    }
    this.inventory = deserialize(save.inventory, INVENTORY_SIZE);
    this.bank = deserialize(save.bank, BANK_SIZE);
    for (const slot of EQUIP_SLOTS) {
      const worn = save.equipment?.[slot];
      this.equipment[slot] = worn && worn.id ? { id: worn.id, count: worn.count ?? 1 } : null;
    }
    this.combatStyle = save.combatStyle ?? this.combatStyle;
    this.spell = save.spell ?? this.spell;
    this.quests = { ...this.quests, ...(save.quests ?? {}) };
    this.energy = Number.isFinite(save.energy) ? save.energy : RUN_ENERGY_MAX;
    this.prayerPoints = Number.isFinite(save.prayerPoints) ? save.prayerPoints : this.level('prayer');
  }
}

/** Kit handed to brand new characters. */
export function giveStarterKit(player) {
  const kit = [
    ['bronze_sword', 1],
    ['bronze_shield', 1],
    ['bronze_axe', 1],
    ['bronze_pickaxe', 1],
    ['tinderbox', 1],
    ['hammer', 1],
    ['small_net', 1],
    ['knife', 1],
    ['bread', 3],
    ['air_rune', 30],
    ['mind_rune', 30],
    ['coins', 50],
  ];
  for (const [id, count] of kit) addItem(player.inventory, id, count);
  player.dirty.inventory = true;
}
