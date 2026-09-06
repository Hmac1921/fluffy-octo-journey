#!/usr/bin/env bash
set -euo pipefail
# Run the calendar poster once using the TZ env var (default Europe/Stockholm)
export TZ="${TZ:-Europe/Stockholm}"
node src/no_db_calendar.js --post-now
