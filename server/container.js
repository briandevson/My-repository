import { getItem, isStackable } from '../shared/items.js';

/**
 * Fixed-size item containers (inventory, bank, shop stock).
 * A slot is either `null` or `{ id, count }`. Stackable items collapse into one
 * slot; everything else occupies one slot per item, as in the original games.
 */

export function createContainer(size) {
  return new Array(size).fill(null);
}

export function countOf(container, id) {
  let total = 0;
  for (const slot of container) {
    if (slot && slot.id === id) total += slot.count;
  }
  return total;
}

export function freeSlots(container) {
  return container.reduce((n, slot) => n + (slot ? 0 : 1), 0);
}

/**
 * How many of `id` will fit. Stackables need one slot unless already present.
 */
export function canHold(container, id, count, alwaysStack = false) {
  const stack = alwaysStack || isStackable(id);
  if (stack) {
    if (container.some((slot) => slot?.id === id)) return count;
    return freeSlots(container) > 0 ? count : 0;
  }
  return Math.min(count, freeSlots(container));
}

/**
 * @returns {number} how many were actually added.
 */
export function addItem(container, id, count = 1, alwaysStack = false) {
  getItem(id); // throws on typos in content data
  if (count <= 0) return 0;
  const stack = alwaysStack || isStackable(id);
  if (stack) {
    const existing = container.findIndex((slot) => slot?.id === id);
    if (existing >= 0) {
      container[existing].count += count;
      return count;
    }
    const free = container.indexOf(null);
    if (free < 0) return 0;
    container[free] = { id, count };
    return count;
  }
  let added = 0;
  for (let i = 0; i < container.length && added < count; i++) {
    if (container[i]) continue;
    container[i] = { id, count: 1 };
    added++;
  }
  return added;
}

/**
 * @returns {number} how many were actually removed.
 */
export function removeItem(container, id, count = 1) {
  let remaining = count;
  for (let i = 0; i < container.length && remaining > 0; i++) {
    const slot = container[i];
    if (!slot || slot.id !== id) continue;
    const take = Math.min(slot.count, remaining);
    slot.count -= take;
    remaining -= take;
    if (slot.count <= 0) container[i] = null;
  }
  return count - remaining;
}

export function removeFromSlot(container, index, count = 1) {
  const slot = container[index];
  if (!slot) return null;
  const take = Math.min(slot.count, count);
  slot.count -= take;
  const id = slot.id;
  if (slot.count <= 0) container[index] = null;
  return { id, count: take };
}

export function hasItems(container, requirements) {
  return Object.entries(requirements).every(([id, count]) => countOf(container, id) >= count);
}

export function removeItems(container, requirements) {
  if (!hasItems(container, requirements)) return false;
  for (const [id, count] of Object.entries(requirements)) removeItem(container, id, count);
  return true;
}

export function swapSlots(container, a, b) {
  if (a < 0 || b < 0 || a >= container.length || b >= container.length) return false;
  const tmp = container[a];
  container[a] = container[b];
  container[b] = tmp;
  return true;
}

/** Compact a container so empty slots sink to the end (used by the bank). */
export function compact(container) {
  const filled = container.filter(Boolean);
  for (let i = 0; i < container.length; i++) container[i] = filled[i] ?? null;
}

export function serialize(container) {
  return container.map((slot) => (slot ? { id: slot.id, count: slot.count } : null));
}

export function deserialize(data, size) {
  const container = createContainer(size);
  if (!Array.isArray(data)) return container;
  for (let i = 0; i < Math.min(size, data.length); i++) {
    const slot = data[i];
    if (slot && slot.id && Number.isFinite(slot.count) && slot.count > 0) {
      container[i] = { id: slot.id, count: slot.count };
    }
  }
  return container;
}
