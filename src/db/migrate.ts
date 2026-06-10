import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { db } from "./pool.js";
import { logger } from "../lib/logger.js";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "../../migrations");

export async function migrate(): Promise<void> {
  await db.query(
    `create table if not exists schema_migrations (
       version text primary key,
       applied_at timestamptz not null default now()
     )`,
  );

  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort();

  for (const file of files) {
    const { rowCount } = await db.query("select 1 from schema_migrations where version = $1", [
      file,
    ]);
    if (rowCount) continue;

    const sql = await readFile(join(migrationsDir, file), "utf8");
    const client = await db.connect();
    try {
      await client.query("begin");
      await client.query(sql);
      await client.query("insert into schema_migrations (version) values ($1)", [file]);
      await client.query("commit");
      logger.info({ file }, "migration applied");
    } catch (err) {
      await client.query("rollback");
      throw err;
    } finally {
      client.release();
    }
  }
}

// Allow running standalone: tsx src/db/migrate.ts
if (import.meta.url === `file://${process.argv[1]}`) {
  migrate()
    .then(() => process.exit(0))
    .catch((err) => {
      logger.error(err, "migration failed");
      process.exit(1);
    });
}
