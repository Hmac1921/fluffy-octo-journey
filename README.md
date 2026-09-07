# Slack Club Calendar

This is a small Express + Slack Bolt app that imports a Klubraum iCal feed,
posts upcoming calendar events to Slack, records Yes/No RSVPs with respondent
names, exposes ICS feeds for teams, and provides a Slack App Home UI for
creating events.

Quick start (Windows PowerShell):

1. Copy `.env.example` -> `.env` and fill values.
2. Install dependencies:

```powershell
npm install express @slack/bolt pg rrule ical-generator luxon dotenv
```

3. Run the server:

```powershell
npm start
```

4. Run migrations:

```powershell
npm run migrate
```

5. Health check:

```powershell
Invoke-RestMethod http://localhost:3000/health
```

6. Import Klubraum events immediately:

```powershell
Invoke-RestMethod -Method Post http://localhost:3000/admin/klubraum/import `
  -Headers @{ "X-ADMIN-SECRET" = $env:ADMIN_SECRET } `
  -ContentType "application/json" `
  -Body "{}"
```

7. Import and post upcoming calendar updates to Slack:

```powershell
Invoke-RestMethod -Method Post http://localhost:3000/admin/post-calendar-updates `
  -Headers @{ "X-ADMIN-SECRET" = $env:ADMIN_SECRET } `
  -ContentType "application/json" `
  -Body '{ "limit": 5, "days": 30 }'
```

Notes:

- The DB schema is in `sql/schema.sql`. The sample SQL uses `gen_random_uuid()`.
  Ensure your Postgres server has the `pgcrypto` extension or change to
  `uuid_generate_v4()` (uuid-ossp) or generate UUIDs in the app.
- Add tokens for ICS access using the `/admin/token/create` endpoint.
- Set `KLUBRAUM_TEAM_ID` to the team row that should receive imported events.
- Set that team's `slack_channel_id`, or set `SLACK_DEFAULT_CHANNEL`, before
  posting Slack updates.
- Slack RSVP buttons update the original message with Yes/No name lists.

## No-database Slack + spreadsheet mode

This mode reads directly from the Klubraum iCal feed, posts day-of training
messages to Slack, and stores RSVPs in Google Sheets or an Excel-compatible CSV
file instead of Postgres.

Configure:

```powershell
FWIP_CHANNEL_ID=C0BSB3XL77D
BTEAM_CHANNEL_ID=your-b-team-channel-id
ATEAM_CHANNEL_ID=your-a-team-channel-id
CTEAM_CHANNEL_ID=your-c-team-channel-id
FWIP_FILTER=fw/ip
BTEAM_FILTER=b-team,b team,bteam
ATEAM_FILTER=a-team,a team,ateam
CTEAM_FILTER=c-team,c team,cteam
CALENDAR_POST_CRON=0 9 * * *
SPREADSHEET_DIR=data
GOOGLE_SHEETS_SPREADSHEET_ID=your-google-sheet-id
GOOGLE_SHEETS_SHEET_NAME=Attendance
GOOGLE_AVAILABILITY_SHEET_NAME=Availability
GOOGLE_SERVICE_ACCOUNT_EMAIL=your-service-account@project.iam.gserviceaccount.com
GOOGLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
```

Use a Google Drive Desktop or OneDrive synced folder for `SPREADSHEET_DIR` if
you want `attendance.csv` to appear in Drive/Excel automatically. If
`GOOGLE_SHEETS_SPREADSHEET_ID` and service-account credentials are set, RSVPs
go directly to the Google Sheet instead.

Google Sheets setup:

1. Create a Google Cloud service account.
2. Create a key for it and copy the service account email/private key into env
   vars.
3. Share the Google Sheet with the service account email as an editor.
4. The bot will create/use an `Attendance` tab and keep one row per
   `event_uid + event_start + slack_user_id`.

Users can change their answer by pressing the other Slack button. The same row
is updated with the new `status`, `updated_at`, Slack user id, and Slack display
name.

Users can also press `Availability` on a training post to save a recurring
availability rule, for example unavailable every Thursday from a start date to
the end of term. When Google Sheets credentials are configured, these rules are
stored in the `Availability` tab. Without Google Sheets credentials they are
stored in `data/availability.csv`.

Dry-run today's routing without posting:

```powershell
npm run dry-run:nodb
```

Dry-run tomorrow's routing without posting:

```powershell
npm run dry-run:tomorrow:nodb
```

Dry-run a specific date:

```powershell
node src/no_db_calendar.js --dry-run --date=2026-08-30
```

Post today's due events once:

```powershell
npm run post:nodb
```

Run the scheduled Socket Mode bot:

```powershell
npm run start:nodb
```

The scheduled bot checks at `09:00` Europe/Stockholm time by default. It posts
FW/IP, B-team, A-team, and C-team matching events only to their configured
Slack channels.

Limit a manual dry-run or post to one or more routes:

```powershell
node src/no_db_calendar.js --dry-run --days-ahead=1 --route=ateam,cteam
node src/no_db_calendar.js --post-now --days-ahead=1 --route=ateam,cteam
```

Render deployment:

- Web service HTTP trigger and Slack RSVP listener: `node no_db_calendar.js --serve`
- Cron job for posting only: `npm run post:nodb`
- Optional background worker for Slack RSVP buttons when the web service is not
  running with `--serve`: `npm run start:nodb`

The web service exposes `GET /health` and `POST /trigger/post`. Set
`TRIGGER_SECRET` in Render, then call either:

```text
POST https://your-render-service.onrender.com/trigger/post
Header: X-TRIGGER-SECRET: your-secret
```

or, for cron services that only support URL hits:

```text
GET https://your-render-service.onrender.com/trigger/post?secret=your-secret
```

Attendance API:

```text
GET  https://your-render-service.onrender.com/api/attendance?secret=your-secret
GET  https://your-render-service.onrender.com/api/attendance.csv?secret=your-secret
POST https://your-render-service.onrender.com/api/attendance/sync?secret=your-secret
GET  https://your-render-service.onrender.com/api/availability?secret=your-secret
GET  https://your-render-service.onrender.com/api/availability.csv?secret=your-secret
POST https://your-render-service.onrender.com/api/availability?secret=your-secret
GET  https://your-render-service.onrender.com/api/events?from=2026-09-01&to=2026-12-20&secret=your-secret
```

The JSON and CSV endpoints can be used by Google Apps Script, Excel, or other
sync tools. Optional filters are `group`, `status`, `event_uid`, `event_start`,
`from`, `to`, and `source`. `source` can be `stored`, `csv`, or `sheet`.

The sync endpoint pushes rows into Google Sheets using the service account
credentials. By default it syncs from local `attendance.csv`; use
`source=stored` or `source=sheet` only when that is intentional.

The events endpoint expands the Klubraum iCal feed across a date range, so a
whole term can be pulled into Sheets. Add `route=fwip,bteam,ateam,cteam` to
limit which training groups are returned.

A Render cron job exits after posting, so it cannot receive button clicks
later. Keep either the `--serve` process or the Socket Mode worker running if
you want Google Sheet updates from Slack responses, but do not run both as
listeners at the same time.
