import "dotenv/config";
import nodeIcal from "node-ical";
import { DateTime } from "luxon";

const TZ = process.env.TZ || "Europe/Stockholm";

function argValue(name) {
  const prefix = `--${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : "";
}

const days = Number(argValue("days")) || 7;
const startArg = argValue("start");
const startDay = startArg
  ? DateTime.fromISO(startArg, { zone: TZ })
  : DateTime.now().setZone(TZ);

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

function matchesRoute(event, route) {
  const filters = route.filter
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  const haystack = [event.summary, event.location, event.description]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return filters.filter((filter) => haystack.includes(filter));
}

function eventUid(key, event) {
  const recurrenceId = event.recurrenceid
    ? new Date(event.recurrenceid).toISOString()
    : "";
  return [event.uid || key, recurrenceId].filter(Boolean).join("#");
}

async function fetchEvents(url) {
  const parsed = await nodeIcal.async.fromURL(url);
  return Object.entries(parsed)
    .filter(([, event]) => event?.type === "VEVENT" && event.start)
    .map(([key, event]) => ({
      key,
      uid: eventUid(key, event),
      summary: event.summary || "",
      start: new Date(event.start).toISOString(),
      end: event.end ? new Date(event.end).toISOString() : "",
      location: event.location || "",
      description: event.description || "",
      raw: event,
    }))
    .sort((a, b) => new Date(a.start) - new Date(b.start));
}

function inRange(event, from, to) {
  const start = DateTime.fromISO(event.start, { zone: "utc" })
    .setZone(TZ)
    .startOf("day");
  return start >= from.startOf("day") && start <= to.startOf("day");
}

async function main() {
  const url = process.env.KLUBRAUM_ICS_URL;
  if (!url) {
    console.error("KLUBRAUM_ICS_URL not set");
    process.exit(2);
  }
  const events = await fetchEvents(url);
  const toDay = startDay.plus({ days: days - 1 });
  const inRangeEvents = events.filter((e) => inRange(e, startDay, toDay));

  const out = inRangeEvents.map((e) => ({
    uid: e.uid,
    title: e.summary,
    start: e.start,
    location: e.location,
    matches: ROUTES.map((r) => ({
      route: r.key,
      matched: matchesRoute(e.raw, r),
    })),
  }));

  console.log(
    JSON.stringify(
      { start: startDay.toISODate(), days, count: out.length, events: out },
      null,
      2,
    ),
  );
}

await main();
