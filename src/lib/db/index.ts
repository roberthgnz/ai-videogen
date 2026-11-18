import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { ensureDir, storagePaths, storageRoot } from "../storage";
import * as schema from "./schema";
import { appResource } from "../runtime";

export type Db = BetterSQLite3Database<typeof schema> & { $client: Database.Database };

// One SQLite connection per process, surviving Next.js dev hot reloads. The
// drizzle wrapper is rebuilt (and pending migrations applied) when the schema
// module is reloaded or, in development, when a new migration is generated,
// so a schema change does not need a server restart.
const globalForDb = globalThis as unknown as {
  __videogenDb?: Db;
  __videogenSchema?: typeof schema;
  __videogenJournal?: number;
};

const migrationsFolder = () => appResource("drizzle");

/** Changes whenever `drizzle-kit generate` adds a migration. */
function journalStamp(): number {
  try {
    return fs.statSync(path.join(migrationsFolder(), "meta", "_journal.json")).mtimeMs;
  } catch {
    return 0;
  }
}

function open(existing?: Database.Database): Db {
  ensureDir(storageRoot());
  const sqlite = existing ?? new Database(storagePaths.db());
  if (!existing) {
    sqlite.pragma("journal_mode = WAL");
    sqlite.pragma("foreign_keys = ON");
    sqlite.pragma("busy_timeout = 5000");
  }
  const db = drizzle({ client: sqlite, schema });
  // Personal local app: apply pending migrations on first connection.
  migrate(db, { migrationsFolder: migrationsFolder() });
  return db;
}

export function getDb(): Db {
  const journal = process.env.NODE_ENV === "production" ? 0 : journalStamp();
  if (!globalForDb.__videogenDb || globalForDb.__videogenSchema !== schema || globalForDb.__videogenJournal !== journal) {
    const existing = globalForDb.__videogenDb?.$client;
    globalForDb.__videogenDb = open(existing?.open ? existing : undefined);
    globalForDb.__videogenSchema = schema;
    globalForDb.__videogenJournal = journal;
  }
  return globalForDb.__videogenDb;
}

export { schema };
