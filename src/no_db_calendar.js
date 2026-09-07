import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createSign } from "node:crypto";
import express from "express";
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
const AVAILABILITY_HEADERS = [
  "created_at",
  "updated_at",
  "slack_user_id",
  "name",
  "weekday",
  "reason",
  "starts_on",
  "ends_on",
  "active",
];
const GOOGLE_SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets";
let googleAccessToken = null;
let httpServer = null;
let keepAliveTimer = null;
const WEEKDAY_OPTIONS = [
  { key: "monday", label: "Monday" },
  { key: "tuesday", label: "Tuesday" },
  { key: "wednesday", label: "Wednesday" },
  { key: "thursday", label: "Thursday" },
  { key: "friday", label: "Friday" },
  { key: "saturday", label: "Saturday" },
  { key: "sunday", label: "Sunday" },
];
const DEFAULT_TERM_DAYS = Number(process.env.DEFAULT_TERM_DAYS || 120);

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
  {
    key: "ateam",
    label: "A-team",
    channel: process.env.ATEAM_CHANNEL_ID || "",
    filter: process.env.ATEAM_FILTER || "a-team,a team,ateam",
  },
  {
    key: "cteam",
    label: "C-team",
    channel: process.env.CTEAM_CHANNEL_ID || "",
    filter: process.env.CTEAM_FILTER || "c-team,c team,cteam",
  },
].filter((route) => route.channel);

function requireEnv(name) {
  if (!process.env[name]) {
    throw new Error(`${name} is required`);
  }
}

function triggerAllowed(req) {
  const secret = process.env.TRIGGER_SECRET;
  if (!secret) return false;
  return req.get("X-TRIGGER-SECRET") === secret || req.query.secret === secret;
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

function routeKeysFromArgs() {
  return argValue("route")
    .split(",")
    .map((route) => route.trim().toLowerCase())
    .filter(Boolean);
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
      (process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL &&
        process.env.GOOGLE_PRIVATE_KEY)),
  );
}

function googleSheetName() {
  return process.env.GOOGLE_SHEETS_SHEET_NAME || "Attendance";
}

function googleAvailabilitySheetName() {
  return process.env.GOOGLE_AVAILABILITY_SHEET_NAME || "Availability";
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
    throw new Error(
      `Google auth failed: ${json.error_description || json.error}`,
    );
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

function sheetRange(range, sheetName = googleSheetName()) {
  return `'${sheetName.replace(/'/g, "''")}'!${range}`;
}

async function ensureGoogleSheet(
  sheetName = googleSheetName(),
  headers = ATTENDANCE_HEADERS,
) {
  const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
  const spreadsheet = await googleFetch(`/spreadsheets/${spreadsheetId}`);
  const sheetExists = spreadsheet.sheets?.some(
    (sheet) => sheet.properties?.title === sheetName,
  );

  if (!sheetExists) {
    await googleFetch(`/spreadsheets/${spreadsheetId}:batchUpdate`, {
      method: "POST",
      body: JSON.stringify({
        requests: [{ addSheet: { properties: { title: sheetName } } }],
      }),
    });
  }

  const lastColumn = columnName(headers.length);
  const headerRange = encodeURIComponent(
    sheetRange(`A1:${lastColumn}1`, sheetName),
  );
  const values = await googleFetch(
    `/spreadsheets/${spreadsheetId}/values/${headerRange}`,
  );
  const currentHeaders = values.values?.[0] || [];
  if (!currentHeaders.length) {
    await googleFetch(
      `/spreadsheets/${spreadsheetId}/values/${headerRange}?valueInputOption=RAW`,
      {
        method: "PUT",
        body: JSON.stringify({ values: [headers] }),
      },
    );
  }
}

function columnName(index) {
  let value = index;
  let name = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    value = Math.floor((value - 1) / 26);
  }
  return name;
}

function sheetRowsFromValues(values, defaultHeaders = ATTENDANCE_HEADERS) {
  const headers = values[0] || defaultHeaders;
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

function availabilitySheetRowValues(row) {
  return AVAILABILITY_HEADERS.map((header) => row[header] || "");
}

async function readSheetAttendance() {
  const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
  await ensureGoogleSheet();
  const range = encodeURIComponent(sheetRange("A:K"));
  const values = await googleFetch(
    `/spreadsheets/${spreadsheetId}/values/${range}`,
  );
  return sheetRowsFromValues(values.values || [ATTENDANCE_HEADERS]);
}

async function readSheetAvailability() {
  const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
  await ensureGoogleSheet(googleAvailabilitySheetName(), AVAILABILITY_HEADERS);
  const lastColumn = columnName(AVAILABILITY_HEADERS.length);
  const range = encodeURIComponent(
    sheetRange(`A:${lastColumn}`, googleAvailabilitySheetName()),
  );
  const values = await googleFetch(
    `/spreadsheets/${spreadsheetId}/values/${range}`,
  );
  return sheetRowsFromValues(values.values || [AVAILABILITY_HEADERS], AVAILABILITY_HEADERS)
    .map((row) => normalizeAvailabilityRow(row))
    .filter((row) => row.slack_user_id && row.weekday);
}

async function upsertSheetAttendance(entry) {
  const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
  await ensureGoogleSheet();

  const range = encodeURIComponent(sheetRange("A:K"));
  const values = await googleFetch(
    `/spreadsheets/${spreadsheetId}/values/${range}`,
  );
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
    const updateRange = encodeURIComponent(
      sheetRange(`A${sheetRowNumber}:K${sheetRowNumber}`),
    );
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

async function upsertSheetAvailability(entry) {
  const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
  await ensureGoogleSheet(googleAvailabilitySheetName(), AVAILABILITY_HEADERS);

  const lastColumn = columnName(AVAILABILITY_HEADERS.length);
  const range = encodeURIComponent(
    sheetRange(`A:${lastColumn}`, googleAvailabilitySheetName()),
  );
  const values = await googleFetch(
    `/spreadsheets/${spreadsheetId}/values/${range}`,
  );
  const rows = sheetRowsFromValues(values.values || [AVAILABILITY_HEADERS], AVAILABILITY_HEADERS)
    .map((row) => normalizeAvailabilityRow(row))
    .filter((row) => row.slack_user_id && row.weekday);
  const weekday = normalizeWeekdayKey(entry.weekday);
  const existingIndex = rows.findIndex(
    (row) =>
      row.slack_user_id === entry.slack_user_id && row.weekday === weekday,
  );
  const now = new Date().toISOString();
  const nextRow = {
    created_at: rows[existingIndex]?.created_at || now,
    updated_at: now,
    slack_user_id: entry.slack_user_id,
    name: entry.name || rows[existingIndex]?.name || "",
    weekday,
    reason: entry.reason || "",
    starts_on: entry.starts_on || "",
    ends_on: entry.ends_on || "",
    active: entry.active ? "true" : "false",
  };

  if (existingIndex >= 0) {
    const sheetRowNumber = existingIndex + 2;
    const updateRange = encodeURIComponent(
      sheetRange(
        `A${sheetRowNumber}:${lastColumn}${sheetRowNumber}`,
        googleAvailabilitySheetName(),
      ),
    );
    await googleFetch(
      `/spreadsheets/${spreadsheetId}/values/${updateRange}?valueInputOption=USER_ENTERED`,
      {
        method: "PUT",
        body: JSON.stringify({ values: [availabilitySheetRowValues(nextRow)] }),
      },
    );
    return nextRow;
  }

  await googleFetch(
    `/spreadsheets/${spreadsheetId}/values/${range}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
    {
      method: "POST",
      body: JSON.stringify({ values: [availabilitySheetRowValues(nextRow)] }),
    },
  );
  return nextRow;
}

function normalizeWeekdayKey(value) {
  const key = String(value || "")
    .trim()
    .toLowerCase();
  const map = {
    mon: "monday",
    monday: "monday",
    tue: "tuesday",
    tues: "tuesday",
    tuesday: "tuesday",
    wed: "wednesday",
    weds: "wednesday",
    wednesday: "wednesday",
    thu: "thursday",
    thurs: "thursday",
    thursday: "thursday",
    fri: "friday",
    friday: "friday",
    sat: "saturday",
    saturday: "saturday",
    sun: "sunday",
    sunday: "sunday",
  };
  return map[key] || key;
}

function weekdayLabel(value) {
  const key = normalizeWeekdayKey(value);
  return WEEKDAY_OPTIONS.find((item) => item.key === key)?.label || value;
}

function weekdayKeyFromDate(date) {
  return WEEKDAY_OPTIONS[date.weekday - 1]?.key || "";
}

function normalizeAvailabilityRow(row = {}) {
  const activeValue = String(row.active ?? "")
    .trim()
    .toLowerCase();
  return {
    created_at: row.created_at || row.timestamp || "",
    updated_at: row.updated_at || row.timestamp || "",
    slack_user_id: String(row.slack_user_id || "").trim(),
    name: String(row.name || "").trim(),
    weekday: normalizeWeekdayKey(row.weekday),
    reason: String(row.reason || "").trim(),
    starts_on: String(row.starts_on || "").trim(),
    ends_on: String(row.ends_on || "").trim(),
    active:
      row.active === true ||
      activeValue === "yes" ||
      activeValue === "true" ||
      activeValue === "1" ||
      activeValue === "y" ||
      activeValue === "on",
  };
}

function parseAvailabilityRows(text) {
  const source = String(text || "").trim();
  if (!source) return [];

  const lines = source.split(/\r?\n/).filter(Boolean);
  if (lines.length <= 1) return [];

  const headers = parseCsvLine(lines[0]).map((header) =>
    header.trim().toLowerCase(),
  );
  return lines
    .slice(1)
    .map((line) => {
      const values = parseCsvLine(line);
      const row = Object.fromEntries(
        headers.map((header, index) => [header, values[index] || ""]),
      );

      return normalizeAvailabilityRow(row);
    })
    .filter((row) => row.slack_user_id && row.weekday);
}

function isUserUnavailableForEvent(slackUserId, eventStartIso, rows = []) {
  if (!slackUserId || !eventStartIso) return false;

  const eventDate = DateTime.fromISO(eventStartIso, { zone: "utc" }).setZone(
    TZ,
  );
  const eventWeekday = weekdayKeyFromDate(eventDate);
  const eventDay = eventDate.toISODate();

  return rows.some((row) => {
    if (String(row.slack_user_id).trim() !== String(slackUserId).trim())
      return false;
    if (!row.active) return false;
    if (row.starts_on && eventDay < row.starts_on) return false;
    if (row.ends_on && eventDay > row.ends_on) return false;
    return (
      normalizeWeekdayKey(row.weekday) === normalizeWeekdayKey(eventWeekday)
    );
  });
}

async function ensureDataFiles() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    await fs.access(ATTENDANCE_PATH);
  } catch {
    await fs.writeFile(
      ATTENDANCE_PATH,
      `${ATTENDANCE_HEADERS.join(",")}\n`,
      "utf8",
    );
  }
  try {
    await fs.access(POSTS_PATH);
  } catch {
    await fs.writeFile(POSTS_PATH, "{}\n", "utf8");
  }
  try {
    await fs.access(path.join(DATA_DIR, "availability.csv"));
  } catch {
    await fs.writeFile(
      path.join(DATA_DIR, "availability.csv"),
      `${AVAILABILITY_HEADERS.join(",")}\n`,
      "utf8",
    );
  }
}

async function readCsvAvailabilityRules() {
  await ensureDataFiles();
  const availabilityPath = path.join(DATA_DIR, "availability.csv");
  const text = await fs.readFile(availabilityPath, "utf8");
  return parseAvailabilityRows(text);
}

async function readAvailabilityRules() {
  if (googleSheetsEnabled()) {
    return readSheetAvailability();
  }
  return readCsvAvailabilityRules();
}

async function writeAvailabilityRules(rows) {
  await ensureDataFiles();
  const availabilityPath = path.join(DATA_DIR, "availability.csv");
  const lines = [
    AVAILABILITY_HEADERS.join(","),
    ...rows.map((row) =>
      AVAILABILITY_HEADERS.map((header) => csvEscape(row[header] ?? "")).join(
        ",",
      ),
    ),
  ];
  await fs.writeFile(availabilityPath, `${lines.join("\n")}\n`, "utf8");
}

async function upsertAvailabilityRule(entry) {
  if (googleSheetsEnabled()) {
    return upsertSheetAvailability(entry);
  }

  const rows = await readCsvAvailabilityRules();
  const weekday = normalizeWeekdayKey(entry.weekday);
  const existing = rows.find(
    (row) =>
      row.slack_user_id === entry.slack_user_id && row.weekday === weekday,
  );
  const now = new Date().toISOString();
  const updated = {
    created_at: existing?.created_at || now,
    updated_at: now,
    slack_user_id: entry.slack_user_id,
    name: entry.name || existing?.name || "",
    weekday,
    reason: entry.reason || "",
    starts_on: entry.starts_on || "",
    ends_on: entry.ends_on || "",
    active: entry.active ? "true" : "false",
  };

  if (existing) {
    Object.assign(existing, updated);
  } else {
    rows.push(updated);
  }

  await writeAvailabilityRules(rows);
  return updated;
}

function filterAvailabilityRows(rows, query = {}) {
  return rows.filter((row) => {
    if (query.slack_user_id && row.slack_user_id !== query.slack_user_id) {
      return false;
    }
    if (query.weekday && row.weekday !== normalizeWeekdayKey(query.weekday)) {
      return false;
    }
    if (query.active !== undefined) {
      const expected = String(query.active).toLowerCase();
      const isActive = Boolean(row.active === true || row.active === "true");
      if (
        (expected === "true" || expected === "1" || expected === "yes") !==
        isActive
      ) {
        return false;
      }
    }
    return true;
  });
}

function availabilityRowsToCsv(rows) {
  const lines = [
    AVAILABILITY_HEADERS.join(","),
    ...rows.map((row) =>
      AVAILABILITY_HEADERS.map((header) => csvEscape(row[header] ?? "")).join(
        ",",
      ),
    ),
  ];
  return `${lines.join("\n")}\n`;
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

function filterAttendanceRows(rows, query = {}) {
  return rows.filter((row) => {
    if (query.group && row.group !== query.group) return false;
    if (query.status && row.status !== query.status) return false;
    if (query.event_uid && row.event_uid !== query.event_uid) return false;
    if (query.event_start && row.event_start !== query.event_start) {
      return false;
    }
    if (query.from && row.event_start < query.from) return false;
    if (query.to && row.event_start > query.to) return false;
    return true;
  });
}

function attendanceRowsToCsv(rows) {
  const lines = [
    ATTENDANCE_HEADERS.join(","),
    ...rows.map((row) =>
      ATTENDANCE_HEADERS.map((header) => csvEscape(row[header] ?? "")).join(
        ",",
      ),
    ),
  ];
  return `${lines.join("\n")}\n`;
}

async function readAttendanceSource(source = "stored") {
  if (source === "csv") return readAttendance();
  if (source === "sheet") return readSheetAttendance();
  return readStoredAttendance();
}

async function syncAttendanceRowsToSheet(rows) {
  if (!googleSheetsEnabled()) {
    throw new Error(
      "Google Sheets sync is not configured. Set GOOGLE_SHEETS_SPREADSHEET_ID and service account credentials.",
    );
  }

  const results = [];
  for (const row of rows) {
    results.push(await upsertSheetAttendance(row));
  }
  return results;
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
  const availabilityRules = await readAvailabilityRules();
  const unavailable = availabilityRules
    .filter((row) =>
      isUserUnavailableForEvent(row.slack_user_id, eventStart, [row]),
    )
    .map((row) => ({
      slack_user_id: row.slack_user_id,
      name: row.name || row.slack_user_id,
      status: "no",
    }));
  const unavailableIds = new Set(
    unavailable.map((row) => String(row.slack_user_id)),
  );
  const noRows = [
    ...matching.filter((row) => row.status === "no"),
    ...unavailable.filter(
      (row) =>
        !matching.some(
          (match) =>
            match.status === "no" &&
            String(match.slack_user_id) === String(row.slack_user_id),
        ),
    ),
  ];
  return {
    yes: matching.filter(
      (row) => row.status === "yes" && !unavailableIds.has(row.slack_user_id),
    ),
    no: noRows,
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

function isExcludedOccurrence(event, occurrence) {
  return Object.values(event.exdate || {}).some(
    (excluded) => new Date(excluded).getTime() === occurrence.getTime(),
  );
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
  const dayStart = day.startOf("day").toUTC().toJSDate();
  const dayEnd = day.endOf("day").toUTC().toJSDate();

  return events.flatMap((event) => {
    if (!matchesRoute(event.raw, route)) return [];

    const occurrences = event.raw.rrule
      ? event.raw.rrule
          .between(dayStart, dayEnd, true)
          .filter((occurrence) => !isExcludedOccurrence(event.raw, occurrence))
      : [new Date(event.start)];

    return occurrences
      .filter((occurrence) => {
        const start = DateTime.fromJSDate(occurrence, { zone: "utc" }).setZone(
          TZ,
        );
        return start.hasSame(day, "day") && start >= day.startOf("day");
      })
      .map((occurrence) => {
        const duration =
          new Date(event.end).getTime() - new Date(event.start).getTime();
        return {
          ...event,
          uid: `${event.uid}#${occurrence.toISOString()}`,
          start: occurrence.toISOString(),
          end: new Date(occurrence.getTime() + duration).toISOString(),
        };
      });
  });
}

function routesFromKeys(routeKeys = []) {
  return routeKeys.length
    ? ROUTES.filter((route) => routeKeys.includes(route.key))
    : ROUTES;
}

function expandedEventsInRange(events, fromDay, toDay, routeKeys = []) {
  const routes = routesFromKeys(routeKeys);
  const results = [];
  let cursor = fromDay.startOf("day");
  const end = toDay.startOf("day");

  while (cursor <= end) {
    for (const route of routes) {
      for (const event of dueOnDay(events, route, cursor)) {
        results.push({
          route: route.key,
          group: route.label,
          channel: route.channel,
          event_uid: event.uid,
          event_title: event.title,
          event_start: event.start,
          event_end: event.end,
          event_location: event.location || "",
          when: formatWhen(event.start),
        });
      }
    }
    cursor = cursor.plus({ days: 1 });
  }

  return results.sort(
    (a, b) => new Date(a.event_start) - new Date(b.event_start),
  );
}

function dateQuery(value, fallback) {
  if (!value) return fallback;
  const parsed = DateTime.fromISO(String(value), { zone: TZ });
  if (!parsed.isValid) throw new Error(`Invalid date: ${value}`);
  return parsed;
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

function responsePayload(event, route, status, source = {}) {
  return JSON.stringify({
    event_uid: event.uid,
    event_title: event.title,
    event_start: event.start,
    event_location: event.location || "",
    group: route.key,
    status,
    channel_id: source.channel_id || "",
    message_ts: source.message_ts || "",
  });
}

function changePayload(event, route, source = {}) {
  return JSON.stringify({
    event_uid: event.uid,
    event_title: event.title,
    event_start: event.start,
    event_location: event.location || "",
    group: route.key,
    channel_id: source.channel_id || "",
    message_ts: source.message_ts || "",
  });
}

function responseButtons(event, route, source = {}) {
  return [
    {
      type: "button",
      text: { type: "plain_text", text: "Yes" },
      style: "primary",
      action_id: "sheet_attendance_yes",
      value: responsePayload(event, route, "yes", source),
    },
    {
      type: "button",
      text: { type: "plain_text", text: "No" },
      style: "danger",
      action_id: "sheet_attendance_no",
      value: responsePayload(event, route, "no", source),
    },
  ];
}

function sourceFromBody(body, payload = {}) {
  return {
    channel_id: payload.channel_id || body.channel?.id || "",
    message_ts: payload.message_ts || body.message?.ts || "",
  };
}

function eventFromPayload(payload) {
  return {
    uid: payload.event_uid,
    title: payload.event_title,
    start: payload.event_start,
    location: payload.event_location || "",
  };
}

function routeFromPayload(payload, source = {}) {
  const configured = ROUTES.find((item) => item.key === payload.group);
  if (configured) return configured;
  if (!payload.group) return null;

  return {
    key: payload.group,
    label: payload.group,
    channel: source.channel_id || payload.channel_id || "",
    filter: payload.group,
  };
}

function localDateFromIso(iso) {
  return DateTime.fromISO(iso, { zone: "utc" }).setZone(TZ).toISODate();
}

function defaultTermEndDate(startDate) {
  const configured = process.env.TERM_END_DATE;
  if (configured) return configured;
  return DateTime.fromISO(startDate, { zone: TZ })
    .plus({ days: DEFAULT_TERM_DAYS })
    .toISODate();
}

function plainOption(text, value) {
  return {
    text: { type: "plain_text", text },
    value,
  };
}

function availabilityModal(event, route, source) {
  const eventDate = localDateFromIso(event.start);
  const eventWeekday = weekdayKeyFromDate(
    DateTime.fromISO(event.start, { zone: "utc" }).setZone(TZ),
  );
  const weekdayOptions = WEEKDAY_OPTIONS.map((item) =>
    plainOption(item.label, item.key),
  );
  const selectedWeekday =
    weekdayOptions.find((item) => item.value === eventWeekday) ||
    weekdayOptions[0];

  return {
    type: "modal",
    callback_id: "availability_submit",
    private_metadata: changePayload(event, route, source),
    title: { type: "plain_text", text: "Availability" },
    submit: { type: "plain_text", text: "Save" },
    close: { type: "plain_text", text: "Cancel" },
    blocks: [
      {
        type: "input",
        block_id: "availability_status",
        label: { type: "plain_text", text: "Status" },
        element: {
          type: "static_select",
          action_id: "value",
          initial_option: plainOption("Unavailable every week", "unavailable"),
          options: [
            plainOption("Unavailable every week", "unavailable"),
            plainOption("Available again", "available"),
          ],
        },
      },
      {
        type: "input",
        block_id: "availability_weekday",
        label: { type: "plain_text", text: "Day" },
        element: {
          type: "static_select",
          action_id: "value",
          initial_option: selectedWeekday,
          options: weekdayOptions,
        },
      },
      {
        type: "input",
        block_id: "availability_starts_on",
        label: { type: "plain_text", text: "From" },
        element: {
          type: "datepicker",
          action_id: "value",
          initial_date: eventDate,
        },
      },
      {
        type: "input",
        block_id: "availability_ends_on",
        label: { type: "plain_text", text: "Until" },
        element: {
          type: "datepicker",
          action_id: "value",
          initial_date: defaultTermEndDate(eventDate),
        },
      },
      {
        type: "input",
        block_id: "availability_reason",
        optional: true,
        label: { type: "plain_text", text: "Reason" },
        element: {
          type: "plain_text_input",
          action_id: "value",
          placeholder: { type: "plain_text", text: "Optional" },
        },
      },
    ],
  };
}

async function buildBlocks(event, route) {
  const summary = await attendanceSummary(event.uid, event.start);
  const location = event.location ? `\n*Where:* ${event.location}` : "";
  const text = `*${event.title}*\n*When:* ${formatWhen(event.start)}${location}\n*Group:* ${route.label}`;

  return {
    text: `${event.title} - ${formatWhen(event.start)}`,
    blocks: [
      { type: "section", text: { type: "mrkdwn", text } },
      {
        type: "actions",
        elements: [
          ...responseButtons(event, route),
          {
            type: "button",
            text: { type: "plain_text", text: "Availability" },
            action_id: "availability_open",
            value: changePayload(event, route),
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

function changeResponseBlocks(event, route, source) {
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `Change your response for *${escapeMrkdwn(event.title)}*`,
      },
    },
    {
      type: "actions",
      elements: responseButtons(event, route, source),
    },
  ];
}

function savedResponseBlocks(event, route, source, status) {
  const responseText = status === "yes" ? "Yes" : "No";
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `Your response has been saved as *${responseText}* for *${escapeMrkdwn(event.title)}*.`,
      },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Change your response" },
          action_id: "sheet_attendance_change",
          value: changePayload(event, route, source),
        },
      ],
    },
  ];
}

function viewStateValue(view, blockId, actionId = "value") {
  return view.state?.values?.[blockId]?.[actionId];
}

function selectedViewValue(view, blockId) {
  return viewStateValue(view, blockId)?.selected_option?.value || "";
}

function dateViewValue(view, blockId) {
  return viewStateValue(view, blockId)?.selected_date || "";
}

function textViewValue(view, blockId) {
  return viewStateValue(view, blockId)?.value || "";
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
  const selectedRouteKeys = routeKeysFromArgs();
  const routes = selectedRouteKeys.length
    ? ROUTES.filter((route) => selectedRouteKeys.includes(route.key))
    : ROUTES;
  const results = [];

  for (const route of routes) {
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

  if (
    process.argv.includes("--serve") ||
    process.env.POST_TRIGGER_ENABLED === "1"
  ) {
    const app = express();
    app.use(express.json());
    const infoHandler = (_req, res) => {
      res.json({
        ok: true,
        service: "slack-club-calendar-no-db",
        endpoints: {
          health: "GET /health",
          post: "GET or POST /trigger/post?secret=...",
          attendance: "GET /api/attendance?secret=...",
          attendanceCsv: "GET /api/attendance.csv?secret=...",
          attendanceSync: "POST /api/attendance/sync?secret=...",
          availability: "GET or POST /api/availability?secret=...",
          availabilityCsv: "GET /api/availability.csv?secret=...",
          events: "GET /api/events?from=YYYY-MM-DD&to=YYYY-MM-DD&secret=...",
        },
      });
    };

    app.get("/", infoHandler);
    app.get("/health", (_req, res) => {
      res.json({ ok: true, mode: "trigger" });
    });

    const triggerHandler = async (req, res) => {
      try {
        if (!triggerAllowed(req)) {
          return res.status(401).json({
            error: "unauthorized",
            message:
              "Set TRIGGER_SECRET and pass it as X-TRIGGER-SECRET or ?secret=...",
          });
        }
        const results = await postDueEvents(webClient);
        res.json({ ok: true, results });
      } catch (err) {
        console.error("Trigger post failed", err);
        res.status(500).json({ error: err.message || String(err) });
      }
    };

    app.post("/trigger/post", triggerHandler);
    app.get("/trigger/post", triggerHandler);
    app.head("/trigger/post", (req, res) => {
      if (!triggerAllowed(req)) return res.sendStatus(401);
      return res.sendStatus(204);
    });
    app.post("/trigger-post", triggerHandler);
    app.get("/trigger-post", triggerHandler);
    app.post("/post-now", triggerHandler);
    app.get("/post-now", triggerHandler);

    const attendanceApiHandler = async (req, res) => {
      try {
        if (!triggerAllowed(req)) return res.sendStatus(401);
        const rows = filterAttendanceRows(
          await readAttendanceSource(String(req.query.source || "stored")),
          req.query,
        );
        res.json({
          ok: true,
          source: req.query.source || "stored",
          count: rows.length,
          rows,
        });
      } catch (err) {
        console.error("Attendance API failed", err);
        res.status(500).json({ error: err.message || String(err) });
      }
    };

    app.get("/api/attendance", attendanceApiHandler);

    app.get("/api/attendance.csv", async (req, res) => {
      try {
        if (!triggerAllowed(req)) return res.sendStatus(401);
        const rows = filterAttendanceRows(
          await readAttendanceSource(String(req.query.source || "stored")),
          req.query,
        );
        res
          .type("text/csv")
          .send(attendanceRowsToCsv(rows));
      } catch (err) {
        console.error("Attendance CSV API failed", err);
        res.status(500).json({ error: err.message || String(err) });
      }
    });

    app.post("/api/attendance/sync", async (req, res) => {
      try {
        if (!triggerAllowed(req)) return res.sendStatus(401);
        const source = String(req.query.source || "csv");
        const rows = filterAttendanceRows(
          await readAttendanceSource(source),
          req.query,
        );
        const results = await syncAttendanceRowsToSheet(rows);
        res.json({
          ok: true,
          source,
          count: rows.length,
          created: results.filter((item) => item.action === "created").length,
          updated: results.filter((item) => item.action === "updated").length,
        });
      } catch (err) {
        console.error("Attendance sync failed", err);
        res.status(500).json({ error: err.message || String(err) });
      }
    });

    app.get("/api/availability", async (req, res) => {
      try {
        if (!triggerAllowed(req)) return res.sendStatus(401);
        const rows = filterAvailabilityRows(
          await readAvailabilityRules(),
          req.query,
        );
        res.json({ ok: true, count: rows.length, rows });
      } catch (err) {
        console.error("Availability API failed", err);
        res.status(500).json({ error: err.message || String(err) });
      }
    });

    app.get("/api/availability.csv", async (req, res) => {
      try {
        if (!triggerAllowed(req)) return res.sendStatus(401);
        const rows = filterAvailabilityRows(
          await readAvailabilityRules(),
          req.query,
        );
        res
          .type("text/csv")
          .send(availabilityRowsToCsv(rows));
      } catch (err) {
        console.error("Availability CSV API failed", err);
        res.status(500).json({ error: err.message || String(err) });
      }
    });

    app.post("/api/availability", async (req, res) => {
      try {
        if (!triggerAllowed(req)) return res.sendStatus(401);
        if (!req.body?.slack_user_id || !req.body?.weekday) {
          return res.status(400).json({
            error: "slack_user_id and weekday are required",
          });
        }
        const row = await upsertAvailabilityRule({
          slack_user_id: String(req.body.slack_user_id),
          name: String(req.body.name || ""),
          weekday: String(req.body.weekday),
          reason: String(req.body.reason || ""),
          starts_on: String(req.body.starts_on || ""),
          ends_on: String(req.body.ends_on || ""),
          active: req.body.active !== false && req.body.active !== "false",
        });
        res.json({ ok: true, row });
      } catch (err) {
        console.error("Availability write failed", err);
        res.status(500).json({ error: err.message || String(err) });
      }
    });

    app.get("/api/events", async (req, res) => {
      try {
        if (!triggerAllowed(req)) return res.sendStatus(401);
        const today = DateTime.now().setZone(TZ);
        const from = dateQuery(req.query.from, today);
        const to = dateQuery(
          req.query.to,
          today.plus({ days: DEFAULT_TERM_DAYS }),
        );
        const routeKeys = String(req.query.route || "")
          .split(",")
          .map((route) => route.trim().toLowerCase())
          .filter(Boolean);
        const rows = expandedEventsInRange(
          await fetchKlubraumEvents(),
          from,
          to,
          routeKeys,
        );
        res.json({
          ok: true,
          from: from.toISODate(),
          to: to.toISODate(),
          count: rows.length,
          rows,
        });
      } catch (err) {
        console.error("Events API failed", err);
        res.status(500).json({ error: err.message || String(err) });
      }
    });

    const port = Number(process.env.PORT || 3000);
    httpServer = app.listen(port, () => {
      console.log(`HTTP trigger server listening on :${port}`);
      console.log("Use POST /trigger/post to post today's due events");
    });
    keepAliveTimer = setInterval(() => {}, 60 * 60 * 1000);
  }

  requireEnv("SLACK_APP_TOKEN");
  const slack = new SlackApp({
    token: process.env.SLACK_BOT_TOKEN,
    appToken: process.env.SLACK_APP_TOKEN,
    socketMode: true,
  });

  slack.action("availability_open", async ({ ack, body, client }) => {
    await ack();
    const action = body.actions?.[0];
    const payload = JSON.parse(action?.value || "{}");
    const source = sourceFromBody(body, payload);
    const route = routeFromPayload(payload, source);
    if (!payload.event_uid || !route || !body.trigger_id) return;

    await client.views.open({
      trigger_id: body.trigger_id,
      view: availabilityModal(
        eventFromPayload(payload),
        route,
        source,
      ),
    });
  });

  slack.view("availability_submit", async ({ ack, body, view, client }) => {
    const payload = JSON.parse(view.private_metadata || "{}");
    const source = sourceFromBody({}, payload);
    const route = routeFromPayload(payload, source);
    const userId = body.user?.id;
    const status = selectedViewValue(view, "availability_status");
    const weekday = selectedViewValue(view, "availability_weekday");
    const startsOn = dateViewValue(view, "availability_starts_on");
    const endsOn = dateViewValue(view, "availability_ends_on");
    const reason = textViewValue(view, "availability_reason");

    if (startsOn && endsOn && endsOn < startsOn) {
      await ack({
        response_action: "errors",
        errors: {
          availability_ends_on: "End date must be after the start date.",
        },
      });
      return;
    }

    await ack();
    if (!userId || !route || !weekday) return;

    const event = eventFromPayload(payload);
    const name = await slackName(client, userId, body.user?.name);
    const active = status !== "available";
    const row = await upsertAvailabilityRule({
      slack_user_id: userId,
      name,
      weekday,
      reason,
      starts_on: startsOn,
      ends_on: endsOn,
      active,
    });

    if (source.channel_id && source.message_ts) {
      const message = await buildBlocks(event, route);
      await client.chat.update({
        channel: source.channel_id,
        ts: source.message_ts,
        text: message.text,
        blocks: message.blocks,
      });
    }

    if (source.channel_id) {
      const savedText = active
        ? `Saved: unavailable every ${weekdayLabel(row.weekday)} from ${row.starts_on || "now"} to ${row.ends_on || "open ended"}.`
        : `Cleared: available again on ${weekdayLabel(row.weekday)}.`;
      await client.chat.postEphemeral({
        channel: source.channel_id,
        user: userId,
        text: savedText,
      });
    }
  });

  slack.action(/^sheet_attendance_/, async ({ ack, body, client }) => {
    await ack();
    const action = body.actions?.[0];
    const payload = JSON.parse(action?.value || "{}");
    const userId = body.user?.id;
    const source = sourceFromBody(body, payload);
    const route = routeFromPayload(payload, source);
    if (!payload.event_uid || !route || !userId) return;

    const event = eventFromPayload(payload);

    if (action?.action_id === "sheet_attendance_change") {
      if (!source.channel_id) return;
      await client.chat.postEphemeral({
        channel: source.channel_id,
        user: userId,
        text: `Change your response for ${payload.event_title}`,
        blocks: changeResponseBlocks(event, route, source),
      });
      return;
    }

    if (!payload.status) return;

    const availabilityRules = await readAvailabilityRules();
    const forcedStatus = isUserUnavailableForEvent(
      userId,
      payload.event_start,
      availabilityRules,
    )
      ? "no"
      : payload.status;

    const name = await slackName(client, userId, body.user?.name);
    await upsertAttendance({
      event_uid: payload.event_uid,
      event_title: payload.event_title,
      event_start: payload.event_start,
      group: payload.group,
      status: forcedStatus,
      slack_user_id: userId,
      name,
      channel_id: source.channel_id,
      message_ts: source.message_ts,
    });

    if (source.channel_id && source.message_ts) {
      const message = await buildBlocks(event, route);
      await client.chat.update({
        channel: source.channel_id,
        ts: source.message_ts,
        text: message.text,
        blocks: message.blocks,
      });
    }

    if (source.channel_id) {
      await client.chat.postEphemeral({
        channel: source.channel_id,
        user: userId,
        text: `Your response has been saved as ${forcedStatus}`,
        blocks: savedResponseBlocks(event, route, source, forcedStatus),
      });
    }
  });

  await slack.start();
  console.log("No-database calendar bot running in Socket Mode");
  console.log(
    `Attendance storage: ${googleSheetsEnabled() ? "Google Sheets" : "local CSV"}`,
  );
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

export { main, parseAvailabilityRows, isUserUnavailableForEvent, dueOnDay };

const isDirectRun =
  process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;

if (isDirectRun) {
  try {
    await main();
  } catch (err) {
    console.error(err.message || err);
    process.exit(1);
  }
}
