import fs from "fs";
import path from "path";
import pg from "pg";
import dotenv from "dotenv";

dotenv.config();

const sqlPath = path.resolve(process.cwd(), "sql", "schema.sql");
const sql = fs.readFileSync(sqlPath, "utf8");

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL not set in environment. Aborting migration.");
  process.exit(1);
}

(async () => {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    console.log("Running migration from", sqlPath);
    await client.query(sql);
    console.log("Migration applied successfully");
  } catch (err) {
    console.error("Migration failed:", err.message || err);
    process.exit(2);
  } finally {
    client.release();
    await pool.end();
  }
})();
