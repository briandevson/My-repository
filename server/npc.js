import { getNpc } from '../shared/npcs.js';

let nextId = 100000; // NPC ids live above player ids so snapshots never collide

export class Npc {
  constructor(type, x, y, radius = 4) {
    this.id = nextId++;
    this.kind = 'npc';
    this.type = type;
    this.def = getNpc(type);
    this.name = this.def.name;

    this.spawnX = x;
    this.spawnY = y;
    this.radius = radius;
    this.x = x;
    this.y = y;
    this.dir = 0;

    this.maxHits = this.def.stats?.hits ?? 1;
    this.hits = this.maxHits;
    this.path = [];
    this.target = null;
    this.attackCooldown = 0;
    this.dead = false;
    this.respawnTimer = 0;
    this.damageSplat = null;
    this.animation = null;
    /** Who has dealt the most damage - decides who gets the drop. */
    this.damageBy = new Map();
    this.retaliateUntil = 0;
  }

  get attackable() {
    return !!this.def.attackable;
  }

  level(skill) {
    return this.def.stats?.[skill] ?? 1;
  }

  attackSpeed() {
    return 3;
  }

  damage(amount, source = null) {
    const dealt = Math.max(0, Math.min(this.hits, Math.round(amount)));
    this.hits -= dealt;
    this.damageSplat = { amount: dealt, ticks: 2 };
    if (source?.kind === 'player' && dealt > 0) {
      this.damageBy.set(source.id, (this.damageBy.get(source.id) ?? 0) + dealt);
    }
    return dealt;
  }

  /** The player who has done the most damage, for drop ownership. */
  topDamager() {
    let bestId = null;
    let bestDamage = 0;
    for (const [id, damage] of this.damageBy) {
      if (damage > bestDamage) {
        bestDamage = damage;
        bestId = id;
      }
    }
    return bestId;
  }

  respawn() {
    this.x = this.spawnX;
    this.y = this.spawnY;
    this.hits = this.maxHits;
    this.dead = false;
    this.target = null;
    this.path = [];
    this.damageBy.clear();
    this.attackCooldown = 0;
  }

  toSnapshot() {
    return {
      id: this.id,
      kind: 'npc',
      type: this.type,
      name: this.name,
      x: this.x,
      y: this.y,
      dir: this.dir,
      hits: this.hits,
      maxHits: this.maxHits,
      level: this.def.level ?? 0,
      splat: this.damageSplat?.amount ?? null,
      animation: this.animation,
    };
  }
}

export function spawnFromWorld(world) {
  return world.spawns.map((spawn) => new Npc(spawn.npc, spawn.x, spawn.y, spawn.radius));
}
