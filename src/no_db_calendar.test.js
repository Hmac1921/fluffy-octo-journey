import test from "node:test";
import assert from "node:assert/strict";

import {
  parseAvailabilityRows,
  isUserUnavailableForEvent,
} from "./no_db_calendar.js";

test("parseAvailabilityRows reads valid availability rows", () => {
  const rows = parseAvailabilityRows(
    "slack_user_id,weekday,reason,active\nU123,tuesday,work,yes\nU456,wednesday,holiday,no\n",
  );

  assert.deepEqual(rows, [
    {
      slack_user_id: "U123",
      weekday: "tuesday",
      reason: "work",
      active: true,
    },
    {
      slack_user_id: "U456",
      weekday: "wednesday",
      reason: "holiday",
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
