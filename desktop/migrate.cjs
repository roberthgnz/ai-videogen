const fs = require("node:fs");
const path = require("node:path");
const runtime = require("node:module").createRequire(path.join(__dirname, "runtime/package.json"));
const Database = runtime("better-sqlite3");
const { drizzle } = runtime("drizzle-orm/better-sqlite3");
const { migrate } = runtime("drizzle-orm/better-sqlite3/migrator");
const storage = process.env.STORAGE_DIR;
if (!storage || !path.isAbsolute(storage)) throw new Error("Missing desktop data directory");
let language;
try { language = JSON.parse(fs.readFileSync(path.join(storage, "settings.json"), "utf8"))?.language; } catch { /* First launch. */ }
const spanish = (language === "en" || language === "es" ? language : process.env.VIDEOGEN_SYSTEM_LANGUAGE) === "es";
fs.mkdirSync(storage, { recursive: true });
const sqlite = new Database(path.join(storage, "app.db"));
try {
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  migrate(drizzle(sqlite), { migrationsFolder: path.join(process.env.VIDEOGEN_APP_DIR, "drizzle") });
  // Work in memory cannot survive a sidecar shutdown; leave recoverable errors.
  sqlite.prepare("UPDATE videos SET status = 'error', error = ?, finished_at = ? WHERE status IN ('queued', 'composing', 'rendering')")
    .run(spanish ? "La aplicación se cerró antes de terminar. Puedes volver a generar el vídeo." : "The app closed before the render finished. You can generate the video again.", Date.now());
  sqlite.prepare("UPDATE projects SET script_status = 'error', script_error = ? WHERE script_status = 'running'")
    .run(spanish ? "La aplicación se cerró antes de terminar el guion. Puedes volver a generarlo." : "The app closed before the script finished. You can generate it again.");
} finally { sqlite.close(); }
