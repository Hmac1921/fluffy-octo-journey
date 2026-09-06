import "dotenv/config";
import express from "express";
import pkg from "@slack/bolt";
const { App: SlackApp, ExpressReceiver } = pkg;
import pg from "pg";
import icalGenerator from "ical-generator";
import nodeIcal from "node-ical";
import cron from "node-cron";
import pkgRRule from "rrule";
const { RRule } = pkgRRule;
import { DateTime } from "luxon";
import crypto from "node:crypto";

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: false,
});

const TZ = process.env.TZ || "Europe/Stockholm";
const KLUBRAUM_SOURCE = "klubraum";

// -------------------- Helpers: auth/roles --------------------
async function getRole(slackUserId) {
  const { rows } = await pool.query(
    "select role from roles where slack_user_id=$1",
    [slackUserId]
  );
  return rows[0]?.role || "member";
}
async function canEdit(slackUserId) {
  const role = await getRole(slackUserId);
  return role === "admin" || role === "coach";
}

// -------------------- Helpers: teams/events --------------------
async function listTeams() {
  const { rows } = await pool.query(
    "select id, name from teams order by name asc"
  );
  return rows;
}

async function ensureTeam(teamId, name) {
  await pool.query(
    "insert into teams (id, name) values ($1,$2) on conflict (id) do nothing",
    [teamId, name || teamId]
  );
}

async function listEventsForTeams({ teamIds, windowStart, windowEnd }) {
  const { rows } = await pool.query(
    `
    select e.*, array_agg(et.team_id) as team_ids
    from events e
    join event_teams et on et.event_id = e.id
    where e.cancelled = false
      and et.team_id = any($1)
    group by e.id
    `,
    [teamIds]
  );
  return rows.map((r) => ({
    ...r,
    team_ids: r.team_ids || [],
  }));
}

function parseRRule(rruleStr, dtstart) {
  const clean = rruleStr?.startsWith("RRULE:") ? rruleStr.slice(6) : rruleStr;
  const opts = RRule.fromString(clean).options;
  return opts ? new RRule({ ...opts, dtstart }) : null;
}

function expandOccurrences(eventRow, windowStart, windowEnd) {
  const start = DateTime.fromJSDate(new Date(eventRow.start_at)).setZone(
    eventRow.timezone || TZ
  );
  const end = DateTime.fromJSDate(new Date(eventRow.end_at)).setZone(
    eventRow.timezone || TZ
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
  const occurrences = rule.between(windowStart, windowEnd, true);

  return occurrences.map((occ) => {
    const occStart = DateTime.fromJSDate(occ).setZone(eventRow.timezone || TZ);
    const occEnd = DateTime.fromMillis(
      occStart.toMillis() + durationMs
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

function getKlubraumConfig(overrides = {}) {
  return {
    icsUrl: overrides.icsUrl || process.env.KLUBRAUM_ICS_URL || "",
    teamId: overrides.teamId || process.env.KLUBRAUM_TEAM_ID || "team-b",
    teamName:
      overrides.teamName || process.env.KLUBRAUM_TEAM_NAME || "Klubraum",
    filter: overrides.filter ?? process.env.KLUBRAUM_FILTER ?? "",
  };
}

function eventMatchesFilter(ev, filter) {
  if (!filter) return true;
  const haystack = [ev.summary, ev.location, ev.description]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return haystack.includes(filter.toLowerCase());
}

function eventExternalUid(key, ev, start) {
  const uid = ev.uid || key;
  const recurrenceId = ev.recurrenceid
    ? new Date(ev.recurrenceid).toISOString()
    : "";
  return [uid, recurrenceId].filter(Boolean).join("#") || `${key}:${start}`;
}

async function importKlubraumCalendar(overrides = {}) {
  const { icsUrl, teamId, teamName, filter } = getKlubraumConfig(overrides);
  if (!icsUrl) {
    throw new Error("KLUBRAUM_ICS_URL is not configured");
  }

  await ensureTeam(teamId, teamName);

  const parsed = await nodeIcal.async.fromURL(icsUrl);
  let seen = 0;
  let imported = 0;
  let updated = 0;
  let skipped = 0;

  for (const [key, ev] of Object.entries(parsed)) {
    if (!ev || ev.type !== "VEVENT") continue;
    seen += 1;

    if (!eventMatchesFilter(ev, filter)) {
      skipped += 1;
      continue;
    }

    const title = String(ev.summary || "Untitled Klubraum event").trim();
    const start = ev.start ? new Date(ev.start) : null;
    if (!start || Number.isNaN(start.getTime())) {
      skipped += 1;
      continue;
    }

    const endCandidate = ev.end ? new Date(ev.end) : null;
    const end =
      endCandidate && !Number.isNaN(endCandidate.getTime())
        ? endCandidate
        : new Date(start.getTime() + 60 * 60 * 1000);
    const externalUid = eventExternalUid(key, ev, start.toISOString());

    const values = [
      title,
      start.toISOString(),
      end.toISOString(),
      TZ,
      ev.location || null,
      ev.description || null,
      "importer",
      KLUBRAUM_SOURCE,
      externalUid,
    ];

    const existing = await pool.query(
      "select id from events where external_source=$1 and external_uid=$2 limit 1",
      [KLUBRAUM_SOURCE, externalUid]
    );

    let eventId;
    if (existing.rows[0]) {
      eventId = existing.rows[0].id;
      await pool.query(
        `update events
         set title=$1, start_at=$2, end_at=$3, timezone=$4, location=$5,
             notes=$6, created_by=$7, external_source=$8, external_uid=$9,
             updated_at=now()
         where id=$10`,
        [...values, eventId]
      );
      updated += 1;
    } else {
      const inserted = await pool.query(
        `insert into events
           (title, start_at, end_at, timezone, location, notes, created_by,
            external_source, external_uid)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         returning id`,
        values
      );
      eventId = inserted.rows[0].id;
      imported += 1;
    }

    await pool.query(
      "insert into event_teams (event_id, team_id) values ($1,$2) on conflict do nothing",
      [eventId, teamId]
    );
  }

  return { seen, imported, updated, skipped, teamId };
}

async function saveAttendance({
  eventId,
  occurrenceStart,
  userId,
  userName,
  status,
}) {
  if (!["yes", "no", "maybe"].includes(status)) {
    throw new Error("invalid status");
  }

  await pool.query(
    `delete from attendance
     where event_id=$1
       and user_id=$2
       and occurrence_start is not distinct from $3::timestamptz`,
    [eventId, userId, occurrenceStart || null]
  );
  await pool.query(
    `insert into attendance
       (event_id, occurrence_start, user_id, user_name, status)
     values ($1,$2,$3,$4,$5)`,
    [eventId, occurrenceStart || null, userId, userName || userId, status]
  );
}

async function getAttendanceSummary(eventId, occurrenceStart) {
  const { rows } = await pool.query(
    `select user_id, coalesce(user_name, user_id) as user_name, status, created_at
     from attendance
     where event_id=$1
       and occurrence_start is not distinct from $2::timestamptz
     order by created_at asc`,
    [eventId, occurrenceStart || null]
  );

  return {
    yes: rows.filter((r) => r.status === "yes"),
    no: rows.filter((r) => r.status === "no"),
    maybe: rows.filter((r) => r.status === "maybe"),
  };
}

// -------------------- ICS token check --------------------
async function assertTokenAllowed(token, requestedTeamIds) {
  if (!token) return false;

  const { rows } = await pool.query(
    "select team_id from ics_tokens where token=$1",
    [token]
  );
  const allowed = rows[0]?.team_id;
  if (!allowed) return false;

  if (allowed === "*") return true;

  return requestedTeamIds.length === 1 && requestedTeamIds[0] === allowed;
}

function normalizeTeamIdsParam(idsParam) {
  return (idsParam || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 10);
}

// -------------------- Express app + Slack receiver --------------------
let slack;
let web;
let slackMode = "disabled";

if (process.env.SLACK_BOT_TOKEN && process.env.SLACK_APP_TOKEN) {
  slack = new SlackApp({
    token: process.env.SLACK_BOT_TOKEN,
    appToken: process.env.SLACK_APP_TOKEN,
    socketMode: true,
  });
  web = express();
  slackMode = "socket";
} else if (process.env.SLACK_BOT_TOKEN && process.env.SLACK_SIGNING_SECRET) {
  const receiver = new ExpressReceiver({
    signingSecret: process.env.SLACK_SIGNING_SECRET,
  });
  slack = new SlackApp({ token: process.env.SLACK_BOT_TOKEN, receiver });
  web = receiver.app;
  slackMode = "webhook";
} else {
  console.warn(
    "SLACK_BOT_TOKEN or SLACK_SIGNING_SECRET missing — Slack handlers disabled"
  );
  const noop = () => {};
  slack = { event: noop, action: noop, view: noop, client: null };
  web = express();
}

web.get("/health", (_, res) => res.json({ ok: true }));
web.get("/api/health", (_, res) => res.json({ ok: true }));

web.get("/api/events", async (req, res) => {
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

    const occs = [];
    for (const e of events) {
      occs.push(...expandOccurrences(e, windowStart, windowEnd));
    }
    occs.sort((a, b) => a.start.getTime() - b.start.getTime());
    res.json({ occurrences: occs.slice(0, 200) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || String(err) });
  }
});

web.post("/api/events/:eventId/attendance", express.json(), async (req, res) => {
  try {
    const eventId = req.params.eventId;
    const { user_id, user_name, occurrence_start, status } = req.body || {};
    if (!user_id || !status) {
      return res.status(400).json({ error: "user_id and status required" });
    }

    await saveAttendance({
      eventId,
      occurrenceStart: occurrence_start || null,
      userId: user_id,
      userName: user_name || user_id,
      status,
    });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || String(err) });
  }
});

web.get("/api/events/:eventId/attendance", async (req, res) => {
  try {
    const eventId = req.params.eventId;
    const occurrenceStart = req.query.occurrence_start?.toString() || null;
    const { rows } = await pool.query(
      `select user_id, coalesce(user_name, user_id) as user_name, status, created_at
       from attendance
       where event_id=$1
         and occurrence_start is not distinct from $2::timestamptz
       order by created_at asc`,
      [eventId, occurrenceStart]
    );
    res.json({ attendance: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || String(err) });
  }
});

// -------------------- ICS endpoints --------------------
web.get("/ics/team/:teamId", async (req, res) => {
  const teamId = req.params.teamId;
  const token = req.query.token?.toString() || "";

  const ok = await assertTokenAllowed(token, [teamId]);
  if (!ok) return res.status(403).send("Forbidden");

  const teamIds = [teamId];
  return serveIcsForTeams(req, res, teamIds, `Team ${teamId}`);
});

web.get("/ics/teams", async (req, res) => {
  const token = req.query.token?.toString() || "";
  const teamIds = normalizeTeamIdsParam(req.query.ids?.toString() || "");

  if (!teamIds.length) return res.status(400).send("Missing ids");

  const ok = await assertTokenAllowed(token, teamIds);
  if (!ok) return res.status(403).send("Forbidden");

  return serveIcsForTeams(req, res, teamIds, `Teams: ${teamIds.join(", ")}`);
});

async function serveIcsForTeams(req, res, teamIds, calName) {
  const now = DateTime.now().setZone(TZ);
  const windowStart = now.minus({ days: 30 }).toJSDate();
  const windowEnd = now.plus({ days: 180 }).toJSDate();

  const events = await listEventsForTeams({ teamIds, windowStart, windowEnd });

  const cal = icalGenerator({ name: calName, timezone: TZ });

  const seen = new Set();

  for (const e of events) {
    const occs = expandOccurrences(e, windowStart, windowEnd);
    for (const occ of occs) {
      const key = `${occ.series_id}:${occ.start.getTime()}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const uid = `${occ.series_id}-${occ.start.getTime()}@club-calendar`;

      const evt = cal.createEvent({
        id: uid,
        start: occ.start,
        end: occ.end,
        summary: occ.title,
        location: occ.location || undefined,
        description: buildDescription(occ),
      });

      void evt;
    }
  }

  res.setHeader("Content-Type", "text/calendar; charset=utf-8");
  res.setHeader("Content-Disposition", 'inline; filename="calendar.ics"');
  res.send(cal.toString());
}

function buildDescription(occ) {
  const teamsLine = occ.team_ids?.length
    ? `Teams: ${occ.team_ids.join(", ")}`
    : "";
  const notesLine = occ.notes ? `\n\n${occ.notes}` : "";
  return `${teamsLine}${notesLine}`.trim();
}

function formatWhen(start) {
  return DateTime.fromJSDate(new Date(start))
    .setZone(TZ)
    .toFormat("ccc d LLL, HH:mm");
}

function escapeMrkdwn(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function occurrenceHash(occ) {
  return crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        title: occ.title,
        start: new Date(occ.start).toISOString(),
        end: new Date(occ.end).toISOString(),
        location: occ.location || "",
        notes: occ.notes || "",
        team_ids: occ.team_ids || [],
      })
    )
    .digest("hex");
}

function attendanceLine(rows) {
  if (!rows.length) return "_None yet_";
  return rows.map((r) => escapeMrkdwn(r.user_name)).join(", ");
}

async function buildSlackCalendarBlocks(occ) {
  const occurrenceStart = new Date(occ.start).toISOString();
  const attendance = await getAttendanceSummary(occ.series_id, occurrenceStart);
  const teamLabel = occ.team_ids?.length
    ? `\n*Teams:* ${occ.team_ids.join(", ")}`
    : "";
  const location = occ.location ? `\n*Where:* ${escapeMrkdwn(occ.location)}` : "";
  const notes = occ.notes ? `\n${escapeMrkdwn(occ.notes)}` : "";
  const text = `*${escapeMrkdwn(occ.title)}*\n*When:* ${formatWhen(
    occ.start
  )}${teamLabel}${location}${notes}`;

  return {
    text: `${occ.title} - ${formatWhen(occ.start)}`,
    blocks: [
      { type: "section", text: { type: "mrkdwn", text } },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "Yes" },
            style: "primary",
            value: JSON.stringify({
              event: occ.series_id,
              occurrence_start: occurrenceStart,
              status: "yes",
            }),
            action_id: "attendance_yes",
          },
          {
            type: "button",
            text: { type: "plain_text", text: "No" },
            style: "danger",
            value: JSON.stringify({
              event: occ.series_id,
              occurrence_start: occurrenceStart,
              status: "no",
            }),
            action_id: "attendance_no",
          },
        ],
      },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: `*Yes:* ${attendanceLine(attendance.yes)}\n*No:* ${attendanceLine(
              attendance.no
            )}`,
          },
        ],
      },
    ],
  };
}

async function occurrenceFromEvent(eventId, occurrenceStart) {
  const { rows } = await pool.query(
    `select e.*, array_agg(et.team_id) as team_ids
     from events e
     left join event_teams et on et.event_id = e.id
     where e.id=$1
     group by e.id`,
    [eventId]
  );
  const event = rows[0];
  if (!event) return null;

  const seriesStart = new Date(event.start_at);
  const seriesEnd = new Date(event.end_at);
  const start = occurrenceStart ? new Date(occurrenceStart) : seriesStart;
  const durationMs = seriesEnd.getTime() - seriesStart.getTime();

  return {
    series_id: event.id,
    title: event.title,
    start,
    end: new Date(start.getTime() + durationMs),
    location: event.location,
    notes: event.notes,
    team_ids: event.team_ids || [],
  };
}

async function lookupSlackDisplayName(client, userId, fallback) {
  try {
    const info = await client.users.info({ user: userId });
    const user = info.user || {};
    return (
      user.profile?.display_name ||
      user.profile?.real_name ||
      user.real_name ||
      user.name ||
      fallback ||
      userId
    );
  } catch {
    return fallback || userId;
  }
}

async function refreshSlackAttendanceMessage(client, channel, ts, eventId, occurrenceStart) {
  const occ = await occurrenceFromEvent(eventId, occurrenceStart);
  if (!occ) return;
  const message = await buildSlackCalendarBlocks(occ);
  await client.chat.update({
    channel,
    ts,
    text: message.text,
    blocks: message.blocks,
  });
}

async function postCalendarUpdates({ teamId, days = 30, limit = 5, defaultChannel }) {
  if (!slack.client) throw new Error("Slack is not configured");

  const teamsQuery = teamId
    ? "select id, name, slack_channel_id from teams where id=$1"
    : "select id, name, slack_channel_id from teams order by name asc";
  const teamsParams = teamId ? [teamId] : [];
  const { rows: teams } = await pool.query(teamsQuery, teamsParams);

  const now = DateTime.now().setZone(TZ);
  const windowStart = now.toJSDate();
  const windowEnd = now.plus({ days: Number(days) || 30 }).toJSDate();
  const results = [];

  for (const team of teams) {
    const channel = team.slack_channel_id || defaultChannel;
    if (!channel) {
      results.push({ teamId: team.id, skipped: "missing channel" });
      continue;
    }

    const rows = await listEventsForTeams({
      teamIds: [team.id],
      windowStart,
      windowEnd,
    });
    let occs = [];
    for (const row of rows) {
      occs.push(...expandOccurrences(row, windowStart, windowEnd));
    }
    occs.sort((a, b) => a.start.getTime() - b.start.getTime());
    occs = occs.slice(0, Number(limit) || 5);

    for (const occ of occs) {
      const occurrenceStart = new Date(occ.start).toISOString();
      const contentHash = occurrenceHash(occ);
      const existing = await pool.query(
        `select message_ts, content_hash
         from slack_event_posts
         where event_id=$1 and occurrence_start=$2 and channel_id=$3`,
        [occ.series_id, occurrenceStart, channel]
      );

      if (existing.rows[0]?.message_ts && existing.rows[0].content_hash === contentHash) {
        results.push({ teamId: team.id, eventId: occ.series_id, action: "unchanged" });
        continue;
      }

      const message = await buildSlackCalendarBlocks(occ);
      let messageTs = existing.rows[0]?.message_ts;
      let action = "posted";

      if (messageTs) {
        try {
          await slack.client.chat.update({
            channel,
            ts: messageTs,
            text: message.text,
            blocks: message.blocks,
          });
          action = "updated";
        } catch {
          messageTs = null;
        }
      }

      if (!messageTs) {
        const posted = await slack.client.chat.postMessage({
          channel,
          text: message.text,
          blocks: message.blocks,
        });
        messageTs = posted.ts;
      }

      await pool.query(
        `insert into slack_event_posts
           (event_id, occurrence_start, channel_id, message_ts, content_hash)
         values ($1,$2,$3,$4,$5)
         on conflict (event_id, occurrence_start, channel_id)
         do update set message_ts=excluded.message_ts,
                       content_hash=excluded.content_hash,
                       updated_at=now()`,
        [occ.series_id, occurrenceStart, channel, messageTs, contentHash]
      );
      results.push({ teamId: team.id, eventId: occ.series_id, action });
    }
  }

  return results;
}

// -------------------- Slack App Home UI --------------------
async function publishHome(client, userId, selectedTeamIds) {
  const teams = await listTeams();
  const can_user_edit = await canEdit(userId);

  const teamIds = selectedTeamIds?.length
    ? selectedTeamIds
    : teams.map((t) => t.id);

  const now = DateTime.now().setZone(TZ);
  const windowStart = now.toJSDate();
  const windowEnd = now.plus({ days: 14 }).toJSDate();

  const rows = await listEventsForTeams({ teamIds, windowStart, windowEnd });

  let occs = [];
  for (const r of rows)
    occs.push(...expandOccurrences(r, windowStart, windowEnd));
  occs.sort((a, b) => a.start.getTime() - b.start.getTime());
  occs = occs.slice(0, 12);

  const teamOptions = teams.map((t) => ({
    text: { type: "plain_text", text: t.name },
    value: t.id,
  }));

  const blocks = [
    { type: "header", text: { type: "plain_text", text: "Club Calendar" } },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: can_user_edit
          ? "You can add/edit events (coach/admin)."
          : "Read-only. Ask a coach/admin to make changes.",
      },
    },
    {
      type: "actions",
      elements: [
        {
          type: "multi_static_select",
          action_id: "team_multi_select",
          placeholder: { type: "plain_text", text: "Filter teams" },
          options: teamOptions,
          initial_options: teamOptions
            .filter((o) => teamIds.includes(o.value))
            .slice(0, 10),
        },
        ...(can_user_edit
          ? [
              {
                type: "button",
                action_id: "add_event",
                text: { type: "plain_text", text: "Add event" },
                style: "primary",
                value: JSON.stringify({ teamIds }),
              },
            ]
          : []),
      ],
    },
    { type: "divider" },
  ];

  if (!occs.length) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: "_No upcoming events._" },
    });
  } else {
    for (const occ of occs) {
      const when = DateTime.fromJSDate(occ.start)
        .setZone(TZ)
        .toFormat("ccc d LLL, HH:mm");
      const teamLabel = occ.team_ids?.length
        ? `\n*Teams:* ${occ.team_ids.join(", ")}`
        : "";
      const loc = occ.location ? `\n*Where:* ${occ.location}` : "";

      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*${occ.title}*\n*When:* ${when}${teamLabel}${loc}`,
        },
        accessory: can_user_edit
          ? {
              type: "button",
              action_id: "edit_event",
              text: { type: "plain_text", text: "Edit series" },
              value: occ.series_id,
            }
          : undefined,
      });
      blocks.push({ type: "divider" });
    }
  }

  await client.views.publish({
    user_id: userId,
    view: { type: "home", blocks },
  });
}

slack.event("app_home_opened", async ({ event, client }) => {
  await publishHome(client, event.user, null);
});

slack.action("team_multi_select", async ({ ack, body, client }) => {
  await ack();
  const selected =
    body.actions?.[0]?.selected_options?.map((o) => o.value) || [];
  await publishHome(client, body.user.id, selected);
});

slack.action(/^attendance_/, async ({ ack, body, client }) => {
  await ack();
  try {
    const action = body.actions?.[0];
    const payload = JSON.parse(action?.value || "{}");
    const eventId = payload.event;
    const occurrenceStart = payload.occurrence_start || null;
    const status = payload.status || action?.action_id?.replace("attendance_", "");
    const userId = body.user?.id;
    if (!eventId || !status || !userId) return;

    const userName = await lookupSlackDisplayName(client, userId, body.user?.name);
    await saveAttendance({
      eventId,
      occurrenceStart,
      userId,
      userName,
      status,
    });

    const channel = body.channel?.id;
    const ts = body.message?.ts;
    if (channel && ts) {
      await refreshSlackAttendanceMessage(
        client,
        channel,
        ts,
        eventId,
        occurrenceStart
      );
    }
  } catch (err) {
    console.error("attendance action failed", err);
  }
});

slack.action("add_event", async ({ ack, body, client }) => {
  await ack();
  const userId = body.user.id;
  if (!(await canEdit(userId))) return;

  const meta = JSON.parse(body.actions?.[0]?.value || "{}");
  const teamIds = meta.teamIds || [];

  const teams = await listTeams();
  const teamOptions = teams.map((t) => ({
    text: { type: "plain_text", text: t.name },
    value: t.id,
  }));

  await client.views.open({
    trigger_id: body.trigger_id,
    view: {
      type: "modal",
      callback_id: "add_event_submit",
      private_metadata: JSON.stringify({ teamIds }),
      title: { type: "plain_text", text: "Add event" },
      submit: { type: "plain_text", text: "Create" },
      close: { type: "plain_text", text: "Cancel" },
      blocks: [
        {
          type: "input",
          block_id: "teams",
          label: { type: "plain_text", text: "Teams" },
          element: {
            type: "multi_static_select",
            action_id: "value",
            options: teamOptions,
            initial_options: teamOptions
              .filter((o) => teamIds.includes(o.value))
              .slice(0, 10),
          },
        },
        {
          type: "input",
          block_id: "title",
          label: { type: "plain_text", text: "Title (Training / Match)" },
          element: { type: "plain_text_input", action_id: "value" },
        },
        {
          type: "input",
          block_id: "start",
          label: { type: "plain_text", text: "Start (YYYY-MM-DD HH:mm)" },
          element: { type: "plain_text_input", action_id: "value" },
        },
        {
          type: "input",
          block_id: "end",
          label: { type: "plain_text", text: "End (YYYY-MM-DD HH:mm)" },
          element: { type: "plain_text_input", action_id: "value" },
        },
        {
          type: "input",
          optional: true,
          block_id: "rrule",
          label: {
            type: "plain_text",
            text: "Recurring (optional RRULE, e.g. FREQ=WEEKLY;BYDAY=TU)",
          },
          element: { type: "plain_text_input", action_id: "value" },
        },
        {
          type: "input",
          optional: true,
          block_id: "location",
          label: { type: "plain_text", text: "Location" },
          element: { type: "plain_text_input", action_id: "value" },
        },
        {
          type: "input",
          optional: true,
          block_id: "notes",
          label: { type: "plain_text", text: "Notes" },
          element: {
            type: "plain_text_input",
            action_id: "value",
            multiline: true,
          },
        },
      ],
    },
  });
});

slack.view("add_event_submit", async ({ ack, body, view, client }) => {
  const userId = body.user.id;
  if (!(await canEdit(userId))) return ack();

  const teamsSel =
    view.state.values.teams.value.selected_options?.map((o) => o.value) || [];
  const title = view.state.values.title.value.value.trim();
  const startStr = view.state.values.start.value.value.trim();
  const endStr = view.state.values.end.value.value.trim();
  const rruleStr = (view.state.values.rrule?.value?.value || "").trim() || null;
  const location =
    (view.state.values.location?.value?.value || "").trim() || null;
  const notes = (view.state.values.notes?.value?.value || "").trim() || null;

  const start = DateTime.fromFormat(startStr, "yyyy-MM-dd HH:mm", { zone: TZ });
  const end = DateTime.fromFormat(endStr, "yyyy-MM-dd HH:mm", { zone: TZ });

  const errors = {};
  if (!teamsSel.length) errors.teams = "Select at least one team";
  if (!title) errors.title = "Required";
  if (!start.isValid) errors.start = "Invalid date/time";
  if (!end.isValid) errors.end = "Invalid date/time";
  if (start.isValid && end.isValid && end <= start)
    errors.end = "End must be after start";

  if (rruleStr) {
    try {
      parseRRule(rruleStr, start.toJSDate());
    } catch {
      errors.rrule = "Invalid RRULE";
    }
  }

  if (Object.keys(errors).length) {
    return ack({ response_action: "errors", errors });
  }

  const { rows } = await pool.query(
    `
    insert into events (title, start_at, end_at, timezone, location, notes, rrule, created_by)
    values ($1,$2,$3,$4,$5,$6,$7,$8)
    returning id
    `,
    [title, start.toISO(), end.toISO(), TZ, location, notes, rruleStr, userId]
  );
  const eventId = rows[0].id;

  for (const teamId of teamsSel) {
    await pool.query(
      "insert into event_teams (event_id, team_id) values ($1,$2) on conflict do nothing",
      [eventId, teamId]
    );
  }

  await ack();
  await publishHome(client, userId, teamsSel);
});

function requireAdminRequest(req, res) {
  const adminSecret = process.env.ADMIN_SECRET || null;
  const headerSecret = req.get("X-ADMIN-SECRET");
  if (!adminSecret) {
    res
      .status(403)
      .json({ error: "admin endpoint not enabled (set ADMIN_SECRET)" });
    return false;
  }
  if (!headerSecret || headerSecret !== adminSecret) {
    res.status(401).json({ error: "unauthorized" });
    return false;
  }
  return true;
}

// Admin-protected token creation endpoint. Protect with ADMIN_SECRET env var
// or X-ADMIN-SECRET header. This is still simple — replace with real auth
// (OAuth + roles) in production.
web.post("/admin/token/create", express.json(), async (req, res) => {
  if (!requireAdminRequest(req, res)) return;

  const { teamId } = req.body || {};
  if (!teamId)
    return res.status(400).json({ error: 'teamId required ("team-a" or "*")' });

  const token = crypto.randomBytes(24).toString("hex");
  await pool.query("insert into ics_tokens (token, team_id) values ($1,$2)", [
    token,
    teamId,
  ]);
  res.json({ token, teamId });
});

web.post("/admin/klubraum/import", express.json(), async (req, res) => {
  try {
    if (!requireAdminRequest(req, res)) return;
    const result = await importKlubraumCalendar(req.body || {});
    res.json({ ok: true, result });
  } catch (err) {
    console.error("Klubraum import failed", err);
    res.status(500).json({ error: err.message || String(err) });
  }
});

web.post("/admin/post-calendar-updates", express.json(), async (req, res) => {
  try {
    if (!requireAdminRequest(req, res)) return;
    const body = req.body || {};
    let importResult = null;
    if (body.importFirst !== false) {
      importResult = await importKlubraumCalendar(body);
    }
    const posts = await postCalendarUpdates({
      teamId: body.teamId || process.env.KLUBRAUM_TEAM_ID || "team-b",
      days: body.days || 30,
      limit: body.limit || 5,
      defaultChannel: body.default_channel || process.env.SLACK_DEFAULT_CHANNEL,
    });
    res.json({ ok: true, import: importResult, posts });
  } catch (err) {
    console.error("Posting calendar updates failed", err);
    res.status(500).json({ error: err.message || String(err) });
  }
});

web.post("/admin/post-next", express.json(), async (req, res) => {
  try {
    if (!requireAdminRequest(req, res)) return;
    const body = req.body || {};
    if (body.importFirst !== false) {
      await importKlubraumCalendar(body);
    }
    const posts = await postCalendarUpdates({
      teamId: body.teamId || process.env.KLUBRAUM_TEAM_ID || "team-b",
      days: body.days || 30,
      limit: 1,
      defaultChannel: body.default_channel || process.env.SLACK_DEFAULT_CHANNEL,
    });
    res.json({ ok: true, posts });
  } catch (err) {
    console.error("Posting next event failed", err);
    res.status(500).json({ error: err.message || String(err) });
  }
});

const PORT = process.env.PORT || 3000;
web.listen(PORT, () => console.log(`Server running on :${PORT}`));

if (slackMode === "socket") {
  await slack.start();
  console.log("Slack app running in Socket Mode");
}

if (process.env.KLUBRAUM_ICS_URL) {
  importKlubraumCalendar()
    .then((result) => console.log("Klubraum import complete", result))
    .catch((err) => console.error("Klubraum startup import failed", err));

  cron.schedule(process.env.KLUBRAUM_CRON || "0 6 * * *", () => {
    importKlubraumCalendar()
      .then((result) => console.log("Klubraum scheduled import complete", result))
      .catch((err) => console.error("Klubraum scheduled import failed", err));
  });
}
