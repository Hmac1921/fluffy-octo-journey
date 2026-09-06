import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { createSign } from "node:crypto";
import pkg from "@slack/bolt";
import { WebClient } from "@slack/web-api";
import nodeIcal from "node-ical";
import cron from "node-cron";
import { DateTime } from "luxon";

const { App: SlackApp } = pkg;

const TZ = process.env.TZ || "Europe/Stockholm";
const DATA_DIR = path.resolve(
  process.cwd(),
  process.env.SPREADSHEET_DIR || process.env.DATA_DIR || "data",
);
const ATTENDANCE_PATH = path.join(DATA_DIR, "attendance.csv");
const POSTS_PATH = path.join(DATA_DIR, "slack-posts.json");
const ATTENDANCE_HEADERS = [
  "created_at",
  "updated_at",
  "event_uid",
  "event_title",
  "event_start",
  "group",
  "status",
  "slack_user_id",
  "name",
  "channel_id",
  "message_ts",
];
const GOOGLE_SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets";
let googleAccessToken = null;

const ROUTES = [
  {
    key: "fwip",
    label: "FW/IP",
    channel: process.env.FWIP_CHANNEL_ID || "C0BSB3XL77D",
    filter: process.env.FWIP_FILTER || "fw/ip, fwip",
  },
  {
    key: "bteam",
    label: "B-team",
    channel: process.env.BTEAM_CHANNEL_ID || "",
    filter: process.env.BTEAM_FILTER || "b-team,b team,bteam",
  },
].filter((route) => route.channel);

function requireEnv(name) {
  if (!process.env[name]) {
    throw new Error(`${name} is required`);
  }
}

function argValue(name) {
  const prefix = `--${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : "";
}

function targetDayFromArgs() {
  const dateArg = argValue("date");
  if (dateArg) {
    const date = DateTime.fromISO(dateArg, { zone: TZ });
    if (!date.isValid) throw new Error(`Invalid --date value: ${dateArg}`);
    return date;
  }

  const daysAheadArg = argValue("days-ahead");
  if (daysAheadArg) {
    const daysAhead = Number(daysAheadArg);
    if (!Number.isFinite(daysAhead)) {
      throw new Error(`Invalid --days-ahead value: ${daysAheadArg}`);
    }
    return DateTime.now().setZone(TZ).plus({ days: daysAhead });
  }

  return DateTime.now().setZone(TZ);
}

function csvEscape(value) {
  const str = String(value ?? "");
  if (!/[",\r\n]/.test(str)) return str;
  return `"${str.replace(/"/g, '""')}"`;
}

function parseCsvLine(line) {
  const cells = [];
  let current = "";
  let quoted = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    const next = line[i + 1];
    if (quoted && char === '"' && next === '"') {
      current += '"';
      i += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (!quoted && char === ",") {
      cells.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  cells.push(current);
  return cells;
}

function googleSheetsEnabled() {
  return Boolean(
    process.env.GOOGLE_SHEETS_SPREADSHEET_ID &&
      (process.env.GOOGLE_SERVICE_ACCOUNT_JSON ||
        (process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL && process.env.GOOGLE_PRIVATE_KEY)),
  );
}

function googleSheetName() {
  return process.env.GOOGLE_SHEETS_SHEET_NAME || "Attendance";
}

function googleCredentials() {
  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    const parsed = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    return {
      clientEmail: parsed.client_email,
      privateKey: parsed.private_key?.replace(/\\n/g, "\n"),
    };
  }

  return {
    clientEmail: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    privateKey: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
  };
}

function base64Url(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

async function googleToken() {
  if (googleAccessToken && googleAccessToken.expiresAt > Date.now() + 60_000) {
    return googleAccessToken.token;
  }

  const { clientEmail, privateKey } = googleCredentials();
  if (!clientEmail || !privateKey) {
    throw new Error("Google service account credentials are incomplete");
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = base64Url(
    JSON.stringify({
      iss: clientEmail,
      scope: GOOGLE_SHEETS_SCOPE,
      aud: "https://oauth2.googleapis.com/token",
      exp: nowSeconds + 3600,
      iat: nowSeconds,
    }),
  );
  const unsigned = `${header}.${claim}`;
  const signature = cryptoSign(unsigned, privateKey);
  const assertion = `${unsigned}.${signature}`;

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  const json = await response.json();
  if (!response.ok) {
    throw new Error(`Google auth failed: ${json.error_description || json.error}`);
  }

  googleAccessToken = {
    token: json.access_token,
    expiresAt: Date.now() + Number(json.expires_in || 3600) * 1000,
  };
  return googleAccessToken.token;
}

function cryptoSign(value, privateKey) {
  const signer = createSign("RSA-SHA256");
  signer.update(value);
  signer.end();
  return signer
    .sign(privateKey)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

async function googleFetch(pathname, options = {}) {
  const token = await googleToken();
  const response = await fetch(`https://sheets.googleapis.com/v4${pathname}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      `Google Sheets request failed: ${json.error?.message || response.statusText}`,
    );
  }
  return json;
}

function sheetRange(range) {
  return `'${googleSheetName().replace(/'/g, "''")}'!${range}`;
}

async function ensureGoogleSheet() {
  const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
  const spreadsheet = await googleFetch(`/spreadsheets/${spreadsheetId}`);
  const sheetExists = spreadsheet.sheets?.some(
    (sheet) => sheet.properties?.title === googleSheetName(),
  );

  if (!sheetExists) {
    await googleFetch(`/spreadsheets/${spreadsheetId}:batchUpdate`, {
      method: "POST",
      body: JSON.stringify({
        requests: [{ addSheet: { properties: { title: googleSheetName() } } }],
      }),
    });
  }

  const headerRange = encodeURIComponent(sheetRange("A1:K1"));
  const values = await googleFetch(
    `/spreadsheets/${spreadsheetId}/values/${headerRange}`,
  );
  const currentHeaders = values.values?.[0] || [];
  if (!currentHeaders.length) {
    await googleFetch(
      `/spreadsheets/${spreadsheetId}/values/${headerRange}?valueInputOption=RAW`,
      {
        method: "PUT",
        body: JSON.stringify({ values: [ATTENDANCE_HEADERS] }),
      },
    );
  }
}

function sheetRowsFromValues(values) {
  const headers = values[0] || ATTENDANCE_HEADERS;
  return values.slice(1).map((cells) => {
    const row = Object.fromEntries(
      headers.map((header, index) => [header, cells[index] || ""]),
    );
    if (!row.created_at && row.timestamp) row.created_at = row.timestamp;
    if (!row.updated_at && row.timestamp) row.updated_at = row.timestamp;
    return row;
  });
}

function sheetRowValues(row) {
  return ATTENDANCE_HEADERS.map((header) => row[header] || "");
}

async function readSheetAttendance() {
  const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
  await ensureGoogleSheet();
  const range = encodeURIComponent(sheetRange("A:K"));
  const values = await googleFetch(`/spreadsheets/${spreadsheetId}/values/${range}`);
  return sheetRowsFromValues(values.values || [ATTENDANCE_HEADERS]);
}

async function upsertSheetAttendance(entry) {
  const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
  await ensureGoogleSheet();

  const range = encodeURIComponent(sheetRange("A:K"));
  const values = await googleFetch(`/spreadsheets/${spreadsheetId}/values/${range}`);
  const rows = sheetRowsFromValues(values.values || [ATTENDANCE_HEADERS]);
  const existingIndex = rows.findIndex(
    (row) =>
      row.event_uid === entry.event_uid &&
      row.event_start === entry.event_start &&
      row.slack_user_id === entry.slack_user_id,
  );
  const now = new Date().toISOString();
  const nextRow = {
    created_at: rows[existingIndex]?.created_at || now,
    updated_at: now,
    event_uid: entry.event_uid,
    event_title: entry.event_title,
    event_start: entry.event_start,
    group: entry.group,
    status: entry.status,
    slack_user_id: entry.slack_user_id,
    name: entry.name,
    channel_id: entry.channel_id,
    message_ts: entry.message_ts,
  };

  if (existingIndex >= 0) {
    const sheetRowNumber = existingIndex + 2;
    const updateRange = encodeURIComponent(sheetRange(`A${sheetRowNumber}:K${sheetRowNumber}`));
    await googleFetch(
      `/spreadsheets/${spreadsheetId}/values/${updateRange}?valueInputOption=USER_ENTERED`,
      {
        method: "PUT",
        body: JSON.stringify({ values: [sheetRowValues(nextRow)] }),
      },
    );
    return { action: "updated" };
  }

  await googleFetch(
    `/spreadsheets/${spreadsheetId}/values/${range}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
    {
      method: "POST",
      body: JSON.stringify({ values: [sheetRowValues(nextRow)] }),
    },
  );
  return { action: "created" };
}

async function ensureDataFiles() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    await fs.access(ATTENDANCE_PATH);
  } catch {
    await fs.writeFile(ATTENDANCE_PATH, `${ATTENDANCE_HEADERS.join(",")}\n`, "utf8");
  }
  try {
    await fs.access(POSTS_PATH);
  } catch {
    await fs.writeFile(POSTS_PATH, "{}\n", "utf8");
  }
}

async function readAttendance() {
  await ensureDataFiles();
  const text = await fs.readFile(ATTENDANCE_PATH, "utf8");
  const lines = text.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length <= 1) return [];
  const headers = parseCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const cells = parseCsvLine(line);
    const row = Object.fromEntries(
      headers.map((header, index) => [header, cells[index] || ""]),
    );
    if (!row.created_at && row.timestamp) row.created_at = row.timestamp;
    if (!row.updated_at && row.timestamp) row.updated_at = row.timestamp;
    return row;
  });
}

async function writeAttendance(rows) {
  await ensureDataFiles();
  const lines = [
    ATTENDANCE_HEADERS.join(","),
    ...rows.map((row) =>
      ATTENDANCE_HEADERS.map((header) => csvEscape(row[header])).join(","),
    ),
  ];
  await fs.writeFile(ATTENDANCE_PATH, `${lines.join("\n")}\n`, "utf8");
}

async function upsertCsvAttendance(entry) {
  const rows = await readAttendance();
  const existing = rows.find(
    (row) =>
      row.event_uid === entry.event_uid &&
      row.event_start === entry.event_start &&
      row.slack_user_id === entry.slack_user_id,
  );
  const now = new Date().toISOString();
  const updated = {
    created_at: existing?.created_at || now,
    updated_at: now,
    event_uid: entry.event_uid,
    event_title: entry.event_title,
    event_start: entry.event_start,
    group: entry.group,
    status: entry.status,
    slack_user_id: entry.slack_user_id,
    name: entry.name,
    channel_id: entry.channel_id,
    message_ts: entry.message_ts,
  };

  if (existing) {
    Object.assign(existing, updated);
    await writeAttendance(rows);
  } else {
    rows.push(updated);
    await writeAttendance(rows);
  }
}

async function readStoredAttendance() {
  if (googleSheetsEnabled()) {
    return readSheetAttendance();
  }
  return readAttendance();
}

async function upsertAttendance(entry) {
  if (googleSheetsEnabled()) {
    return upsertSheetAttendance(entry);
  }
  await upsertCsvAttendance(entry);
  return { action: "updated" };
}

async function attendanceSummary(eventUid, eventStart) {
  const rows = await readStoredAttendance();
  const matching = rows.filter(
    (row) => row.event_uid === eventUid && row.event_start === eventStart,
  );
  return {
    yes: matching.filter((row) => row.status === "yes"),
    no: matching.filter((row) => row.status === "no"),
  };
}

async function readPosts() {
  await ensureDataFiles();
  return JSON.parse(await fs.readFile(POSTS_PATH, "utf8"));
}

async function writePosts(posts) {
  await ensureDataFiles();
  await fs.writeFile(POSTS_PATH, `${JSON.stringify(posts, null, 2)}\n`, "utf8");
}

function matchesRoute(event, route) {
  const filters = route.filter
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  const haystack = [event.summary, event.location, event.description]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return filters.some((filter) => haystack.includes(filter));
}

function eventUid(key, event) {
  const recurrenceId = event.recurrenceid
    ? new Date(event.recurrenceid).toISOString()
    : "";
  return [event.uid || key, recurrenceId].filter(Boolean).join("#");
}

async function fetchKlubraumEvents() {
  requireEnv("KLUBRAUM_ICS_URL");
  let parsed;
  try {
    parsed = await nodeIcal.async.fromURL(process.env.KLUBRAUM_ICS_URL);
  } catch (err) {
    throw new Error(
      `Could not fetch KLUBRAUM_ICS_URL: ${err.message || String(err)}`,
    );
  }
  return Object.entries(parsed)
    .filter(([, event]) => event?.type === "VEVENT" && event.start)
    .map(([key, event]) => ({
      uid: eventUid(key, event),
      title: String(event.summary || "Untitled Klubraum event"),
      start: new Date(event.start).toISOString(),
      end: event.end ? new Date(event.end).toISOString() : "",
      location: event.location || "",
      description: event.description || "",
      raw: event,
    }))
    .sort((a, b) => new Date(a.start) - new Date(b.start));
}

function dueOnDay(events, route, day) {
  return events.filter((event) => {
    if (!matchesRoute(event.raw, route)) return false;
    const start = DateTime.fromISO(event.start, { zone: "utc" }).setZone(TZ);
    return start.hasSame(day, "day") && start >= day.startOf("day");
  });
}

function formatWhen(iso) {
  return DateTime.fromISO(iso, { zone: "utc" })
    .setZone(TZ)
    .toFormat("ccc d LLL, HH:mm");
}

function namesLine(rows) {
  return rows.length
    ? rows.map((row) => escapeMrkdwn(row.name)).join(", ")
    : "_None yet_";
}

function escapeMrkdwn(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function buildBlocks(event, route) {
  const summary = await attendanceSummary(event.uid, event.start);
  const location = event.location ? `\n*Where:* ${event.location}` : "";
  const text = `*${event.title}*\n*When:* ${formatWhen(event.start)}${location}\n*Group:* ${route.label}`;
  const basePayload = {
    event_uid: event.uid,
    event_title: event.title,
    event_start: event.start,
    event_location: event.location || "",
    group: route.key,
  };

  return {
    text: `${event.title} - ${formatWhen(event.start)}`,
    blocks: [
      { type: "section", text: { type: "mrkdwn", text } },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "Yes" },
            style: "primary",
            action_id: "sheet_attendance_yes",
            value: JSON.stringify({ ...basePayload, status: "yes" }),
          },
          {
            type: "button",
            text: { type: "plain_text", text: "No" },
            style: "danger",
            action_id: "sheet_attendance_no",
            value: JSON.stringify({ ...basePayload, status: "no" }),
          },
        ],
      },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: `*Yes:* ${namesLine(summary.yes)}\n*No:* ${namesLine(summary.no)}`,
          },
        ],
      },
    ],
  };
}

async function slackName(client, userId, fallback) {
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

async function postDueEvents(
  client,
  { dryRun = false, targetDay = targetDayFromArgs() } = {},
) {
  const events = await fetchKlubraumEvents();
  const posts = await readPosts();
  const results = [];

  for (const route of ROUTES) {
    const dueEvents = dueOnDay(events, route, targetDay);
    for (const event of dueEvents) {
      const postKey = `${route.key}:${route.channel}:${event.uid}:${event.start}`;
      if (posts[postKey]) {
        results.push({
          route: route.key,
          title: event.title,
          action: "already-posted",
        });
        continue;
      }
      if (dryRun) {
        results.push({
          route: route.key,
          title: event.title,
          start: event.start,
          channel: route.channel,
          action: "would-post",
        });
        continue;
      }

      const message = await buildBlocks(event, route);
      const posted = await client.chat.postMessage({
        channel: route.channel,
        text: message.text,
        blocks: message.blocks,
      });
      posts[postKey] = {
        channel: route.channel,
        ts: posted.ts,
        posted_at: new Date().toISOString(),
      };
      results.push({
        route: route.key,
        title: event.title,
        action: "posted",
        ts: posted.ts,
      });
    }
  }

  if (!dryRun) await writePosts(posts);
  return results;
}

async function main() {
  requireEnv("SLACK_BOT_TOKEN");
  await ensureDataFiles();

  const webClient = new WebClient(process.env.SLACK_BOT_TOKEN);

  if (process.argv.includes("--dry-run")) {
    const results = await postDueEvents(webClient, { dryRun: true });
    console.log(JSON.stringify(results, null, 2));
    return;
  }

  if (
    process.argv.includes("--post-now") &&
    !process.argv.includes("--serve")
  ) {
    const results = await postDueEvents(webClient);
    console.log(JSON.stringify(results, null, 2));
    return;
  }

  requireEnv("SLACK_APP_TOKEN");
  const slack = new SlackApp({
    token: process.env.SLACK_BOT_TOKEN,
    appToken: process.env.SLACK_APP_TOKEN,
    socketMode: true,
  });

  slack.action(/^sheet_attendance_/, async ({ ack, body, client }) => {
    await ack();
    const action = body.actions?.[0];
    const payload = JSON.parse(action?.value || "{}");
    const userId = body.user?.id;
    if (!payload.event_uid || !payload.status || !userId) return;

    const name = await slackName(client, userId, body.user?.name);
    await upsertAttendance({
      event_uid: payload.event_uid,
      event_title: payload.event_title,
      event_start: payload.event_start,
      group: payload.group,
      status: payload.status,
      slack_user_id: userId,
      name,
      channel_id: body.channel?.id || "",
      message_ts: body.message?.ts || "",
    });

    const route = ROUTES.find((item) => item.key === payload.group);
    if (route && body.channel?.id && body.message?.ts) {
      const message = await buildBlocks(
        {
          uid: payload.event_uid,
          title: payload.event_title,
          start: payload.event_start,
          location: payload.event_location || "",
        },
        route,
      );
      await client.chat.update({
        channel: body.channel.id,
        ts: body.message.ts,
        text: message.text,
        blocks: message.blocks,
      });
    }
  });

  await slack.start();
  console.log("No-database calendar bot running in Socket Mode");
  console.log(`Attendance CSV: ${ATTENDANCE_PATH}`);

  cron.schedule(
    process.env.CALENDAR_POST_CRON || "0 9 * * *",
    async () => {
      try {
        const results = await postDueEvents(slack.client);
        console.log("Day-of calendar post check complete", results);
      } catch (err) {
        console.error("Day-of calendar post check failed", err);
      }
    },
    { timezone: TZ },
  );

  if (process.argv.includes("--post-now")) {
    const results = await postDueEvents(slack.client);
    console.log(JSON.stringify(results, null, 2));
  }
}

try {
  await main();
} catch (err) {
  console.error(err.message || err);
  process.exit(1);
}
