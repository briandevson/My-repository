import { MAX_LEVEL, SKILLS } from './constants.js';

// Classic experience curve: each level costs floor(l + 300 * 2^(l/7)) / 4 more points.
// XP_TABLE[n] is the total experience required to reach level n + 1.
export const XP_TABLE = (() => {
  const table = [0];
  let points = 0;
  for (let level = 1; level < MAX_LEVEL; level++) {
    points += Math.floor(level + 300 * Math.pow(2, level / 7));
    table.push(Math.floor(points / 4));
  }
  return table;
})();

export function levelForXp(xp) {
  let level = 1;
  for (let i = 1; i < XP_TABLE.length; i++) {
    if (xp >= XP_TABLE[i]) level = i + 1;
    else break;
  }
  return level;
}

export function xpForLevel(level) {
  return XP_TABLE[Math.max(0, Math.min(MAX_LEVEL, level) - 1)];
}

/** Fraction (0..1) of the way from the current level to the next. */
export function levelProgress(xp) {
  const level = levelForXp(xp);
  if (level >= MAX_LEVEL) return 1;
  const start = xpForLevel(level);
  const end = xpForLevel(level + 1);
  return (xp - start) / (end - start);
}

/**
 * Combat level, weighted the way the original did it: defensive base plus the
 * strongest of the three offensive branches.
 */
export function combatLevel(stats) {
  const lvl = (skill) => levelForXp(stats[skill]?.xp ?? 0);
  const base = (lvl('defense') + lvl('hits') + Math.floor(lvl('prayer') / 2)) / 4;
  const melee = (lvl('attack') + lvl('strength')) * 0.325;
  const ranged = lvl('ranged') * 1.5 * 0.325;
  const magic = lvl('magic') * 1.5 * 0.325;
  return Math.floor(base + Math.max(melee, ranged, magic));
}

/** Fresh stat block: everything at level 1 except hits, which starts at 10. */
export function newStats() {
  const stats = {};
  for (const skill of SKILLS) {
    const xp = skill === 'hits' ? xpForLevel(10) : 0;
    stats[skill] = { xp, current: levelForXp(xp) };
  }
  return stats;
}

export function totalLevel(stats) {
  return SKILLS.reduce((sum, skill) => sum + levelForXp(stats[skill].xp), 0);
}
