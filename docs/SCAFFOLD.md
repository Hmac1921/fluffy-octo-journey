# Scaffolded TypeScript + React client

What I added:

- A pnpm workspace entry (`pnpm-workspace.yaml`) and `.npmrc` pinned to pnpm.
- Root `tsconfig.json` to support TypeScript compilation for server and client.
- `client/` — a Vite + React + TypeScript scaffold (dev/build/preview scripts).
- `.env.example` with placeholders for required secrets.
- Convenience scripts in the root `package.json` to install and run the client.

Next steps to integrate the frontend with the backend:

1. Convert or wrap parts of `src/index.js` into TypeScript (e.g. `src/server.ts`).
2. Add backend API endpoints like `/api/events` and `/api/events/:id/attendance`.
3. In `client/src/App.tsx` fetch from those endpoints and implement attendance UI.
4. Add Slack message templates that post the next event to channels with interactive buttons.

How to run locally:

1. Install dependencies at the repo root:

```bash
pnpm install
```

2. Install and run the client:

```bash
cd client
pnpm install
pnpm dev
```

3. Start the existing backend (it is still JavaScript for now):

```bash
pnpm start
```

If you want I can now:

- Convert the server to TypeScript (`src/server.ts`) and wire API endpoints for events and attendance.
- Implement the Slack workflow to post next training and collect attendance via button actions.
- Build out the React UI to list events and attendance and to allow marking attendance.

Tell me which of those you want next and provide any Slack/DB credentials when you're ready.
