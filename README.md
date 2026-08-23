# Rolling PPL

A phone-first, chest-prioritized rolling Push/Pull/Legs workout tracker. The sequence advances when a workout is finished instead of resetting every Monday, so missed days never create makeup work.

## Features

- Persistent next-workout sequence with start, elapsed-time, and finish controls
- Three focused workout tabs
- Gym-readable exercise rows with work sets, optional warm-ups, rest, cues, and click-to-enlarge public-domain photos
- Crash-safe workout drafts and device-local completed sessions
- Previous-session context, per-set target placeholders, and double-progression suggestions
- Optional bodyweight and session notes
- Session frequency, bodyweight trend, recent lift history, and genuine load/rep milestones
- Direct completed-session sync to an Autumn project with idempotent retries
- Workout-history export and restore in structured JSON or spreadsheet-ready CSV
- Light and dark themes with a remembered toggle
- Installable PWA with offline workout access
- Warm-up, progression, rest, and safety guidance
- Responsive static build for GitHub Pages

## Local development

```bash
npm install
npm run dev
```

The dev server runs at `http://127.0.0.1:4173`, an origin already allowed by Autumn. Build the production site with `npm run build`; output is written to `dist/`.

## Autumn sync

Open **Autumn** in the app, connect with an Autumn username/password or API token, and choose the current gym project. The password is used only for sign-in and is never stored. The returned token stays in that browser and is excluded from Rolling PPL backups.

Workouts are timed and completed locally first. **Sync to Autumn** then posts one completed session with the original start/end timestamps and a stable UUID, so an interrupted retry cannot create a duplicate.

This project provides general workout organization and technique reminders, not medical care.

Exercise images come from [Free Exercise DB](https://github.com/yuhonas/free-exercise-db), released under the Unlicense/public domain dedication.
