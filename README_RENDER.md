Deploying the Slack club calendar poster as a scheduled job on Render

Goal

- Run `node src/no_db_calendar.js --post-now` once per day automatically so the club posts are created without a persistent Socket Mode process.

Overview

- We'll run the repository as a Render "cron job" (scheduled job) that executes a small shell wrapper. The job will run the script in the repository using the `TZ` environment variable so dates are evaluated in the club timezone.

Files added

- `scripts/run_post.sh` — simple wrapper that exports `TZ` (defaults to `Europe/Stockholm`) and runs the poster.

Environment variables required on Render

- `SLACK_BOT_TOKEN` — your bot token (xoxb-...)
- `SLACK_APP_TOKEN` — your app-level token (xapp-...) (not required if not using socket mode but present in code)
- `KLUBRAUM_ICS_URL` — the Klubraum ICS URL to read events from
- `FWIP_CHANNEL_ID` — channel ID where FW/IP posts should go
- `BTEAM_CHANNEL_ID` — channel ID where B-team posts should go
- `TZ` — optional; default `Europe/Stockholm`

Render setup (UI)

1. Create a new "Cron Job" service in Render (Dashboard → New → Cron Job).
2. Point the repo to this GitHub repo (or use the repo already connected).
3. Set the schedule to the desired cron expression (example: `0 09 * * *` to run at 09:00 server time daily).
   - If you want the job to run at 09:00 Europe/Stockholm, choose the schedule accordingly or set `TZ` to `Europe/Stockholm` and pick a time in UTC that maps correctly. (Render's cron takes the timezone from the instance — using `TZ` in the job is safer.)
4. Build command: `pnpm install --frozen-lockfile && pnpm run build || true` (or leave blank if not needed).
5. Start command: `bash scripts/run_post.sh` (Render will run this command at each scheduled time).
6. Add the required environment variables (see list above) in Render's Dashboard for the Cron Job.
7. Save and enable the job.

Render setup (render.yaml, optional)

- If you prefer a `render.yaml` manifest, you can add one and configure a `Cron Job` section. I can provide a manifest if you'd like.

Testing locally

- To test locally with your environment values (temporary):

```powershell
$env:KLUBRAUM_ICS_URL='https://ical...'
$env:FWIP_CHANNEL_ID='C0BSB3XL77D'
$env:BTEAM_CHANNEL_ID='C0BS204RVAT'
$env:SLACK_BOT_TOKEN='xoxb-...'
$env:SLACK_APP_TOKEN='xapp-...'
$env:TZ='Europe/Stockholm'
node src/no_db_calendar.js --post-now
```

Next steps I can take for you

- Create a `render.yaml` manifest for one-click deploy.
- Add a small health-check endpoint (optional) and a lightweight web service if you prefer a Web Service rather than Cron Job.
- Guide you through adding the Cron Job in the Render dashboard and populating env vars.

Which would you like me to do next? (I can prepare a `render.yaml`, or walk you through Render UI steps interactively.)
