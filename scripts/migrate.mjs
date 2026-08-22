import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { config } from "dotenv";

config({ path: ".env.local" });
config({ path: ".env" });

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.log("DATABASE_URL is not set; skipping migrations.");
  process.exit(0);
}

const directory = path.dirname(fileURLToPath(import.meta.url));
const sql = await readFile(path.join(directory, "../migrations/001_initial.sql"), "utf8");
const client = new pg.Client({ connectionString: databaseUrl });
await client.connect();
try {
  await client.query(sql);
  console.log("Applied migrations/001_initial.sql");
} finally {
  await client.end();
}
