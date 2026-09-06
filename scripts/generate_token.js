import crypto from "node:crypto";
import pg from "pg";
import dotenv from "dotenv";

dotenv.config();

if (!process.env.DATABASE_URL) {
  console.error(
    "DATABASE_URL not set in environment. Aborting token generation."
  );
  process.exit(1);
}

const teamId = process.argv[2];
if (!teamId) {
  console.error("Usage: node generate_token.js <team-id|*>");
  process.exit(1);
}

(async () => {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    const token = crypto.randomBytes(24).toString("hex");
    await client.query(
      "insert into ics_tokens (token, team_id) values ($1,$2)",
      [token, teamId]
    );
    console.log("Generated token for", teamId, token);
  } catch (err) {
    console.error("Failed to generate token:", err.message || err);
    process.exit(2);
  } finally {
    client.release();
    await pool.end();
  }
})();
