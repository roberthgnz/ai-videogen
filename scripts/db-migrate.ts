/**
 * Applies pending migrations to storage/app.db and prints the tables.
 * The app also migrates on its first DB connection; this is for manual use.
 *   npm run db:migrate
 */
import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd());

async function main() {
  const { getDb } = await import("../src/lib/db");
  const { storagePaths } = await import("../src/lib/storage");
  const db = getDb();
  const tables = db.$client
    .prepare("select name from sqlite_master where type='table' order by name")
    .all() as { name: string }[];
  console.log(`DB: ${storagePaths.db()}`);
  console.log(`Tables: ${tables.map((t) => t.name).join(", ")}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
