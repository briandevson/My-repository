/**
 * Grid pathfinding. Movement is eight-directional; a diagonal step is only legal
 * when both orthogonal neighbours are clear, so entities never clip wall corners.
 */

const MAX_NODES = 6000;

const DIRS = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
  [1, -1],
  [1, 1],
  [-1, 1],
  [-1, -1],
];

export function canStep(isBlocked, fromX, fromY, toX, toY) {
  if (isBlocked(toX, toY)) return false;
  const dx = toX - fromX;
  const dy = toY - fromY;
  if (dx !== 0 && dy !== 0) {
    if (isBlocked(fromX + dx, fromY)) return false;
    if (isBlocked(fromX, fromY + dy)) return false;
  }
  return true;
}

/**
 * A* from (sx, sy) to (tx, ty).
 *
 * @param {(x:number,y:number)=>boolean} isBlocked
 * @param {number} range stop as soon as we are within this many tiles of the target
 * @returns {Array<{x:number,y:number}>} steps excluding the start tile; empty when unreachable
 */
export function findPath(isBlocked, sx, sy, tx, ty, range = 0, size = 160) {
  if (sx === tx && sy === ty) return [];
  const inBounds = (x, y) => x >= 0 && y >= 0 && x < size && y < size;
  if (!inBounds(tx, ty)) return [];

  const key = (x, y) => y * size + x;
  const open = [{ x: sx, y: sy, g: 0, f: heuristic(sx, sy, tx, ty), key: key(sx, sy) }];
  const cameFrom = new Map();
  const gScore = new Map([[key(sx, sy), 0]]);
  const closed = new Set();
  let expanded = 0;
  let best = null;
  let bestScore = Infinity;

  while (open.length > 0 && expanded < MAX_NODES) {
    // Small maps: a linear scan beats the bookkeeping of a real heap.
    let bestIdx = 0;
    for (let i = 1; i < open.length; i++) if (open[i].f < open[bestIdx].f) bestIdx = i;
    const current = open.splice(bestIdx, 1)[0];
    if (closed.has(current.key)) continue;
    closed.add(current.key);
    expanded++;

    const dist = Math.max(Math.abs(current.x - tx), Math.abs(current.y - ty));
    if (dist <= range) return reconstruct(cameFrom, current, key);
    if (dist < bestScore) {
      bestScore = dist;
      best = current;
    }

    for (const [dx, dy] of DIRS) {
      const nx = current.x + dx;
      const ny = current.y + dy;
      if (!inBounds(nx, ny)) continue;
      const nkey = key(nx, ny);
      if (closed.has(nkey)) continue;
      // The destination tile itself may be blocked (a rock, an NPC): range > 0
      // lets us path to a neighbour of it instead.
      if (!canStep(isBlocked, current.x, current.y, nx, ny)) continue;
      const tentative = current.g + (dx !== 0 && dy !== 0 ? 1.4 : 1);
      if (tentative >= (gScore.get(nkey) ?? Infinity)) continue;
      gScore.set(nkey, tentative);
      cameFrom.set(nkey, current);
      open.push({ x: nx, y: ny, g: tentative, f: tentative + heuristic(nx, ny, tx, ty), key: nkey });
    }
  }

  // Unreachable: walk as close as we got, which is what players expect.
  return best && best.key !== key(sx, sy) ? reconstruct(cameFrom, best, key) : [];
}

function heuristic(x, y, tx, ty) {
  const dx = Math.abs(x - tx);
  const dy = Math.abs(y - ty);
  return Math.max(dx, dy) + 0.4 * Math.min(dx, dy);
}

function reconstruct(cameFrom, node, key) {
  const path = [];
  let current = node;
  while (current) {
    path.push({ x: current.x, y: current.y });
    current = cameFrom.get(key(current.x, current.y));
  }
  path.pop(); // drop the start tile
  return path.reverse();
}
