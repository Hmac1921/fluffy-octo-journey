import "dotenv/config";
import express from "express";
import pg from "pg";
import pkgRRule from "rrule";
import { DateTime } from "luxon";
import pkg from "@slack/bolt";
import ical from "node-ical";
import cron from "node-cron";

const { RRule } = pkgRRule as any;
const { Pool } = pg;

const TZ = process.env.TZ || "Europe/Stockholm";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: false,
});

// Importer: fetch ICS feed and upsert B-team events
async function importIcsForTeam(icsUrl: string | undefined, teamId: string) {
  if (!icsUrl) return;
  try {
    const parsed = (await ical.async.fromURL)
      ? await (ical as any).async.fromURL(icsUrl)
      : await (ical as any).fromURL(icsUrl);
    for (const k of Object.keys(parsed)) {
      const ev = (parsed as any)[k];
      if (!ev || ev.type !== "VEVENT") continue;
      const title = (ev.summary || "").toString();
      if (!/b[- ]?team/i.test(title)) continue;

      const start = ev.start ? new Date(ev.start) : null;
      const end = ev.end ? new Date(ev.end) : start;
      if (!start) continue;

      // Avoid duplicates by checking title + start
      const { rows: existing } = await pool.query(
        "select id from events where title=$1 and start_at=$2 limit 1",
        [title, start.toISOString()],
      );
      if (existing?.length) continue;

      const insert = await pool.query(
        `insert into events (title, start_at, end_at, timezone, location, notes, rrule, created_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
        [
          title,
          start.toISOString(),
          end?.toISOString() || null,
          ev.tz || TZ,
          ev.location || null,
          ev.description || null,
          ev.rrule || null,
          "importer",
        ],
      );
      const eventId = insert.rows[0].id;
      await pool.query(
        "insert into event_teams (event_id, team_id) values ($1,$2) on conflict do nothing",
        [eventId, teamId],
      );
    }
    console.log("ICS import complete for", teamId);
  } catch (err) {
    console.error("ICS import error", err);
  }
}

function normalizeTeamIdsParam(idsParam?: string) {
  return (idsParam || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 10);
}

function parseRRule(rruleStr: string | null, dtstart: Date) {
  if (!rruleStr) return null;
  const clean = rruleStr?.startsWith("RRULE:") ? rruleStr.slice(6) : rruleStr;
  const opts = (RRule as any).fromString(clean).options;
  return opts ? new RRule({ ...opts, dtstart }) : null;
}

function expandOccurrences(eventRow: any, windowStart: Date, windowEnd: Date) {
  const start = DateTime.fromJSDate(new Date(eventRow.start_at)).setZone(
    eventRow.timezone || TZ,
  );
  const end = DateTime.fromJSDate(new Date(eventRow.end_at)).setZone(
    eventRow.timezone || TZ,
  );
  const durationMs = end.toMillis() - start.toMillis();

  if (!eventRow.rrule) {
    const s = start.toJSDate();
    if (s >= windowStart && s < windowEnd) {
      return [
        {
          series_id: eventRow.id,
          title: eventRow.title,
          start: start.toJSDate(),
          end: end.toJSDate(),
          location: eventRow.location,
          notes: eventRow.notes,
          team_ids: eventRow.team_ids,
          rrule: null,
        },
      ];
    }
    return [];
  }

  const rule = parseRRule(eventRow.rrule, start.toJSDate());
  if (!rule) return [];
  const occurrences = rule.between(windowStart, windowEnd, true);

  return occurrences.map((occ: Date) => {
    const occStart = DateTime.fromJSDate(occ).setZone(eventRow.timezone || TZ);
    const occEnd = DateTime.fromMillis(
      occStart.toMillis() + durationMs,
    ).setZone(eventRow.timezone || TZ);
    return {
      series_id: eventRow.id,
      title: eventRow.title,
      start: occStart.toJSDate(),
      end: occEnd.toJSDate(),
      location: eventRow.location,
      notes: eventRow.notes,
      team_ids: eventRow.team_ids,
      rrule: eventRow.rrule,
    };
  });
}

async function listEventsForTeams({ teamIds, windowStart, windowEnd }: any) {
  const { rows } = await pool.query(
    `
    select e.*, array_agg(et.team_id) as team_ids
    from events e
    join event_teams et on et.event_id = e.id
    where e.cancelled = false
      and et.team_id = any($1)
    group by e.id
    `,
    [teamIds],
  );
  return rows.map((r: any) => ({ ...r, team_ids: r.team_ids || [] }));
}

const app = express();
app.use(express.json());

// Slack Bolt integration: prefer Socket Mode (SLACK_APP_TOKEN) for local dev,
// fall back to ExpressReceiver when only signing secret is available.
const { App: SlackApp, ExpressReceiver } = pkg as any;
let slackApp: any = null;
let receiver: any = null;

if (process.env.SLACK_APP_TOKEN && process.env.SLACK_BOT_TOKEN) {
  // Socket Mode — no public HTTP endpoint required for Slack events in dev
  slackApp = new SlackApp({
    token: process.env.SLACK_BOT_TOKEN,
    appToken: process.env.SLACK_APP_TOKEN,
    socketMode: true,
  });

  // Minimal app home publish
  slackApp.event("app_home_opened", async ({ event, client }: any) => {
    try {
      await client.views.publish({
        user_id: event.user,
        view: {
          type: "home",
          blocks: [
            {
              type: "section",
              text: { type: "mrkdwn", text: "Welcome to Club Calendar" },
            },
          ],
        },
      });
    } catch (err) {
      console.error("publish home failed", err);
    }
  });

  // Simple action handler for attendance buttons
  slackApp.action(/attend_/, async ({ ack, body }: any) => {
    await ack();
    try {
      const payload = body.actions?.[0];
      const val = JSON.parse(payload.value || "{}");
      const eventId = val.event;
      const status = val.status;
      const userId = body.user?.id || body.message?.user || "unknown";
      if (eventId && status && userId) {
        await pool.query(
          "insert into attendance (event_id, user_id, status) values ($1,$2,$3)",
          [eventId, userId, status],
        );
      }
    } catch (err) {
      console.error("action handler error", err);
    }
  });

  console.log("Slack App initialized in Socket Mode");
} else if (process.env.SLACK_SIGNING_SECRET) {
  // Use ExpressReceiver for standard webhook mode (production)
  receiver = new ExpressReceiver({
    signingSecret: process.env.SLACK_SIGNING_SECRET,
  });
  if (process.env.SLACK_BOT_TOKEN) {
    slackApp = new SlackApp({ token: process.env.SLACK_BOT_TOKEN, receiver });

    // Minimal app home publish
    slackApp.event("app_home_opened", async ({ event, client }: any) => {
      try {
        await client.views.publish({
          user_id: event.user,
          view: {
            type: "home",
            blocks: [
              {
                type: "section",
                text: { type: "mrkdwn", text: "Welcome to Club Calendar" },
              },
            ],
          },
        });
      } catch (err) {
        console.error("publish home failed", err);
      }
    });

    slackApp.action(/attend_/, async ({ ack, body }: any) => {
      await ack();
      try {
        const payload = body.actions?.[0];
        const val = JSON.parse(payload.value || "{}");
        const eventId = val.event;
        const status = val.status;
        const userId = body.user?.id || body.message?.user || "unknown";
        if (eventId && status && userId) {
          await pool.query(
            "insert into attendance (event_id, user_id, status) values ($1,$2,$3)",
            [eventId, userId, status],
          );
        }
      } catch (err) {
        console.error("action handler error", err);
      }
    });
  } else {
    console.warn("SLACK_BOT_TOKEN missing — Slack handlers disabled");
  }

  // Mount receiver app so Slack can reach our handlers
  app.use(receiver.app);
} else {
  console.warn("No Slack credentials found — Slack integration disabled");
}

app.get("/api/health", (_req, res) => res.json({ ok: true }));

app.get("/api/events", async (req, res) => {
  try {
    const ids = normalizeTeamIdsParam(req.query.ids?.toString() || "");
    if (!ids.length) return res.status(400).json({ error: "Missing ids" });

    const now = DateTime.now().setZone(TZ);
    const windowStart = now.minus({ days: 30 }).toJSDate();
    const windowEnd = now
      .plus({ days: Number(req.query.days || 180) })
      .toJSDate();

    const events = await listEventsForTeams({
      teamIds: ids,
      windowStart,
      windowEnd,
    });

    const occs: any[] = [];
    for (const e of events) {
      occs.push(...expandOccurrences(e, windowStart, windowEnd));
    }
    occs.sort((a, b) => a.start.getTime() - b.start.getTime());
    res.json({ occurrences: occs.slice(0, 200) });
  } catch (err: any) {
    console.error(err);
    res.status(500).json({ error: err.message || String(err) });
  }
});

app.post("/api/events/:eventId/attendance", async (req, res) => {
  try {
    const eventId = req.params.eventId;
    const { user_id, status } = req.body || {};
    if (!user_id || !status)
      return res.status(400).json({ error: "user_id and status required" });
    if (!["yes", "no", "maybe"].includes(status))
      return res.status(400).json({ error: "invalid status" });

    await pool.query(
      `insert into attendance (event_id, user_id, status) values ($1,$2,$3)`,
      [eventId, user_id, status],
    );
    res.json({ ok: true });
  } catch (err: any) {
    console.error(err);
    res.status(500).json({ error: err.message || String(err) });
  }
});

app.get("/api/events/:eventId/attendance", async (req, res) => {
  try {
    const eventId = req.params.eventId;
    const { rows } = await pool.query(
      "select user_id, status, created_at from attendance where event_id=$1",
      [eventId],
    );
    res.json({ attendance: rows });
  } catch (err: any) {
    console.error(err);
    res.status(500).json({ error: err.message || String(err) });
  }
});

// Admin endpoint: post next training for a team (or all teams) to their Slack channels
app.post("/admin/post-next", async (req, res) => {
  try {
    if (!slackApp)
      return res.status(500).json({ error: "Slack not configured" });

    const { teamId } = req.body || {};

    const teamsQuery = teamId
      ? "select id, name, slack_channel_id from teams where id=$1"
      : "select id, name, slack_channel_id from teams";
    const teamsParams = teamId ? [teamId] : [];
    const { rows: teams } = await pool.query(teamsQuery, teamsParams);

    const now = DateTime.now().setZone(TZ);
    const windowStart = now.toJSDate();
    const windowEnd = now.plus({ days: 30 }).toJSDate();

    for (const t of teams) {
      const events = await listEventsForTeams({
        teamIds: [t.id],
        windowStart,
        windowEnd,
      });
      let occs: any[] = [];
      for (const e of events)
        occs.push(...expandOccurrences(e, windowStart, windowEnd));
      occs.sort((a, b) => a.start.getTime() - b.start.getTime());
      const next = occs[0];
      if (!next) continue;

      const when = DateTime.fromJSDate(next.start)
        .setZone(TZ)
        .toFormat("ccc d LLL, HH:mm");
      const text = `*${next.title}*\n*When:* ${when}\n*Teams:* ${next.team_ids.join(", ")}`;

      const channel = t.slack_channel_id || req.body.default_channel;
      if (!channel) continue;

      await slackApp.client.chat.postMessage({
        channel,
        text: `${next.title} — ${when}`,
        blocks: [
          { type: "section", text: { type: "mrkdwn", text } },
          {
            type: "actions",
            elements: [
              {
                type: "button",
                text: { type: "plain_text", text: "I'm coming" },
                value: JSON.stringify({ event: next.series_id, status: "yes" }),
                action_id: "attend_yes",
              },
              {
                type: "button",
                text: { type: "plain_text", text: "Can't make it" },
                value: JSON.stringify({ event: next.series_id, status: "no" }),
                action_id: "attend_no",
              },
              {
                type: "button",
                text: { type: "plain_text", text: "Maybe" },
                value: JSON.stringify({
                  event: next.series_id,
                  status: "maybe",
                }),
                action_id: "attend_maybe",
              },
            ],
          },
        ],
      });
    }

    res.json({ ok: true });
  } catch (err: any) {
    console.error(err);
    res.status(500).json({ error: err.message || String(err) });
  }
});

// Admin endpoint: publish App Home for a user (useful for testing)
app.post("/admin/publish-home", async (req, res) => {
  try {
    if (!slackApp)
      return res.status(500).json({ error: "Slack not configured" });
    const { user_id } = req.body || {};
    if (!user_id) return res.status(400).json({ error: "user_id required" });

    const blocks = [
      { type: "header", text: { type: "plain_text", text: "Club Calendar" } },
      {
        type: "section",
        text: { type: "mrkdwn", text: "This is a test App Home view." },
      },
    ];

    await slackApp.client.views.publish({
      user_id,
      view: { type: "home", blocks },
    });

    res.json({ ok: true });
  } catch (err: any) {
    console.error("publish-home error", err);
    res.status(500).json({ error: err.message || String(err) });
  }
});

const PORT = process.env.PORT ? Number(process.env.PORT) : 5432;
app.listen(PORT, () => console.log(`TypeScript server running on :${PORT}`));

// Schedule daily import at 06:00 server time for b-team
const icsUrl = process.env.KLUBRAUM_ICS_URL || null;
if (icsUrl) {
  // Run once at startup
  void importIcsForTeam(icsUrl, "b-team");
  // Schedule daily at 06:00
  cron.schedule("0 6 * * *", () => {
    void importIcsForTeam(icsUrl, "b-team");
  });
}
