import { WORLD_SIZE, WORLD_SEED, TILE_TYPES, WATER_LEVEL } from './constants.js';
import { OBJECTS } from './objects.js';

/**
 * Deterministic world generation.
 *
 * The client and the server both call `buildWorld()` with the same seed, so the
 * terrain the player sees is exactly the terrain the server collides against.
 * Nothing here may depend on Math.random or on wall-clock time.
 */

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function random() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function smoothstep(t) {
  return t * t * (3 - 2 * t);
}

function makeNoise(rng, size, cell) {
  const w = Math.ceil(size / cell) + 2;
  const grid = new Float32Array(w * w);
  for (let i = 0; i < grid.length; i++) grid[i] = rng();
  return (x, y) => {
    const gx = x / cell;
    const gy = y / cell;
    const x0 = Math.floor(gx);
    const y0 = Math.floor(gy);
    const fx = smoothstep(gx - x0);
    const fy = smoothstep(gy - y0);
    const at = (ix, iy) => grid[Math.min(w - 1, Math.max(0, iy)) * w + Math.min(w - 1, Math.max(0, ix))];
    const top = at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx;
    const bottom = at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx;
    return top * (1 - fy) + bottom * fy;
  };
}

export const REGIONS = {
  village: { name: 'Ashford', x0: 66, y0: 84, x1: 94, y1: 108 },
  quarry: { name: 'Coldiron Quarry', x0: 58, y0: 34, x1: 102, y1: 66 },
  forest: { name: 'Whisperwood', x0: 18, y0: 68, x1: 58, y1: 124 },
  lake: { name: 'Lake Mere', x0: 106, y0: 72, x1: 152, y1: 124 },
  barrows: { name: 'Old Barrows', x0: 58, y0: 118, x1: 98, y1: 150 },
  lair: { name: "Wyrm's Hollow", x0: 112, y0: 128, x1: 152, y1: 156 },
  pasture: { name: 'Ashford Pasture', x0: 96, y0: 90, x1: 118, y1: 114 },
  goblins: { name: 'Goblin Camp', x0: 40, y0: 36, x1: 60, y1: 60 },
  bandits: { name: 'Bandit Camp', x0: 104, y0: 40, x1: 124, y1: 62 },
  course: { name: 'Training Course', x0: 92, y0: 70, x1: 106, y1: 84 },
};

function inRegion(region, x, y) {
  return x >= region.x0 && x <= region.x1 && y >= region.y0 && y <= region.y1;
}

export function regionAt(x, y) {
  for (const region of Object.values(REGIONS)) {
    if (inRegion(region, x, y)) return region.name;
  }
  return 'Wilds';
}

/**
 * @returns {{
 *   size: number,
 *   heights: Float32Array,
 *   tiles: Uint8Array,
 *   blocked: Uint8Array,
 *   objects: Array<{index:number,type:string,x:number,y:number,rot:number}>,
 *   spawns: Array<{npc:string,x:number,y:number,radius:number}>,
 * }}
 */
/**
 * Generated worlds are cached per seed. The result is treated as immutable by
 * every consumer (the server keeps mutable object state separately), so the
 * client and an in-process server can safely share one instance.
 */
const worldCache = new Map();

export function buildWorld(seed = WORLD_SEED) {
  const cached = worldCache.get(seed);
  if (cached) return cached;
  const world = generateWorld(seed);
  worldCache.set(seed, world);
  return world;
}

function generateWorld(seed) {
  const size = WORLD_SIZE;
  const rng = mulberry32(seed);
  const base = makeNoise(rng, size, 24);
  const detail = makeNoise(rng, size, 9);
  const fine = makeNoise(rng, size, 4);
  const lakeNoise = makeNoise(rng, size, 11);

  const heights = new Float32Array(size * size);
  const tiles = new Uint8Array(size * size);
  const blocked = new Uint8Array(size * size);
  const idx = (x, y) => y * size + x;

  const { village, quarry, lake, barrows, lair, pasture } = REGIONS;
  const villageCx = (village.x0 + village.x1) / 2;
  const villageCy = (village.y0 + village.y1) / 2;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let h = base(x, y) * 5 + detail(x, y) * 2 + fine(x, y) * 0.6;
      let tile = TILE_TYPES.GRASS;

      // The quarry sits on a raised, stony shelf.
      if (inRegion(quarry, x, y)) {
        h += 2.5;
        tile = TILE_TYPES.STONE;
      }
      // Lake basin: dig down, with a noisy shoreline.
      if (inRegion(lake, x, y)) {
        const edge = Math.min(x - lake.x0, lake.x1 - x, y - lake.y0, lake.y1 - y);
        const depth = Math.min(1, edge / 6) * (0.65 + lakeNoise(x, y) * 0.5);
        if (depth > 0.35) {
          h -= 4 * depth;
          tile = TILE_TYPES.WATER;
        } else if (depth > 0.12) {
          tile = TILE_TYPES.SAND;
        }
      }
      if (inRegion(barrows, x, y)) tile = tile === TILE_TYPES.WATER ? tile : TILE_TYPES.DIRT;
      if (inRegion(lair, x, y)) {
        h += 1.2;
        tile = TILE_TYPES.STONE;
      }

      // Flatten the village so buildings sit level.
      const dv = Math.max(Math.abs(x - villageCx) / 16, Math.abs(y - villageCy) / 14);
      if (dv < 1.35) {
        const t = Math.min(1, Math.max(0, 1.35 - dv));
        h = h * (1 - t) + 3.2 * t;
        if (dv < 1 && tile === TILE_TYPES.GRASS) tile = TILE_TYPES.DIRT;
      }
      if (inRegion(pasture, x, y)) h = h * 0.5 + 2.4;

      heights[idx(x, y)] = h;
      tiles[idx(x, y)] = tile;
      if (tile === TILE_TYPES.WATER) blocked[idx(x, y)] = 1;
    }
  }

  // Water sits at a single, flat level; sink the basin under it and lift the
  // shoreline just above it so beaches read as beaches.
  for (let i = 0; i < heights.length; i++) {
    if (tiles[i] === TILE_TYPES.WATER) heights[i] = Math.min(heights[i], WATER_LEVEL - 0.55);
    // Everything else stays above the waterline so low ground never looks flooded.
    else heights[i] = Math.max(heights[i], WATER_LEVEL + (tiles[i] === TILE_TYPES.SAND ? 0.08 : 0.3));
  }

  // Roads out of the village.
  const road = (x0, y0, x1, y1) => {
    const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
    for (let i = 0; i <= steps; i++) {
      const x = Math.round(x0 + ((x1 - x0) * i) / steps);
      const y = Math.round(y0 + ((y1 - y0) * i) / steps);
      for (let ox = -1; ox <= 1; ox++) {
        for (let oy = -1; oy <= 1; oy++) {
          const tx = x + ox;
          const ty = y + oy;
          if (tx < 0 || ty < 0 || tx >= size || ty >= size) continue;
          if (tiles[idx(tx, ty)] === TILE_TYPES.WATER) continue;
          tiles[idx(tx, ty)] = TILE_TYPES.PATH;
        }
      }
    }
  };
  road(80, 84, 80, 60); // north to the quarry
  road(66, 96, 56, 96); // west to the forest
  road(94, 96, 108, 96); // east to the lake
  road(80, 108, 80, 122); // south to the barrows

  const objects = [];
  const occupied = new Set();
  const key = (x, y) => y * size + x;

  function place(type, x, y, rot = 0) {
    if (x < 0 || y < 0 || x >= size || y >= size) return null;
    if (occupied.has(key(x, y))) return null;
    const def = OBJECTS[type];
    if (!def) throw new Error(`worldgen: unknown object ${type}`);
    const obj = { index: objects.length, type, x, y, rot };
    objects.push(obj);
    occupied.add(key(x, y));
    if (def.blocks) blocked[idx(x, y)] = 1;
    return obj;
  }

  // --- Village buildings ---------------------------------------------------
  function building(x0, y0, x1, y1, doors) {
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        const onEdge = x === x0 || x === x1 || y === y0 || y === y1;
        if (!onEdge) {
          tiles[idx(x, y)] = TILE_TYPES.FLOOR;
          continue;
        }
        tiles[idx(x, y)] = TILE_TYPES.FLOOR;
        const isDoor = doors.some((d) => d[0] === x && d[1] === y);
        place(isDoor ? 'door' : 'wall', x, y);
      }
    }
  }

  building(70, 88, 77, 94, [[73, 94]]); // bank
  place('bank_booth', 72, 89);
  place('bank_booth', 74, 89);
  place('bank_booth', 76, 89);

  building(83, 88, 90, 94, [[86, 94]]); // general store
  place('stall', 88, 90);

  building(70, 100, 78, 106, [[74, 100]]); // smithy
  place('furnace', 72, 104);
  place('anvil', 76, 104);
  place('range', 72, 102);

  place('altar', 87, 103);
  place('log_pile', 84, 100);
  place('bush', 82, 98);
  place('bush', 79, 99);

  // Pasture fence with a gate.
  for (let x = pasture.x0; x <= pasture.x1; x += 1) {
    place(x === pasture.x0 + 4 ? 'gate' : 'fence', x, pasture.y0);
    place('fence', x, pasture.y1);
  }
  for (let y = pasture.y0 + 1; y < pasture.y1; y += 1) {
    place('fence', pasture.x0, y);
    place('fence', pasture.x1, y);
  }

  // --- Agility course ------------------------------------------------------
  place('log_balance', 96, 82);
  place('rope_swing', 96, 78);
  place('climbing_wall', 100, 78);

  // --- Trees ---------------------------------------------------------------
  const forest = REGIONS.forest;
  for (let y = forest.y0; y <= forest.y1; y++) {
    for (let x = forest.x0; x <= forest.x1; x++) {
      if (tiles[idx(x, y)] !== TILE_TYPES.GRASS) continue;
      if (rng() > 0.16) continue;
      const roll = rng();
      let type = 'tree';
      if (roll > 0.94) type = 'maple_tree';
      else if (roll > 0.8) type = 'willow_tree';
      else if (roll > 0.55) type = 'oak_tree';
      place(type, x, y);
    }
  }
  // A handful of starter trees just outside the village.
  for (const [x, y] of [[64, 92], [63, 100], [65, 104], [95, 88], [97, 86], [93, 108], [88, 110], [84, 112]]) {
    place('tree', x, y);
  }
  place('oak_tree', 62, 96);
  place('oak_tree', 96, 92);

  // --- Rocks ---------------------------------------------------------------
  for (let y = quarry.y0; y <= quarry.y1; y++) {
    for (let x = quarry.x0; x <= quarry.x1; x++) {
      if (blocked[idx(x, y)]) continue;
      if (rng() > 0.13) continue;
      const depth = (quarry.y1 - y) / (quarry.y1 - quarry.y0); // 0 south .. 1 north
      const roll = rng();
      let type;
      if (depth > 0.82) type = roll > 0.55 ? 'adamantite_rock' : 'mithril_rock';
      else if (depth > 0.62) type = roll > 0.5 ? 'mithril_rock' : 'gold_rock';
      else if (depth > 0.42) type = roll > 0.45 ? 'coal_rock' : 'gold_rock';
      else if (depth > 0.22) type = roll > 0.4 ? 'iron_rock' : 'coal_rock';
      else type = roll > 0.5 ? 'copper_rock' : 'tin_rock';
      place(type, x, y);
    }
  }
  // Guaranteed beginner ore beside the road into the quarry.
  for (const [x, y] of [[77, 66], [78, 67], [76, 68]]) place('copper_rock', x, y);
  for (const [x, y] of [[83, 66], [84, 67], [82, 68]]) place('tin_rock', x, y);
  for (const [x, y] of [[79, 70], [85, 70]]) place('iron_rock', x, y);
  place('rock_scenery', 81, 68);

  // --- Fishing spots -------------------------------------------------------
  const isWater = (x, y) => tiles[idx(x, y)] === TILE_TYPES.WATER;
  const shoreSpots = [];
  for (let y = lake.y0; y <= lake.y1; y++) {
    for (let x = lake.x0; x <= lake.x1; x++) {
      if (!isWater(x, y)) continue;
      const shore = !isWater(x - 1, y) || !isWater(x + 1, y) || !isWater(x, y - 1) || !isWater(x, y + 1);
      if (shore) shoreSpots.push([x, y]);
    }
  }
  shoreSpots.forEach(([x, y], i) => {
    if (i % 9 !== 0) return;
    const type = x > (lake.x0 + lake.x1) / 2 + 8 ? 'cage_spot' : y < (lake.y0 + lake.y1) / 2 ? 'rod_spot' : 'net_spot';
    place(type, x, y);
  });

  // --- Camps and scenery ---------------------------------------------------
  for (const [x, y] of [[48, 46], [50, 48], [46, 50], [52, 44]]) place('log_pile', x, y);
  for (const [x, y] of [[110, 50], [112, 52], [108, 54]]) place('log_pile', x, y);
  for (let i = 0; i < 40; i++) {
    const x = lair.x0 + Math.floor(rng() * (lair.x1 - lair.x0));
    const y = lair.y0 + Math.floor(rng() * (lair.y1 - lair.y0));
    place('rock_scenery', x, y);
  }
  for (let i = 0; i < 30; i++) {
    const x = barrows.x0 + Math.floor(rng() * (barrows.x1 - barrows.x0));
    const y = barrows.y0 + Math.floor(rng() * (barrows.y1 - barrows.y0));
    place(rng() > 0.5 ? 'rock_scenery' : 'bush', x, y);
  }

  // --- NPC spawns ----------------------------------------------------------
  const spawns = [
    { npc: 'guide', x: 80, y: 97, radius: 0 },
    { npc: 'banker', x: 72, y: 91, radius: 0 },
    { npc: 'banker', x: 75, y: 91, radius: 0 },
    { npc: 'shopkeeper', x: 86, y: 91, radius: 0 },
    { npc: 'smith', x: 74, y: 103, radius: 0 },
  ];
  const scatter = (npc, region, count, radius = 5) => {
    let placed = 0;
    let guard = 0;
    while (placed < count && guard++ < count * 200) {
      const x = region.x0 + Math.floor(rng() * (region.x1 - region.x0 + 1));
      const y = region.y0 + Math.floor(rng() * (region.y1 - region.y0 + 1));
      if (blocked[idx(x, y)]) continue;
      spawns.push({ npc, x, y, radius });
      placed++;
    }
  };
  scatter('rat', { x0: 74, y0: 108, x1: 90, y1: 120 }, 8, 4);
  scatter('rat', REGIONS.barrows, 6, 5);
  scatter('cow', pasture, 12, 6);
  scatter('goblin', REGIONS.goblins, 14, 6);
  scatter('bandit', REGIONS.bandits, 10, 6);
  scatter('skeleton', REGIONS.barrows, 12, 6);
  scatter('ogre', { x0: 100, y0: 126, x1: 116, y1: 146 }, 6, 6);
  scatter('dragon', lair, 4, 8);

  return { size, seed, heights, tiles, blocked, objects, spawns };
}

/** Smooth height lookup so entities glide over terrain instead of stepping. */
export function heightAt(world, x, y) {
  const size = world.size;
  const cx = Math.min(size - 2, Math.max(0, Math.floor(x)));
  const cy = Math.min(size - 2, Math.max(0, Math.floor(y)));
  const fx = Math.min(1, Math.max(0, x - cx));
  const fy = Math.min(1, Math.max(0, y - cy));
  const h = world.heights;
  const h00 = h[cy * size + cx];
  const h10 = h[cy * size + cx + 1];
  const h01 = h[(cy + 1) * size + cx];
  const h11 = h[(cy + 1) * size + cx + 1];
  return (h00 * (1 - fx) + h10 * fx) * (1 - fy) + (h01 * (1 - fx) + h11 * fx) * fy;
}

export function tileAt(world, x, y) {
  if (x < 0 || y < 0 || x >= world.size || y >= world.size) return TILE_TYPES.GRASS;
  return world.tiles[y * world.size + x];
}
