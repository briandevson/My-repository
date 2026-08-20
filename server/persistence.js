import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.AETHERIA_DATA ?? join(here, 'data', 'players');

mkdirSync(DATA_DIR, { recursive: true });

export { normaliseName, displayName } from '../shared/names.js';
import { normaliseName, displayName } from '../shared/names.js';

function fileFor(name) {
  // The name is validated by normaliseName before it ever reaches here, so it
  // cannot contain path separators.
  return join(DATA_DIR, `${createHash('sha256').update(name).digest('hex').slice(0, 32)}.json`);
}

function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  const derived = scryptSync(String(password), salt, 32).toString('hex');
  return { salt, hash: derived };
}

function verifyPassword(password, salt, expected) {
  const derived = scryptSync(String(password), salt, 32);
  const stored = Buffer.from(expected, 'hex');
  return derived.length === stored.length && timingSafeEqual(derived, stored);
}

export function loadAccount(name) {
  const file = fileFor(name);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    console.error(`[persistence] corrupt save for ${name}:`, error.message);
    return null;
  }
}

export function saveAccount(name, account) {
  writeFileSync(fileFor(name), JSON.stringify(account, null, 0));
}

/**
 * Log in, or register a new character.
 *
 * Names are unique and case-insensitive: they are normalised to lowercase
 * before anything looks at them, so `Gwyn`, `gwyn` and `GWYN` are one
 * character and the second person to want that name is turned away.
 *
 * @param {boolean} create true to register, false to log in to an existing one
 * @returns {{ok:true, account:object, fresh:boolean, name:string} | {ok:false, reason:string}}
 */
export function authenticate(name, password, create = false) {
  const clean = normaliseName(name);
  if (!clean) return { ok: false, reason: 'Names must be 2-12 letters, digits or underscores.' };
  if (String(password ?? '').length < 4) return { ok: false, reason: 'Passwords must be at least 4 characters.' };

  const existing = loadAccount(clean);

  if (create) {
    if (existing) {
      return { ok: false, reason: `The name ${displayName(clean)} is already taken. Please choose another.` };
    }
    const { salt, hash } = hashPassword(password);
    const account = { name: clean, salt, hash, created: Date.now(), save: null };
    saveAccount(clean, account);
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

/** Is this name free to register? */
export function nameAvailable(name) {
  const clean = normaliseName(name);
  return !!clean && !loadAccount(clean);
}

export function persistPlayer(player) {
  const account = loadAccount(player.name);
  if (!account) return;
  account.save = player.toSave();
  account.lastSeen = Date.now();
  saveAccount(player.name, account);
}
