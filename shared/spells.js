/**
 * Combat and utility spells. `runes` is a map of item id -> count consumed on cast.
 * Combat spells deal up to `max` damage; the accuracy roll lives in server/combat.js.
 */
export const SPELLS = {
  wind_strike: { name: 'Wind strike', level: 1, xp: 22, max: 2, element: 'air', runes: { air_rune: 1, mind_rune: 1 } },
  water_strike: { name: 'Water strike', level: 5, xp: 30, max: 4, element: 'water', runes: { water_rune: 1, air_rune: 1, mind_rune: 1 } },
  earth_strike: { name: 'Earth strike', level: 9, xp: 40, max: 6, element: 'earth', runes: { earth_rune: 2, air_rune: 1, mind_rune: 1 } },
  fire_strike: { name: 'Fire strike', level: 13, xp: 50, max: 8, element: 'fire', runes: { fire_rune: 3, air_rune: 2, mind_rune: 1 } },
  wind_bolt: { name: 'Wind bolt', level: 17, xp: 66, max: 9, element: 'air', runes: { air_rune: 2, chaos_rune: 1 } },
  water_bolt: { name: 'Water bolt', level: 23, xp: 82, max: 10, element: 'water', runes: { water_rune: 2, air_rune: 2, chaos_rune: 1 } },
  earth_bolt: { name: 'Earth bolt', level: 29, xp: 92, max: 11, element: 'earth', runes: { earth_rune: 3, air_rune: 2, chaos_rune: 1 } },
  fire_bolt: { name: 'Fire bolt', level: 35, xp: 108, max: 12, element: 'fire', runes: { fire_rune: 4, air_rune: 3, chaos_rune: 1 } },
  wind_blast: { name: 'Wind blast', level: 41, xp: 130, max: 13, element: 'air', runes: { air_rune: 3, death_rune: 1 } },
  fire_blast: { name: 'Fire blast', level: 59, xp: 170, max: 16, element: 'fire', runes: { fire_rune: 5, air_rune: 4, death_rune: 1 } },
  // Utility
  bones_to_bread: { name: 'Bones to bread', level: 15, xp: 65, utility: 'bones_to_food', runes: { earth_rune: 2, water_rune: 2, nature_rune: 1 } },
  low_alchemy: { name: 'Low alchemy', level: 21, xp: 62, utility: 'alchemy', rate: 0.4, runes: { fire_rune: 3, nature_rune: 1 } },
  high_alchemy: { name: 'High alchemy', level: 55, xp: 130, utility: 'alchemy', rate: 0.6, runes: { fire_rune: 5, nature_rune: 1 } },
};

/**
 * Prayers drain prayer points while active. `drain` is points per tick.
 * Multipliers apply to the matching combat stat.
 */
export const PRAYERS = {
  thick_skin: { name: 'Thick skin', level: 1, drain: 0.008, defense: 1.05 },
  burst_of_strength: { name: 'Burst of strength', level: 4, drain: 0.008, strength: 1.05 },
  clarity_of_thought: { name: 'Clarity of thought', level: 7, drain: 0.008, attack: 1.05 },
  rock_skin: { name: 'Rock skin', level: 10, drain: 0.016, defense: 1.1 },
  superhuman_strength: { name: 'Superhuman strength', level: 13, drain: 0.016, strength: 1.1 },
  improved_reflexes: { name: 'Improved reflexes', level: 16, drain: 0.016, attack: 1.1 },
  steel_skin: { name: 'Steel skin', level: 28, drain: 0.032, defense: 1.15 },
  ultimate_strength: { name: 'Ultimate strength', level: 31, drain: 0.032, strength: 1.15 },
  incredible_reflexes: { name: 'Incredible reflexes', level: 34, drain: 0.032, attack: 1.15 },
};

/** Prayers of the same category cancel each other out. */
export function conflictsWith(prayerId) {
  const prayer = PRAYERS[prayerId];
  if (!prayer) return [];
  const category = prayer.attack ? 'attack' : prayer.strength ? 'strength' : 'defense';
  return Object.entries(PRAYERS)
    .filter(([id, other]) => id !== prayerId && !!other[category])
    .map(([id]) => id);
}
