import pg from "pg";
import dotenv from "dotenv";

dotenv.config();

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL not set in environment. Aborting seed.");
  process.exit(1);
}

(async () => {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();

  try {
    console.log("Seeding sample teams and roles...");
    await client.query(
      "insert into teams (id, name) values ($1,$2) on conflict do nothing",
      ["team-a", "Team A"]
    );
    await client.query(
      "insert into teams (id, name) values ($1,$2) on conflict do nothing",
      ["team-b", "Team B"]
    );
    await client.query(
      "insert into roles (slack_user_id, role) values ($1,$2) on conflict do nothing",
      ["UADMIN", "admin"]
    );
    await client.query(
      "insert into roles (slack_user_id, role) values ($1,$2) on conflict do nothing",
      ["UCOACH", "coach"]
    );

    console.log("Creating a sample event...");
    const res = await client.query(
      `insert into events (title, start_at, end_at, timezone, location, notes, created_by)
       values ($1,$2,$3,$4,$5,$6,$7)
       on conflict do nothing
       returning id`,
      [
        "Sample Training",
        new Date().toISOString(),
        new Date(Date.now() + 3600 * 1000).toISOString(),
        "Europe/Stockholm",
        "Local Pitch",
        "Notes",
        "UADMIN",
      ]
    );
    const eventId = res.rows[0]?.id;
    if (eventId) {
      await client.query(
        "insert into event_teams (event_id, team_id) values ($1,$2) on conflict do nothing",
        [eventId, "team-a"]
      );
    }

    console.log("Seed completed");
  } catch (err) {
    console.error("Seed failed:", err.message || err);
    process.exit(2);
  } finally {
    client.release();
    await pool.end();
  }
})();
