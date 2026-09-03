# Rolling PPL

A phone-first, chest-prioritized rolling Push/Pull/Legs workout tracker. The sequence advances when a workout is finished instead of resetting every Monday, so missed days never create makeup work.

## Features

- Persistent next-workout sequence with start, elapsed-time, and finish controls
- Separate Train and Progress destinations, with three focused workout tabs inside Train
- Gym-readable exercise rows with work sets, optional warm-ups, rest, cues, and click-to-enlarge public-domain photos
- Crash-safe workout drafts and device-local completed sessions
- Previous-session context, per-set target placeholders, and double-progression suggestions
- Optional bodyweight and session notes
- Full-width bodyweight chart plus exercise-selectable recorded-volume and working-weight charts
- Session frequency, recent lift history, and genuine load/rep milestones
- Header-accessible Autumn connection modal and direct completed-session sync with idempotent retries
- Workout-history export and restore in structured JSON or spreadsheet-ready CSV, including workout timing, bodyweight, and notes
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

Open **Autumn** from the header, connect with an Autumn username/password or API token, and choose the current gym project. The password is used only for sign-in and is never stored. The returned token stays in that browser and is excluded from Rolling PPL backups.

The Progress tab plots up to 24 bodyweight readings. Volume is the sum of recorded numeric load × reps for each exercise session, while working weight is the heaviest completed set. Exercise selections are remembered per chart. Dumbbell values stay as entered (per dumbbell), and bodyweight/text loads are excluded from kilogram charts.

Both JSON and current CSV backups restore workout-level bodyweight and notes. Older lift-only Rolling PPL CSV files remain importable; they simply contain no workout metadata to restore.

Under **Data**, choose **Export to** or **Import from**. Export destinations include download, Google Drive, OneDrive, WhatsApp, ChatGPT, clipboard, and the device share sheet (for email, AirDrop, and other installed apps). Choose JSON for a full backup including sync receipts, or CSV for spreadsheets.

Tapping an export app immediately opens the device share sheet, where you select the installed app. Browsers cannot preselect a share target, and available apps depend on the device and file type. No transfer option opens a provider website. When file sharing is unavailable, use Download or Copy to clipboard and attach or paste the backup in the app. If a browser cannot share JSON directly, the share sheet receives the same backup as `.json.txt`, which this app can import without renaming. Import from a cloud provider in the device file picker, a saved attachment, or pasted JSON/CSV. Imports merge by record ID and preserve unrelated history.

Workouts are timed and completed locally first. **Sync to Autumn** then posts one completed session with the original start/end timestamps and a stable UUID, so an interrupted retry cannot create a duplicate.

This project provides general workout organization and technique reminders, not medical care.

Exercise images come from [Free Exercise DB](https://github.com/yuhonas/free-exercise-db), released under the Unlicense/public domain dedication.
