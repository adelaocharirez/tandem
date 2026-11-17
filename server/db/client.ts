import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle as drizzlePg } from 'drizzle-orm/node-postgres';
import { migrate as migratePg } from 'drizzle-orm/node-postgres/migrator';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator';
import pg from 'pg';
import * as schema from './schema';

/**
 * The one database type the rest of the server sees. Both drivers below
 * produce it, so nothing outside this file knows which one is running.
 */
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

export interface DbHandle {
  db: Db;
  driver: 'postgres' | 'pglite';
  close: () => Promise<void>;
}

export interface DbOptions {
  /** Real Postgres. When absent we fall back to embedded PGlite. */
  databaseUrl?: string;
  /** Where PGlite keeps its files. Ignored when `memory` is set. */
  dataDir?: string;
  /** Throwaway in-memory database, used by the test suite. */
  memory?: boolean;
}

/** Find ./drizzle whether we run from source (tsx) or from the dist bundle. */
function migrationsFolder(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, '../drizzle'), // dist/server.js
    path.resolve(here, '../../drizzle'), // server/db/client.ts
    path.resolve(process.cwd(), 'drizzle'),
  ];
  const found = candidates.find((dir) => existsSync(path.join(dir, 'meta', '_journal.json')));
  if (!found) throw new Error(`Could not find the drizzle migrations folder (looked in ${candidates.join(', ')})`);
  return found;
}

/**
 * Open the database and bring it up to the latest migration.
 *
 * Postgres and PGlite speak the same SQL dialect (PGlite *is* Postgres,
 * compiled to WASM), so there is a single schema and a single set of
 * migrations. Local development needs no database install at all; production
 * just sets DATABASE_URL.
 */
export async function openDb(options: DbOptions): Promise<DbHandle> {
  const folder = migrationsFolder();

  if (options.databaseUrl) {
    const pool = new pg.Pool({ connectionString: options.databaseUrl, max: 10 });
    const db = drizzlePg(pool, { schema });
    await migratePg(db, { migrationsFolder: folder });
    return { db: db as unknown as Db, driver: 'postgres', close: () => pool.end() };
  }

  let client: PGlite;
  if (options.memory) {
    client = new PGlite();
  } else {
    const dir = path.resolve(options.dataDir ?? '.data', 'pglite');
    mkdirSync(dir, { recursive: true });
    client = new PGlite(dir);
  }
  const db = drizzlePglite(client, { schema });
  await migratePglite(db, { migrationsFolder: folder });
  return { db: db as unknown as Db, driver: 'pglite', close: () => client.close() };
}
