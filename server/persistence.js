import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { createStorage } from './storage.js';
import { normaliseName, displayName } from '../shared/names.js';

export { normaliseName, displayName } from '../shared/names.js';

/**
 * Accounts and character saves.
 *
 * Storage is pluggable (see storage.js) because free hosts wipe the filesystem
 * on every restart. Everything here is async as a result - the one thing that
 * must never be lost is a character.
 */

let storage = createStorage();

/** Swap the backend. Used by tests and by the server at boot. */
export async function useStorage(next) {
  storage = next;
  await storage.init();
  return storage;
}

export async function initStorage() {
  await storage.init();
  return storage;
}

export function storageKind() {
  return storage.kind;
}

export function describeStorage() {
  return storage.describe();
}

function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  return { salt, hash: scryptSync(String(password), salt, 32).toString('hex') };
}

function verifyPassword(password, salt, expected) {
  const derived = scryptSync(String(password), salt, 32);
  const stored = Buffer.from(expected, 'hex');
  return derived.length === stored.length && timingSafeEqual(derived, stored);
}

export async function loadAccount(name) {
  return storage.read(name);
}

export async function saveAccount(name, account) {
  await storage.write(name, account);
}

export async function nameAvailable(name) {
  const clean = normaliseName(name);
  if (!clean) return false;
  return (await loadAccount(clean)) === null;
}

/**
 * Log in, or register a new character.
 *
 * Names are unique and case-insensitive: they are normalised to lowercase
 * before anything looks at them, so `Gwyn`, `gwyn` and `GWYN` are one
 * character and the second person to want that name is turned away.
 *
 * @param {boolean} create true to register, false to log in to an existing one
 * @returns {Promise<{ok:true, account:object, fresh:boolean, name:string} | {ok:false, reason:string}>}
 */
export async function authenticate(name, password, create = false) {
  const clean = normaliseName(name);
  if (!clean) return { ok: false, reason: 'Names must be 2-12 letters, digits or underscores.' };
  if (String(password ?? '').length < 4) return { ok: false, reason: 'Passwords must be at least 4 characters.' };

  const existing = await loadAccount(clean);

  if (create) {
    if (existing) {
      return { ok: false, reason: `The name ${displayName(clean)} is already taken. Please choose another.` };
    }
    const { salt, hash } = hashPassword(password);
    const account = { name: clean, salt, hash, created: Date.now(), save: null };
    await saveAccount(clean, account);
    return { ok: true, account, fresh: true, name: clean };
  }

  if (!existing) {
    return { ok: false, reason: `No character called ${displayName(clean)}. Choose "Create character" to make one.` };
  }
  if (!verifyPassword(password, existing.salt, existing.hash)) {
    return { ok: false, reason: 'Incorrect password.' };
  }
  return { ok: true, account: existing, fresh: false, name: clean };
}

export async function persistPlayer(player) {
  const account = await loadAccount(player.name);
  if (!account) return false;
  account.save = player.toSave();
  account.lastSeen = Date.now();
  await saveAccount(player.name, account);
  return true;
}
