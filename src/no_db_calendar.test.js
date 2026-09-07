import test from "node:test";
import assert from "node:assert/strict";
import { DateTime } from "luxon";

import {
  parseAvailabilityRows,
  isUserUnavailableForEvent,
  dueOnDay,
} from "./no_db_calendar.js";

test("parseAvailabilityRows reads valid availability rows", () => {
  const rows = parseAvailabilityRows(
    "slack_user_id,weekday,reason,active\nU123,tuesday,work,yes\nU456,wednesday,holiday,no\n",
  );

  assert.deepEqual(rows, [
    {
      created_at: "",
      updated_at: "",
      slack_user_id: "U123",
      name: "",
      weekday: "tuesday",
      reason: "work",
      starts_on: "",
      ends_on: "",
      active: true,
    },
    {
      created_at: "",
      updated_at: "",
      slack_user_id: "U456",
      name: "",
      weekday: "wednesday",
      reason: "holiday",
      starts_on: "",
      ends_on: "",
      active: false,
    },
  ]);
});

test("isUserUnavailableForEvent matches weekday overrides case-insensitively", () => {
  const rows = [
    { slack_user_id: "U123", weekday: "Tuesday", reason: "work", active: true },
    {
      slack_user_id: "U999",
      weekday: "Thursday",
      reason: "travelling",
      active: true,
    },
  ];

  assert.equal(
    isUserUnavailableForEvent("U123", "2026-09-08T19:00:00Z", rows),
    true,
  );
  assert.equal(
    isUserUnavailableForEvent("U123", "2026-09-09T19:00:00Z", rows),
    false,
  );
  assert.equal(
    isUserUnavailableForEvent("U999", "2026-09-09T19:00:00Z", rows),
    false,
  );
});

test("isUserUnavailableForEvent respects term date ranges", () => {
  const rows = [
    {
      slack_user_id: "U123",
      weekday: "Thursday",
      starts_on: "2026-09-01",
      ends_on: "2026-12-20",
      active: true,
    },
  ];

  assert.equal(
    isUserUnavailableForEvent("U123", "2026-09-10T17:00:00Z", rows),
    true,
  );
  assert.equal(
    isUserUnavailableForEvent("U123", "2027-01-07T17:00:00Z", rows),
    false,
  );
});

test("dueOnDay expands non-excluded recurring events", () => {
  const recurringEvent = {
    uid: "training-series",
    title: "Training B-Team",
    start: "2026-08-09T10:30:00.000Z",
    end: "2026-08-09T12:30:00.000Z",
    raw: {
      summary: "Training B-Team",
      rrule: {
        between(start, end) {
          return [new Date("2026-09-06T10:30:00.000Z")].filter(
            (occurrence) => occurrence >= start && occurrence <= end,
          );
        },
      },
      exdate: {},
    },
  };

  const events = dueOnDay(
    [recurringEvent],
    { filter: "b-team" },
    DateTime.fromISO("2026-09-06", { zone: "Europe/Stockholm" }),
  );

  assert.equal(events.length, 1);
  assert.equal(events[0].start, "2026-09-06T10:30:00.000Z");
});
