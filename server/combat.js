import { COMBAT_STYLES } from '../shared/constants.js';
import { SPELLS } from '../shared/spells.js';

/**
 * Combat maths.
 *
 * Both sides roll: the attacker rolls accuracy against the defender's armour,
 * and on a hit the damage is uniform over [0, maxHit]. A zero is a legal roll,
 * which is why "hitting a 0" is a thing.
 */

function isPlayer(entity) {
  return entity.kind === 'player';
}

function bonusesOf(entity) {
  return isPlayer(entity) ? entity.bonuses() : { aim: 0, power: 0, armour: 0, ranged: 0, magic: 0, ...entity.def.bonuses };
}

function styleBonus(entity, stat) {
  if (!isPlayer(entity)) return 0;
  return COMBAT_STYLES[entity.combatStyle]?.[stat] ?? 0;
}

function levelOf(entity, skill) {
  if (isPlayer(entity)) {
    return entity.effectiveLevel(skill) * entity.prayerMultiplier(skill);
  }
  return entity.level(skill);
}

function effectiveAttack(entity, mode) {
  const skill = mode === 'ranged' ? 'ranged' : mode === 'magic' ? 'magic' : 'attack';
  return Math.floor(levelOf(entity, skill) + (mode === 'melee' ? styleBonus(entity, 'attack') : 0)) + 8;
}

function effectiveDefense(entity) {
  return Math.floor(levelOf(entity, 'defense') + styleBonus(entity, 'defense')) + 8;
}

export function hitChance(attacker, defender, mode = 'melee') {
  const aim = bonusesOf(attacker);
  const armour = bonusesOf(defender);
  const attackBonus = mode === 'ranged' ? aim.ranged : mode === 'magic' ? aim.magic : aim.aim;
  const attackRoll = effectiveAttack(attacker, mode) * (attackBonus + 64);
  const defenseRoll = effectiveDefense(defender) * (armour.armour + 64);
  if (attackRoll > defenseRoll) return 1 - (defenseRoll + 2) / (2 * (attackRoll + 1));
  return attackRoll / (2 * (defenseRoll + 1));
}

export function maxHit(attacker, mode = 'melee') {
  const bonuses = bonusesOf(attacker);
  if (mode === 'ranged') {
    const strength = Math.floor(levelOf(attacker, 'ranged'));
    return Math.floor(0.5 + ((strength + 8) * (bonuses.ranged + 64)) / 640);
  }
  const strength = Math.floor(levelOf(attacker, 'strength') + styleBonus(attacker, 'strength'));
  return Math.floor(0.5 + ((strength + 8) * (bonuses.power + 64)) / 640);
}

/**
 * Roll one attack.
 * @returns {{hit:boolean, damage:number, max:number, mode:string}}
 */
export function rollAttack(attacker, defender, mode = 'melee', random = Math.random) {
  const chance = hitChance(attacker, defender, mode);
  const max = maxHit(attacker, mode);
  if (random() > chance) return { hit: false, damage: 0, max, mode };
  return { hit: true, damage: Math.floor(random() * (max + 1)), max, mode };
}

/** Magic uses the spell's fixed maximum instead of a strength roll. */
export function rollSpell(attacker, defender, spellId, random = Math.random) {
  const spell = SPELLS[spellId];
  if (!spell || spell.utility) return { hit: false, damage: 0, max: 0, mode: 'magic' };
  const chance = hitChance(attacker, defender, 'magic');
  if (random() > chance) return { hit: false, damage: 0, max: spell.max, mode: 'magic', spell: spellId };
  return { hit: true, damage: Math.floor(random() * (spell.max + 1)), max: spell.max, mode: 'magic', spell: spellId };
}

/** Which skills receive experience for a melee hit under the current style. */
export function xpSkillsFor(attacker, mode) {
  if (mode === 'ranged') return ['ranged'];
  if (mode === 'magic') return ['magic'];
  if (!isPlayer(attacker)) return [];
  return COMBAT_STYLES[attacker.combatStyle]?.xp ?? ['attack'];
}

/** Chebyshev distance in tiles - the metric the movement grid uses. */
export function distance(a, b) {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

export function attackRange(attacker) {
  if (!isPlayer(attacker)) return attacker.def.breath ? 6 : 1;
  if (attacker.isRanged()) return 7;
  if (attacker.autocast) return 6;
  return 1;
}
