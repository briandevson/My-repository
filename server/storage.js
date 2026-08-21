import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Where characters are kept.
 *
 * Two backends, one interface. The filesystem is right for a machine you own.
 * Free hosts almost all have an *ephemeral* filesystem - it is wiped on every
 * restart, redeploy and idle spin-down - so there the characters must live in a
 * database instead, or everyone's progress quietly disappears overnight.
 *
 * Set DATABASE_URL and the Postgres backend is used automatically.
 */

const here = dirname(fileURLToPath(import.meta.url));

/** Names are validated upstream, but never build a path from one regardless. */
function fileNameFor(key) {
  return `${createHash('sha256').update(key).digest('hex').slice(0, 32)}.json`;
}

export function createFileStorage(directory = process.env.AETHERIA_DATA ?? join(here, 'data', 'players')) {
  mkdirSync(directory, { recursive: true });
  return {
    kind: 'file',
    describe: () => `files in ${directory}`,
    async init() {},
    async read(key) {
      const file = join(directory, fileNameFor(key));
      if (!existsSync(file)) return null;
      try {
        return JSON.parse(readFileSync(file, 'utf8'));
      } catch (error) {
        console.error(`[storage] unreadable record for ${key}: ${error.message}`);
        return null;
      }
    },
    async write(key, value) {
      writeFileSync(join(directory, fileNameFor(key)), JSON.stringify(value));
    },
    async close() {},
  };
}

export function createPostgresStorage(connectionString) {
  let pool = null;

  const ssl = process.env.DATABASE_SSL === 'no-verify' ? { rejectUnauthorized: false } : undefined;

  return {
    kind: 'postgres',
    describe: () => 'postgres',
    async init() {
      // Imported lazily so a filesystem-backed server never needs the driver.
      const { default: pg } = await import('pg');
      pool = new pg.Pool({ connectionString, ssl, max: 4 });
      await pool.query(`
        CREATE TABLE IF NOT EXISTS accounts (
          name TEXT PRIMARY KEY,
          data JSONB NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);
    },
    async read(key) {
      const result = await pool.query('SELECT data FROM accounts WHERE name = $1', [key]);
      return result.rows[0]?.data ?? null;
    },
    async write(key, value) {
      await pool.query(
        `INSERT INTO accounts (name, data) VALUES ($1, $2)
         ON CONFLICT (name) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
        [key, JSON.stringify(value)],
      );
    },
    async close() {
      await pool?.end();
      pool = null;
    },
  };
}

/** In-memory storage, for tests. Nothing survives the process. */
export function createMemoryStorage() {
  const records = new Map();
  return {
    kind: 'memory',
    describe: () => 'memory (nothing is saved)',
    async init() {},
    async read(key) {
      const value = records.get(key);
      return value === undefined ? null : JSON.parse(value);
    },
    async write(key, value) {
      records.set(key, JSON.stringify(value));
    },
    async close() {
      records.clear();
    },
  };
}

export function createStorage(env = process.env) {
  if (env.AETHERIA_STORAGE === 'memory') return createMemoryStorage();
  if (env.DATABASE_URL) return createPostgresStorage(env.DATABASE_URL);
  return createFileStorage(env.AETHERIA_DATA);
}
