import {
  TICK_MS,
  VIEW_RADIUS,
  RUN_ENERGY_MAX,
  RUN_DRAIN_PER_TICK,
  RUN_REGEN_PER_TICK,
  XP_PER_DAMAGE,
  HITS_XP_SHARE,
  INVENTORY_SIZE,
  EQUIP_SLOTS,
  SKILLS,
  TILE_TYPES,
} from '../shared/constants.js';
import { buildWorld, regionAt } from '../shared/worldgen.js';
import { getItem } from '../shared/items.js';
import { getObject } from '../shared/objects.js';
import { rollDrops, SHOPS } from '../shared/npcs.js';
import { SPELLS, PRAYERS, conflictsWith } from '../shared/spells.js';
import { spawnFromWorld } from './npc.js';
import { rollAttack, rollSpell, xpSkillsFor } from './combat.js';
import { findPath } from './pathfind.js';
import {
  addItem,
  canHold,
  compact,
  countOf,
  freeSlots,
  removeFromSlot,
  removeItem,
  removeItems,
  hasItems,
  serialize,
  swapSlots,
} from './container.js';
import * as skills from './skills.js';

const GROUND_ITEM_LIFETIME = 200; // ticks before a drop disappears
const OWNERSHIP_TICKS = 100; // ticks a drop stays private to its owner
const REGEN_INTERVAL = 100;
const FIRE_LIFETIME = 180;
const TEMP_INDEX_BASE = 1_000_000;

export class GameWorld {
  constructor(seed) {
    this.world = buildWorld(seed);
    this.players = new Map(); // id -> Player
    this.npcs = spawnFromWorld(this.world);
    this.npcsById = new Map(this.npcs.map((npc) => [npc.id, npc]));

    /** Static objects whose state differs from worldgen (depleted rocks, cut trees). */
    this.overrides = new Map(); // index -> { type, depleted, respawn }
    /** Temporary objects such as fires, keyed by their synthetic index. */
    this.temps = new Map();
    this.nextTempIndex = TEMP_INDEX_BASE;

    this.groundItems = [];
    this.nextGroundId = 1;

    this.objectsByTile = new Map();
    for (const object of this.world.objects) {
      this.objectsByTile.set(this.tileKey(object.x, object.y), object.index);
    }
    this.objectStates = this.world.objects.map((object) => ({
      index: object.index,
      type: object.type,
      x: object.x,
      y: object.y,
      depleted: false,
      respawn: 0,
    }));

    this.tickCount = 0;
    this.timer = null;
    this.onSave = null; // set by index.js so player state persists on logout
  }

  tileKey(x, y) {
    return y * this.world.size + x;
  }

  // --- Collision -----------------------------------------------------------

  /** Terrain + scenery collision. Entities are handled separately per mover. */
  isBlockedTile(x, y) {
    if (x < 0 || y < 0 || x >= this.world.size || y >= this.world.size) return true;
    const key = this.tileKey(x, y);
    if (this.world.tiles[key] === TILE_TYPES.WATER) return true;
    const index = this.objectsByTile.get(key);
    if (index !== undefined && getObject(this.objectStates[index].type).blocks) return true;
    for (const temp of this.temps.values()) {
      if (temp.x === x && temp.y === y && getObject(temp.type).blocks) return true;
    }
    return false;
  }

  blockedFor(entity) {
    return (x, y) => {
      if (this.isBlockedTile(x, y)) return true;
      // NPCs push through each other's tiles only when they must; players never
      // block each other, matching the original's shoulder-to-shoulder crowds.
      if (entity?.kind === 'npc') {
        for (const npc of this.npcs) {
          if (npc !== entity && !npc.dead && npc.x === x && npc.y === y) return true;
        }
      }
      return false;
    };
  }

  objectAt(index) {
    if (index >= TEMP_INDEX_BASE) return this.temps.get(index) ?? null;
    return this.objectStates[index] ?? null;
  }

  // --- Lifecycle -----------------------------------------------------------

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      try {
        this.tick();
      } catch (error) {
        console.error('[tick]', error);
      }
    }, TICK_MS);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  addPlayer(player) {
    this.players.set(player.id, player);
    player.send('welcome', {
      id: player.id,
      seed: this.world.seed,
      name: player.name,
      tick: this.tickCount,
    });
    this.sendStats(player);
    this.sendInventory(player);
    this.sendEquipment(player);
    player.message(`Welcome to Aetheria, ${player.name}.`);
    player.message('Click the ground to walk. Right-click things for their options.');
  }

  removePlayer(player) {
    this.players.delete(player.id);
    for (const npc of this.npcs) if (npc.target?.id === player.id) npc.target = null;
  }

  // --- Main tick -----------------------------------------------------------

  tick() {
    this.tickCount++;

    for (const player of this.players.values()) this.tickPlayer(player);
    for (const npc of this.npcs) this.tickNpc(npc);

    this.tickObjects();
    this.tickGroundItems();

    if (this.tickCount % REGEN_INTERVAL === 0) this.tickRegen();

    for (const player of this.players.values()) this.sendSnapshot(player);

    // Transient visuals last exactly one tick of visibility after being sent.
    for (const player of this.players.values()) {
      if (player.damageSplat && --player.damageSplat.ticks <= 0) player.damageSplat = null;
      if (player.chat && --player.chat.ticks <= 0) player.chat = null;
      player.animation = null;
      if (player.dirty.stats) this.sendStats(player);
      if (player.dirty.inventory) this.sendInventory(player);
      if (player.dirty.equipment) this.sendEquipment(player);
    }
    for (const npc of this.npcs) {
      if (npc.damageSplat && --npc.damageSplat.ticks <= 0) npc.damageSplat = null;
      npc.animation = null;
    }
  }

  tickPlayer(player) {
    if (player.dead) {
      if (--player.respawnTimer <= 0) {
        player.dead = false;
        player.message('You have died and reappear in Ashford.');
      }
      return;
    }

    if (player.attackCooldown > 0) player.attackCooldown--;
    if (player.actionCooldown > 0) player.actionCooldown--;
    if (player.inCombatFor > 0) player.inCombatFor--;
    player.drainPrayer();

    this.movePlayer(player);
    this.resolvePending(player);
    this.tickCombatFor(player);
    this.tickGatherFor(player);
  }

  movePlayer(player) {
    if (player.path.length === 0) {
      if (!player.running && player.energy < RUN_ENERGY_MAX) {
        player.energy = Math.min(RUN_ENERGY_MAX, player.energy + RUN_REGEN_PER_TICK * 2);
      }
      return;
    }
    const steps = player.running && player.energy > 0 ? 2 : 1;
    const blocked = this.blockedFor(player);
    for (let i = 0; i < steps && player.path.length > 0; i++) {
      const next = player.path[0];
      if (blocked(next.x, next.y)) {
        player.path = [];
        break;
      }
      player.dir = directionTo(player.x, player.y, next.x, next.y);
      player.x = next.x;
      player.y = next.y;
      player.path.shift();
      if (player.running) player.energy = Math.max(0, player.energy - RUN_DRAIN_PER_TICK);
    }
  }

  /** Execute a queued interaction once the player has walked into range. */
  resolvePending(player) {
    const pending = player.pending;
    if (!pending) return;
    const target = this.pendingTarget(pending);
    if (!target) {
      player.pending = null;
      return;
    }
    const range = pending.range ?? 1;
    if (chebyshev(player, target) > range) {
      if (player.path.length === 0) {
        // Target moved or is unreachable; try once more, then give up.
        const path = findPath(this.blockedFor(player), player.x, player.y, target.x, target.y, range, this.world.size);
        if (path.length === 0) {
          player.pending = null;
          player.message('You cannot reach that.');
        } else {
          player.path = path;
        }
      }
      return;
    }
    player.path = [];
    player.dir = directionTo(player.x, player.y, target.x, target.y);
    player.pending = null;
    pending.run(target);
  }

  pendingTarget(pending) {
    if (pending.kind === 'object') return this.objectAt(pending.index);
    if (pending.kind === 'npc') {
      const npc = this.npcsById.get(pending.id);
      return npc && !npc.dead ? npc : null;
    }
    if (pending.kind === 'player') return this.players.get(pending.id) ?? null;
    if (pending.kind === 'ground') return this.groundItems.find((item) => item.uid === pending.id) ?? null;
    return null;
  }

  // --- Combat --------------------------------------------------------------

  tickCombatFor(entity) {
    const target = entity.target;
    if (!target) return;
    const alive = target.kind === 'npc' ? !target.dead : this.players.has(target.id) && !target.dead;
    if (!alive) {
      entity.target = null;
      return;
    }
    const range = combatRange(entity);
    const dist = chebyshev(entity, target);
    if (dist > range) {
      if (entity.kind === 'player' && dist > VIEW_RADIUS) {
        entity.target = null;
        return;
      }
      if (entity.path.length === 0) {
        entity.path = findPath(this.blockedFor(entity), entity.x, entity.y, target.x, target.y, range, this.world.size);
        if (entity.path.length === 0 && dist > range) entity.target = null;
      }
      return;
    }
    entity.path = [];
    entity.dir = directionTo(entity.x, entity.y, target.x, target.y);
    if (entity.attackCooldown > 0) return;
    this.performAttack(entity, target);
  }

  performAttack(attacker, defender) {
    const mode = this.attackModeFor(attacker);
    if (!mode) return;
    attacker.attackCooldown = attacker.attackSpeed();

    let result;
    if (mode === 'magic') {
      const spellId = attacker.spell;
      const spell = SPELLS[spellId];
      if (!spell || spell.utility) {
        attacker.message?.('You cannot attack with that spell.');
        attacker.target = null;
        return;
      }
      if (!this.consumeRunes(attacker, spell)) {
        attacker.message?.('You do not have enough runes to cast that spell.');
        attacker.target = null;
        return;
      }
      result = rollSpell(attacker, defender, spellId);
      attacker.animation = { type: 'cast', element: spell.element };
      attacker.addXp?.('magic', spell.xp);
    } else if (mode === 'ranged') {
      const ammo = attacker.equipment?.ammo;
      if (!ammo || ammo.count <= 0) {
        attacker.message?.('You have run out of ammunition.');
        attacker.target = null;
        return;
      }
      ammo.count -= 1;
      if (ammo.count <= 0) attacker.equipment.ammo = null;
      attacker.dirty.equipment = true;
      result = rollAttack(attacker, defender, 'ranged');
      attacker.animation = { type: 'shoot' };
    } else {
      result = rollAttack(attacker, defender, 'melee');
      attacker.animation = { type: 'swing' };
    }

    const damage = result.hit ? defender.damage(result.damage, attacker) : 0;
    if (!result.hit) defender.damageSplat = { amount: 0, ticks: 2 };

    if (attacker.kind === 'player' && damage >= 0) {
      const xpSkills = xpSkillsFor(attacker, result.mode);
      if (result.mode !== 'magic' && xpSkills.length > 0) {
        const total = damage * XP_PER_DAMAGE;
        for (const skill of xpSkills) this.awardXp(attacker, skill, total / xpSkills.length);
      }
      if (damage > 0) this.awardXp(attacker, 'hits', damage * HITS_XP_SHARE);
      attacker.inCombatFor = 16;
    }

    if (defender.kind === 'npc') {
      if (!defender.target) defender.target = attacker;
      if (defender.hits <= 0) this.killNpc(defender, attacker);
    } else {
      defender.lastAttackedBy = attacker;
      if (defender.kind === 'player' && defender.currentHits <= 0) this.killPlayer(defender, attacker);
    }
  }

  attackModeFor(entity) {
    if (entity.kind !== 'player') return 'melee';
    if (entity.autocast) return 'magic';
    if (entity.isRanged()) return 'ranged';
    return 'melee';
  }

  consumeRunes(player, spell) {
    const supplied = player.weapon()?.equip?.suppliesRune;
    const needed = { ...spell.runes };
    if (supplied && needed[supplied]) delete needed[supplied];
    if (!hasItems(player.inventory, needed)) return false;
    removeItems(player.inventory, needed);
    player.dirty.inventory = true;
    return true;
  }

  awardXp(player, skill, amount) {
    const ups = player.addXp(skill, amount);
    for (const up of ups) {
      player.message(`You just advanced a ${up.skill} level! You are now level ${up.level}.`);
      player.send('levelup', { skill: up.skill, level: up.level });
    }
  }

  killNpc(npc, killer) {
    npc.dead = true;
    npc.respawnTimer = npc.def.respawn ?? 25;
    npc.target = null;
    npc.path = [];
    const ownerId = npc.topDamager() ?? (killer?.kind === 'player' ? killer.id : null);
    const drops = rollDrops(npc.def);

    // Quest hook: bandits carry the elder's locket once the quest is started.
    const owner = ownerId ? this.players.get(ownerId) : null;
    if (npc.type === 'bandit' && owner?.quests.lost_heirloom === 1 && Math.random() < 0.25) {
      drops.push({ id: 'heirloom', count: 1 });
    }
    for (const drop of drops) this.dropItem(drop.id, drop.count, npc.x, npc.y, ownerId);
    for (const player of this.players.values()) {
      if (player.target === npc) player.target = null;
    }
    if (owner) owner.message(`You defeat the ${npc.name.toLowerCase()}.`);
  }

  killPlayer(player, killer) {
    const drops = player.onDeath();
    for (const drop of drops) {
      this.dropItem(drop.id, drop.count, player.x, player.y, killer?.kind === 'player' ? killer.id : null);
    }
    player.dead = true;
    player.respawnTimer = 5;
    player.target = null;
    player.pending = null;
    player.action = null;
    player.send('die', {});
    player.message('Oh dear, you are dead!');
  }

  // --- Gathering -----------------------------------------------------------

  tickGatherFor(player) {
    const action = player.action;
    if (!action || action.type !== 'gather') return;
    const state = this.objectAt(action.objectIndex);
    if (!state || state.depleted) {
      player.action = null;
      return;
    }
    if (chebyshev(player, state) > 1) {
      player.action = null;
      return;
    }
    if (freeSlots(player.inventory) === 0) {
      player.message('Your inventory is full.');
      player.action = null;
      return;
    }
    player.animation = { type: action.option.tool === 'pickaxe' ? 'mine' : action.option.tool === 'axe' ? 'chop' : 'fish' };
    if (player.actionCooldown > 0) return;
    player.actionCooldown = 1;

    if (Math.random() > skills.gatherChance(player, action.option)) return;

    const option = action.option;
    if (option.consumes && countOf(player.inventory, option.consumes) < 1) {
      player.message(`You have run out of ${getItem(option.consumes).name.toLowerCase()}.`);
      player.action = null;
      return;
    }
    if (option.consumes) removeItem(player.inventory, option.consumes, 1);
    addItem(player.inventory, option.item, 1);
    player.dirty.inventory = true;
    player.message(`You get some ${getItem(option.item).name.toLowerCase()}.`);
    this.awardXp(player, option.skill, option.xp);

    if (option.depletes) {
      const def = getObject(state.type);
      this.depleteObject(state, def.kind === 'tree' ? 'stump' : 'depleted_rock', def.respawn);
      player.action = null;
    }
  }

  depleteObject(state, replacementType, respawnTicks) {
    const original = this.world.objects[state.index]?.type ?? state.type;
    state.depleted = true;
    state.type = replacementType;
    state.respawn = respawnTicks;
    this.overrides.set(state.index, { type: replacementType, depleted: true, original });
  }

  tickObjects() {
    for (const [index, override] of this.overrides) {
      const state = this.objectStates[index];
      if (!state) continue;
      if (state.respawn > 0 && --state.respawn <= 0) {
        state.depleted = false;
        state.type = override.original;
        this.overrides.delete(index);
      }
    }
    for (const [index, temp] of this.temps) {
      if (--temp.ticks <= 0) {
        this.temps.delete(index);
        if (temp.type === 'fire') this.dropItem('ashes', 1, temp.x, temp.y, null);
      }
    }
  }

  addTempObject(type, x, y, ticks) {
    const index = this.nextTempIndex++;
    const temp = { index, type, x, y, ticks, depleted: false };
    this.temps.set(index, temp);
    return temp;
  }

  // --- Ground items --------------------------------------------------------

  dropItem(id, count, x, y, ownerId = null) {
    const item = { uid: this.nextGroundId++, id, count, x, y, ownerId, ticks: GROUND_ITEM_LIFETIME };
    this.groundItems.push(item);
    return item;
  }

  tickGroundItems() {
    this.groundItems = this.groundItems.filter((item) => {
      item.ticks--;
      if (item.ticks === GROUND_ITEM_LIFETIME - OWNERSHIP_TICKS) item.ownerId = null;
      return item.ticks > 0;
    });
  }

  pickUp(player, groundItem) {
    if (groundItem.ownerId && groundItem.ownerId !== player.id) {
      player.message('That is not yours to take yet.');
      return;
    }
    const room = canHold(player.inventory, groundItem.id, groundItem.count);
    if (room <= 0) {
      player.message('Your inventory is full.');
      return;
    }
    addItem(player.inventory, groundItem.id, room);
    player.dirty.inventory = true;
    groundItem.count -= room;
    if (groundItem.count <= 0) {
      this.groundItems = this.groundItems.filter((item) => item !== groundItem);
    }
    player.message(`You pick up the ${getItem(groundItem.id).name.toLowerCase()}.`);
  }

  // --- Periodic upkeep -----------------------------------------------------

  tickRegen() {
    for (const player of this.players.values()) {
      if (player.dead) continue;
      if (player.currentHits < player.maxHits) {
        player.heal(1);
      }
      for (const skill of SKILLS) {
        const boost = player.boosts[skill];
        if (!boost) continue;
        boost.amount -= 1;
        if (boost.amount <= 0) delete player.boosts[skill];
      }
      player.dirty.stats = true;
    }
  }

  // --- NPC AI --------------------------------------------------------------

  tickNpc(npc) {
    if (npc.dead) {
      if (--npc.respawnTimer <= 0) npc.respawn();
      return;
    }
    if (npc.attackCooldown > 0) npc.attackCooldown--;

    if (!npc.target && npc.def.aggressive) this.seekTarget(npc);

    if (npc.target) {
      const target = npc.target;
      const gone = !this.players.has(target.id) || target.dead;
      const tooFar = chebyshev(npc, { x: npc.spawnX, y: npc.spawnY }) > npc.radius + 12;
      if (gone || tooFar) {
        npc.target = null;
        npc.path = findPath(this.blockedFor(npc), npc.x, npc.y, npc.spawnX, npc.spawnY, 0, this.world.size);
      } else {
        this.tickCombatFor(npc);
      }
    } else if (npc.def.wanderRadius > 0 && Math.random() < 0.08 && npc.path.length === 0) {
      const wx = npc.spawnX + Math.floor(Math.random() * (npc.radius * 2 + 1)) - npc.radius;
      const wy = npc.spawnY + Math.floor(Math.random() * (npc.radius * 2 + 1)) - npc.radius;
      npc.path = findPath(this.blockedFor(npc), npc.x, npc.y, wx, wy, 0, this.world.size);
    }

    // NPCs walk one tile per tick.
    if (npc.path.length > 0) {
      const next = npc.path[0];
      if (!this.blockedFor(npc)(next.x, next.y)) {
        npc.dir = directionTo(npc.x, npc.y, next.x, next.y);
        npc.x = next.x;
        npc.y = next.y;
      }
      npc.path.shift();
    }
  }

  seekTarget(npc) {
    for (const player of this.players.values()) {
      if (player.dead) continue;
      if (chebyshev(npc, player) > npc.def.aggroRadius) continue;
      // Aggression stops once you clearly outclass the monster, as it did classically.
      if (player.combatLevel > (npc.def.level ?? 1) * 2 && !player.inCombatFor) continue;
      // Single combat: one fight at a time, so a camp cannot dogpile a player.
      if (this.isEngaged(player, npc)) continue;
      npc.target = player;
      player.message?.(`The ${npc.name.toLowerCase()} attacks you!`);
      return;
    }
  }

  /**
   * Is this entity already locked in a fight with someone other than `except`?
   * Combat here is one-on-one: nobody may join a fight already in progress.
   */
  isEngaged(entity, except = null) {
    if (entity.kind === 'player') {
      const target = entity.target;
      if (target && target !== except && !target.dead) return true;
    }
    for (const npc of this.npcs) {
      if (npc === except || npc.dead) continue;
      if (npc.target === entity) return true;
    }
    for (const player of this.players.values()) {
      if (player === except || player.dead) continue;
      if (player.target === entity) return true;
    }
    return false;
  }

  // --- Snapshots -----------------------------------------------------------

  sendSnapshot(player) {
    const inView = (entity) => chebyshev(player, entity) <= VIEW_RADIUS;
    const players = [];
    for (const other of this.players.values()) {
      if (other.dead && other !== player) continue;
      if (other !== player && !inView(other)) continue;
      players.push(other.toSnapshot());
    }
    const npcs = [];
    for (const npc of this.npcs) {
      if (npc.dead || !inView(npc)) continue;
      npcs.push(npc.toSnapshot());
    }
    const objects = [];
    for (const [index, override] of this.overrides) {
      const state = this.objectStates[index];
      if (state && inView(state)) objects.push({ index, type: state.type, x: state.x, y: state.y });
    }
    for (const temp of this.temps.values()) {
      if (inView(temp)) objects.push({ index: temp.index, type: temp.type, x: temp.x, y: temp.y });
    }
    const ground = this.groundItems
      .filter((item) => inView(item) && (!item.ownerId || item.ownerId === player.id))
      .map((item) => ({ uid: item.uid, id: item.id, count: item.count, x: item.x, y: item.y }));

    player.send('snapshot', {
      tick: this.tickCount,
      self: {
        x: player.x,
        y: player.y,
        hits: player.currentHits,
        maxHits: player.maxHits,
        prayer: Math.round(player.prayerPoints * 10) / 10,
        maxPrayer: player.level('prayer'),
        energy: Math.round(player.energy),
        running: player.running,
        combatStyle: player.combatStyle,
        spell: player.spell,
        autocast: player.autocast,
        prayers: [...player.prayers],
        region: regionAt(player.x, player.y),
        dead: player.dead,
        target: player.target?.id ?? null,
      },
      players,
      npcs,
      objects,
      ground,
    });
  }

  sendStats(player) {
    player.dirty.stats = false;
    player.send('stats', {
      stats: Object.fromEntries(
        SKILLS.map((skill) => [
          skill,
          { xp: Math.floor(player.stats[skill].xp), level: player.level(skill), current: skill === 'hits' ? player.currentHits : player.effectiveLevel(skill) },
        ]),
      ),
      combat: player.combatLevel,
      quests: player.quests,
    });
  }

  sendInventory(player) {
    player.dirty.inventory = false;
    player.send('inventory', { items: serialize(player.inventory) });
  }

  sendEquipment(player) {
    player.dirty.equipment = false;
    player.send('equipment', {
      equipment: Object.fromEntries(
        EQUIP_SLOTS.map((slot) => [slot, player.equipment[slot] ? { ...player.equipment[slot] } : null]),
      ),
      bonuses: player.bonuses(),
    });
  }

  sendBank(player) {
    player.send('bankdata', { items: serialize(player.bank) });
  }

  openMenu(player, title, options, handler) {
    player.menu = { options, handler };
    player.send('menu', { title, options: options.map(({ label, level, enabled }) => ({ label, level, enabled })) });
  }

  // --- Client messages -----------------------------------------------------

  handleMessage(player, msg) {
    if (player.dead && msg.op !== 'chat') return;
    switch (msg.op) {
      case 'walk':
        return this.handleWalk(player, msg);
      case 'action':
        return this.handleAction(player, msg);
      case 'inv':
        return this.handleInventory(player, msg);
      case 'bank':
        return this.handleBank(player, msg);
      case 'shop':
        return this.handleShop(player, msg);
      case 'menu':
        return this.handleMenu(player, msg);
      case 'setting':
        return this.handleSetting(player, msg);
      case 'chat':
        return this.handleChat(player, msg);
      default:
        return undefined;
    }
  }

  handleWalk(player, { x, y }) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const tx = Math.max(0, Math.min(this.world.size - 1, Math.round(x)));
    const ty = Math.max(0, Math.min(this.world.size - 1, Math.round(y)));
    player.action = null;
    player.pending = null;
    player.target = null;
    player.path = findPath(this.blockedFor(player), player.x, player.y, tx, ty, 0, this.world.size);
  }

  /** Queue an interaction: walk to the target, then run the handler. */
  queue(player, kind, id, range, run) {
    player.action = null;
    player.target = null;
    player.pending = { kind, id, index: id, range, run };
    const target = this.pendingTarget(player.pending);
    if (!target) {
      player.pending = null;
      return;
    }
    if (chebyshev(player, target) <= range) {
      player.path = [];
      player.pending = null;
      player.dir = directionTo(player.x, player.y, target.x, target.y);
      run(target);
      return;
    }
    player.path = findPath(this.blockedFor(player), player.x, player.y, target.x, target.y, range, this.world.size);
  }

  handleAction(player, msg) {
    const { kind } = msg;
    if (kind === 'object') return this.handleObjectAction(player, msg);
    if (kind === 'npc') return this.handleNpcAction(player, msg);
    if (kind === 'ground') {
      const item = this.groundItems.find((entry) => entry.uid === msg.id);
      if (!item) return;
      return this.queue(player, 'ground', msg.id, 0, (target) => this.pickUp(player, target));
    }
    if (kind === 'player') {
      const other = this.players.get(msg.id);
      if (!other || other === player) return;
      if (msg.option === 'attack') {
        return this.queue(player, 'player', msg.id, combatRange(player), (target) => {
          player.target = target;
        });
      }
    }
    return undefined;
  }

  handleObjectAction(player, msg) {
    const state = this.objectAt(msg.index);
    if (!state) return;
    const def = getObject(state.type);
    if (msg.option === 'examine') {
      player.message(def.examine);
      return;
    }
    this.queue(player, 'object', msg.index, 1, (target) => this.useObject(player, target, msg.option));
  }

  useObject(player, state, option) {
    const def = getObject(state.type);
    switch (def.kind) {
      case 'tree':
      case 'rock': {
        const result = skills.beginGather(player, state);
        if (!result.ok) {
          player.message(result.reason);
          return;
        }
        player.action = result.action;
        player.message(def.kind === 'tree' ? 'You swing your axe at the tree.' : 'You swing your pickaxe at the rock.');
        return;
      }
      case 'fishing': {
        const result = skills.beginGather(player, state);
        if (!result.ok) {
          player.message(result.reason);
          return;
        }
        player.action = result.action;
        player.message('You cast out your line.');
        return;
      }
      case 'bank':
        this.sendBank(player);
        player.send('openbank', {});
        player.message('You open your bank account.');
        return;
      case 'furnace':
        this.openMenu(player, 'Smelt a bar', skills.smeltOptions(player), (choice) => {
          const result = skills.smelt(player, choice.id);
          player.dirty.inventory = true;
          player.message(result.ok ? result.message : result.reason);
        });
        return;
      case 'anvil': {
        const bars = ['bronze_bar', 'iron_bar', 'steel_bar', 'mithril_bar', 'adamantite_bar'].filter(
          (bar) => countOf(player.inventory, bar) > 0,
        );
        if (bars.length === 0) {
          player.message('You need metal bars to work on the anvil.');
          return;
        }
        const bar = bars[bars.length - 1];
        this.openMenu(player, `Smith ${getItem(bar).name.toLowerCase()}`, skills.smithOptions(player, bar), (choice) => {
          const result = skills.smith(player, choice.id);
          player.dirty.inventory = true;
          player.message(result.ok ? result.message : result.reason);
        });
        return;
      }
      case 'range':
      case 'fire': {
        const cookable = player.inventory
          .map((slot, index) => ({ slot, index }))
          .filter(({ slot }) => slot && getItem(slot.id).cookable);
        if (cookable.length === 0) {
          player.message('You have nothing to cook.');
          return;
        }
        this.openMenu(
          player,
          'Cook',
          cookable.map(({ slot, index }) => ({
            id: index,
            label: getItem(slot.id).name,
            level: getItem(slot.id).cookable.level,
            enabled: player.level('cooking') >= getItem(slot.id).cookable.level,
          })),
          (choice) => {
            const result = skills.cook(player, choice.id, def.kind === 'range');
            player.dirty.inventory = true;
            player.message(result.ok ? result.message : result.reason);
          },
        );
        return;
      }
      case 'altar':
        player.prayerPoints = player.level('prayer');
        player.message('You feel a divine presence. Your prayer points are restored.');
        return;
      case 'stall': {
        const result = skills.stealFromStall(player, state);
        player.dirty.inventory = true;
        player.message(result.ok ? result.message : result.reason);
        if (result.deplete) this.depleteObject(state, 'stall', getObject('stall').respawn);
        return;
      }
      case 'agility': {
        const result = skills.useObstacle(player, state);
        player.message(result.ok ? result.message : result.reason);
        if (result.ok && result.move && !this.isBlockedTile(result.move.x, result.move.y)) {
          player.x = result.move.x;
          player.y = result.move.y;
        }
        return;
      }
      case 'door':
        player.message('The door swings open.');
        return;
      default:
        player.message(def.examine);
    }
  }

  handleNpcAction(player, msg) {
    const npc = this.npcsById.get(msg.id);
    if (!npc || npc.dead) return;
    if (msg.option === 'examine') {
      player.message(npc.def.examine);
      return;
    }
    if (msg.option === 'attack') {
      if (!npc.attackable) {
        player.message('You cannot attack them.');
        return;
      }
      if (this.isEngaged(npc, player)) {
        player.message('Someone else is fighting that.');
        return;
      }
      this.queue(player, 'npc', msg.id, combatRange(player), (target) => {
        if (this.isEngaged(target, player)) {
          player.message('Someone else is fighting that.');
          return;
        }
        player.target = target;
      });
      return;
    }
    if (msg.option === 'pickpocket') {
      this.queue(player, 'npc', msg.id, 1, (target) => {
        const result = skills.pickpocket(player, target);
        player.dirty.inventory = true;
        player.message(result.ok ? result.message : result.reason);
        if (result.caught) {
          target.target = player;
          player.damage(2, target);
        }
      });
      return;
    }
    // Default: talk to them.
    this.queue(player, 'npc', msg.id, 1, (target) => this.talkTo(player, target));
  }

  talkTo(player, npc) {
    const def = npc.def;
    if (def.role === 'bank') {
      this.sendBank(player);
      player.send('openbank', {});
      return;
    }
    if (def.role === 'shop') {
      this.openShop(player, def.shop);
      return;
    }
    const lines = def.dialogue ?? ['They have nothing to say.'];
    if (def.role === 'quest') {
      this.advanceQuest(player, npc, lines);
      return;
    }
    player.send('dialogue', { name: npc.name, lines });
  }

  advanceQuest(player, npc, lines) {
    const stage = player.quests.lost_heirloom ?? 0;
    if (stage === 0) {
      player.quests.lost_heirloom = 1;
      player.dirty.stats = true;
      player.send('dialogue', { name: npc.name, lines });
      player.message('Quest started: The Lost Heirloom.');
      return;
    }
    if (stage === 1 && countOf(player.inventory, 'heirloom') > 0) {
      removeItem(player.inventory, 'heirloom', 1);
      addItem(player.inventory, 'coins', 500);
      player.quests.lost_heirloom = 2;
      player.dirty.inventory = true;
      this.awardXp(player, 'attack', 500);
      this.awardXp(player, 'defense', 500);
      player.send('dialogue', { name: npc.name, lines: ['My locket! Thank you, traveller. Take this reward.'] });
      player.message('Quest complete: The Lost Heirloom.');
      return;
    }
    if (stage === 1) {
      player.send('dialogue', { name: npc.name, lines: ['The bandits east of the quarry took my silver locket. Please find it.'] });
      return;
    }
    player.send('dialogue', { name: npc.name, lines: ['Thank you again for returning my locket.'] });
  }

  openShop(player, shopId) {
    const shop = SHOPS[shopId];
    if (!shop) return;
    player.shop = shopId;
    player.send('openshop', {
      name: shop.name,
      id: shopId,
      stock: shop.stock.map(([id, count]) => ({ id, count, price: Math.ceil(getItem(id).value * shop.buyMultiplier) })),
    });
  }

  handleShop(player, msg) {
    const shop = SHOPS[player.shop];
    if (!shop) return;
    if (msg.act === 'buy') {
      const entry = shop.stock.find(([id]) => id === msg.id);
      if (!entry) return;
      const price = Math.ceil(getItem(msg.id).value * shop.buyMultiplier);
      if (countOf(player.inventory, 'coins') < price) {
        player.message('You cannot afford that.');
        return;
      }
      if (canHold(player.inventory, msg.id, 1) <= 0) {
        player.message('Your inventory is full.');
        return;
      }
      removeItem(player.inventory, 'coins', price);
      addItem(player.inventory, msg.id, 1);
      player.dirty.inventory = true;
      player.message(`You buy a ${getItem(msg.id).name.toLowerCase()} for ${price} coins.`);
      return;
    }
    if (msg.act === 'sell') {
      const slot = player.inventory[msg.slot];
      if (!slot) return;
      const item = getItem(slot.id);
      if (item.tags?.includes('quest')) {
        player.message('You should hold on to that.');
        return;
      }
      const price = Math.max(1, Math.floor(item.value * shop.sellMultiplier));
      removeFromSlot(player.inventory, msg.slot, 1);
      addItem(player.inventory, 'coins', price);
      player.dirty.inventory = true;
      player.message(`You sell the ${item.name.toLowerCase()} for ${price} coins.`);
    }
  }

  handleMenu(player, msg) {
    const menu = player.menu;
    if (!menu) return;
    const option = menu.options[msg.choice];
    player.menu = null;
    if (!option) return;
    if (option.enabled === false) {
      player.message('You cannot do that yet.');
      return;
    }
    menu.handler(option);
  }

  handleInventory(player, msg) {
    const { act } = msg;
    if (act === 'swap') {
      swapSlots(player.inventory, msg.slot, msg.to);
      player.dirty.inventory = true;
      return;
    }
    if (act === 'unequip') {
      const worn = player.equipment[msg.equipSlot];
      if (!worn) return;
      if (canHold(player.inventory, worn.id, worn.count) < worn.count) {
        player.message('Your inventory is full.');
        return;
      }
      player.equipment[msg.equipSlot] = null;
      addItem(player.inventory, worn.id, worn.count);
      player.dirty.inventory = true;
      player.dirty.equipment = true;
      player.message(`You remove the ${getItem(worn.id).name.toLowerCase()}.`);
      return;
    }
    const slot = player.inventory[msg.slot];
    if (!slot) return;
    const item = getItem(slot.id);

    switch (act) {
      case 'equip': {
        const check = player.canEquip(item);
        if (!check.ok) {
          player.message(check.reason);
          return;
        }
        const targetSlot = item.equip.slot;
        const removed = removeFromSlot(player.inventory, msg.slot, item.stackable ? slot.count : 1);
        const previous = player.equipment[targetSlot];
        if (previous) addItem(player.inventory, previous.id, previous.count);
        if (item.equip.twoHanded && player.equipment.shield) {
          const shield = player.equipment.shield;
          player.equipment.shield = null;
          addItem(player.inventory, shield.id, shield.count);
        }
        if (targetSlot === 'shield' && player.weapon()?.equip?.twoHanded) {
          const weapon = player.equipment.weapon;
          player.equipment.weapon = null;
          addItem(player.inventory, weapon.id, weapon.count);
        }
        player.equipment[targetSlot] = { id: removed.id, count: removed.count };
        player.dirty.inventory = true;
        player.dirty.equipment = true;
        player.message(`You equip the ${item.name.toLowerCase()}.`);
        return;
      }
      case 'drop': {
        const dropped = removeFromSlot(player.inventory, msg.slot, slot.count);
        this.dropItem(dropped.id, dropped.count, player.x, player.y, player.id);
        player.dirty.inventory = true;
        player.message(`You drop the ${item.name.toLowerCase()}.`);
        return;
      }
      case 'eat': {
        const result = item.drinkable ? skills.drink(player, msg.slot) : skills.eat(player, msg.slot);
        player.dirty.inventory = true;
        player.message(result.ok ? result.message : result.reason);
        return;
      }
      case 'clean': {
        const result = skills.cleanHerb(player, msg.slot);
        player.dirty.inventory = true;
        player.message(result.ok ? result.message : result.reason);
        return;
      }
      case 'bury': {
        const result = skills.buryBones(player, msg.slot);
        player.dirty.inventory = true;
        player.message(result.ok ? result.message : result.reason);
        return;
      }
      case 'examine':
        player.message(item.examine);
        return;
      case 'use':
        return this.handleUse(player, msg);
      default:
        return undefined;
    }
  }

  /** "Use X on Y" - the verb that drives most production skills. */
  handleUse(player, msg) {
    const slot = player.inventory[msg.slot];
    if (!slot) return;
    const item = getItem(slot.id);

    if (msg.targetKind === 'item') {
      const other = player.inventory[msg.to];
      if (!other) return;
      return this.useItemOnItem(player, msg.slot, msg.to, item, getItem(other.id));
    }
    if (msg.targetKind === 'object') {
      const state = this.objectAt(msg.index);
      if (!state) return;
      return this.queue(player, 'object', msg.index, 1, (target) => {
        const def = getObject(target.type);
        if ((def.kind === 'fire' || def.kind === 'range') && item.cookable) {
          const result = skills.cook(player, msg.slot, def.kind === 'range');
          player.dirty.inventory = true;
          player.message(result.ok ? result.message : result.reason);
          return;
        }
        if (def.kind === 'furnace' || def.kind === 'anvil') {
          this.useObject(player, target, 'use');
          return;
        }
        player.message('Nothing interesting happens.');
      });
    }
    return undefined;
  }

  useItemOnItem(player, slotA, slotB, itemA, itemB) {
    const pair = (predicate) => (predicate(itemA, itemB) ? [itemA, itemB, slotA, slotB] : predicate(itemB, itemA) ? [itemB, itemA, slotB, slotA] : null);

    // Tinderbox + logs -> fire
    let match = pair((a, b) => a.tool?.type === 'tinderbox' && !!b.firemaking);
    if (match) {
      const [, logs, , logSlot] = match;
      const result = skills.lightFire(player, logSlot);
      player.dirty.inventory = true;
      player.message(result.ok ? result.message : result.reason);
      if (result.lit) {
        if (!this.isBlockedTile(player.x, player.y)) this.addTempObject('fire', player.x, player.y, FIRE_LIFETIME);
        // Step off the fire tile so the player is not standing inside it.
        const escape = [[1, 0], [-1, 0], [0, 1], [0, -1]].find(([dx, dy]) => !this.isBlockedTile(player.x + dx, player.y + dy));
        if (escape) {
          player.x += escape[0];
          player.y += escape[1];
        }
      }
      void logs;
      return;
    }

    // Knife + logs -> fletching menu
    match = pair((a, b) => a.tool?.type === 'knife' && !!b.firemaking);
    if (match) {
      const [, logs] = match;
      const options = skills.fletchOptions(player, logs.id);
      if (options.length === 0) {
        player.message('You cannot fletch those.');
        return;
      }
      this.openMenu(player, 'Fletch', options, (choice) => {
        const result = skills.fletch(player, choice.id, logs.id);
        player.dirty.inventory = true;
        player.message(result.ok ? result.message : result.reason);
      });
      return;
    }

    // Knife + cowhide -> leather
    match = pair((a, b) => a.tool?.type === 'knife' && b.id === 'cowhide');
    if (match) {
      removeItem(player.inventory, 'cowhide', 1);
      addItem(player.inventory, 'leather', 1);
      player.dirty.inventory = true;
      this.awardXp(player, 'crafting', 2);
      player.message('You cure the hide into leather.');
      return;
    }

    // Needle + leather (or gold bar alone) -> crafting menu
    match = pair((a, b) => a.tool?.type === 'needle' && b.id === 'leather');
    if (match) {
      this.openMenu(player, 'Craft', skills.craftOptions(player), (choice) => {
        const result = skills.craft(player, choice.id);
        player.dirty.inventory = true;
        player.message(result.ok ? result.message : result.reason);
      });
      return;
    }

    // Herblore: vial of water + herb, or unfinished potion + secondary
    match = pair((a, b) => a.id === 'vial_of_water' && b.id === 'guam_leaf');
    if (match) {
      this.openMenu(player, 'Mix a potion', skills.HERBLORE.map((recipe) => ({
        id: recipe.id,
        label: getItem(recipe.id).name,
        level: recipe.level,
        enabled: player.level('herblore') >= recipe.level && hasItems(player.inventory, recipe.inputs),
      })), (choice) => {
        const result = skills.mixPotion(player, choice.id);
        player.dirty.inventory = true;
        player.message(result.ok ? result.message : result.reason);
      });
      return;
    }

    // Feather + arrow shaft -> headless arrows; arrowtips + headless -> arrows
    match = pair((a, b) => a.id === 'feather' && b.id === 'arrow_shaft');
    if (match) {
      const count = Math.min(countOf(player.inventory, 'feather'), countOf(player.inventory, 'arrow_shaft'), 15);
      removeItem(player.inventory, 'feather', count);
      removeItem(player.inventory, 'arrow_shaft', count);
      addItem(player.inventory, 'headless_arrow', count);
      player.dirty.inventory = true;
      this.awardXp(player, 'fletching', count);
      player.message(`You attach feathers to ${count} arrow shafts.`);
      return;
    }
    match = pair((a, b) => a.id.endsWith('_arrowtips') && b.id === 'headless_arrow');
    if (match) {
      const [tips] = match;
      const tier = tips.id.replace('_arrowtips', '');
      const count = Math.min(countOf(player.inventory, tips.id), countOf(player.inventory, 'headless_arrow'), 15);
      removeItem(player.inventory, tips.id, count);
      removeItem(player.inventory, 'headless_arrow', count);
      addItem(player.inventory, `${tier}_arrows`, count);
      player.dirty.inventory = true;
      this.awardXp(player, 'fletching', count * 1.5);
      player.message(`You make ${count} ${tier} arrows.`);
      return;
    }

    player.message('Nothing interesting happens.');
  }

  handleBank(player, msg) {
    switch (msg.act) {
      case 'deposit': {
        const slot = player.inventory[msg.slot];
        if (!slot) return;
        const count = Math.min(slot.count, msg.count ?? 1);
        const moved = addItem(player.bank, slot.id, count, true);
        if (moved <= 0) {
          player.message('Your bank is full.');
          return;
        }
        removeFromSlot(player.inventory, msg.slot, moved);
        break;
      }
      case 'depositAll': {
        for (let i = 0; i < INVENTORY_SIZE; i++) {
          const slot = player.inventory[i];
          if (!slot) continue;
          const moved = addItem(player.bank, slot.id, slot.count, true);
          if (moved > 0) removeFromSlot(player.inventory, i, moved);
        }
        break;
      }
      case 'withdraw': {
        const slot = player.bank[msg.slot];
        if (!slot) return;
        const wanted = Math.min(slot.count, msg.count ?? 1);
        const room = canHold(player.inventory, slot.id, wanted);
        if (room <= 0) {
          player.message('Your inventory is full.');
          return;
        }
        addItem(player.inventory, slot.id, room);
        slot.count -= room;
        if (slot.count <= 0) player.bank[msg.slot] = null;
        break;
      }
      default:
        return;
    }
    compact(player.bank);
    player.dirty.inventory = true;
    this.sendBank(player);
  }

  handleSetting(player, { key, value }) {
    switch (key) {
      case 'style':
        if (['controlled', 'aggressive', 'accurate', 'defensive'].includes(value)) player.combatStyle = value;
        return;
      case 'run':
        player.running = !!value;
        return;
      case 'spell':
        if (SPELLS[value]) player.spell = value;
        return;
      case 'autocast':
        player.autocast = !!value;
        return;
      case 'cast': {
        // One-off utility cast from the spellbook.
        const spell = SPELLS[value];
        if (!spell?.utility) return;
        if (player.level('magic') < spell.level) {
          player.message(`You need magic level ${spell.level} to cast that.`);
          return;
        }
        if (!this.consumeRunes(player, spell)) {
          player.message('You do not have enough runes to cast that spell.');
          return;
        }
        if (spell.utility === 'bones_to_food') {
          const bones = countOf(player.inventory, 'bones');
          removeItem(player.inventory, 'bones', bones);
          addItem(player.inventory, 'bread', bones);
          player.message(`You transform ${bones} bones into bread.`);
        } else if (spell.utility === 'alchemy') {
          const target = player.inventory.findIndex((slot) => slot && slot.id !== 'coins');
          if (target < 0) {
            player.message('You have nothing to transmute.');
            return;
          }
          const slot = player.inventory[target];
          const value = Math.max(1, Math.floor(getItem(slot.id).value * spell.rate));
          removeFromSlot(player.inventory, target, 1);
          addItem(player.inventory, 'coins', value);
          player.message(`You transmute the item into ${value} coins.`);
        }
        this.awardXp(player, 'magic', spell.xp);
        player.dirty.inventory = true;
        return;
      }
      case 'prayer': {
        const prayer = PRAYERS[value];
        if (!prayer) return;
        if (player.prayers.has(value)) {
          player.prayers.delete(value);
          return;
        }
        if (player.level('prayer') < prayer.level) {
          player.message(`You need prayer level ${prayer.level} to use that.`);
          return;
        }
        if (player.prayerPoints <= 0) {
          player.message('You have no prayer points left.');
          return;
        }
        for (const other of conflictsWith(value)) player.prayers.delete(other);
        player.prayers.add(value);
        return;
      }
      default:
        return;
    }
  }

  handleChat(player, { text }) {
    const clean = String(text ?? '').slice(0, 90).replace(/[<>]/g, '');
    if (!clean.trim()) return;
    player.chat = { text: clean, ticks: 8 };
    for (const other of this.players.values()) {
      if (chebyshev(player, other) <= VIEW_RADIUS) other.send('message', { text: `${player.name}: ${clean}`, chat: true });
    }
  }
}

// --- helpers ---------------------------------------------------------------

function chebyshev(a, b) {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

function directionTo(fromX, fromY, toX, toY) {
  return Math.atan2(toX - fromX, toY - fromY);
}

function combatRange(entity) {
  if (entity.kind !== 'player') return entity.def.breath ? 5 : 1;
  if (entity.autocast) return 6;
  if (entity.isRanged()) return 7;
  return 1;
}
