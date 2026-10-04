# Rolling PPL

A phone-first, chest-prioritized rolling Push/Pull/Legs workout tracker. The sequence advances when a workout is finished instead of resetting every Monday, so missed days never create makeup work.

## Features

- Persistent next-workout sequence with start, elapsed-time, and finish controls
- Free sessions with exercises chosen as you go, shared progression targets, and no change to the queued programme workout
- Separate Train, Food, Progress, Sessions, and Plan destinations, with focused workout tabs inside Train
- A one-tap food log: meals, snacks, shakes and a supplement checklist, compared with weekly weight change
- Gym-readable exercise rows with work sets, optional warm-ups, rest, cues, and click-to-enlarge public-domain photos
- Crash-safe workout drafts and completed sessions with optional peer-to-peer browser sync
- Previous-session context, per-set target placeholders, and double-progression suggestions
- Edit or delete past sessions (times, bodyweight, notes, exercises, and sets) from Sessions
- A post-workout summary with sets, volume and new load/rep records
- Optional bodyweight and session notes
- Responsive bodyweight, recorded-volume, and working-weight plots with readable axes, selectable points, previous/next reading controls, and accessible data tables
- Session frequency, recent lift history, and genuine load/rep milestones
- Automatic Autumn sync when a workout is saved, with a clear synced/failed status and Try again
- Workout-history export and restore in structured JSON or spreadsheet-ready CSV, including workout timing, bodyweight, and notes
- Light and dark themes with a remembered toggle
- Installable PWA with offline workout access
- Warm-up, progression, rest, and safety guidance
- Responsive static build for GitHub Pages

## Food log

**Food** is deliberately low effort. Tap + for each meal, snack or shake and tick off supplements. The rule of thumb: **on a plate or in a bowl = meal; eaten from your hand = snack.** Consistency matters more than precision. Use the arrows or the last-7-days strip to fill in a day you forgot. There are no calories, food search or streaks.

A day counts as logged once anything is tapped, and averages use logged days only, so skipping the app never reads as eating nothing. **Food and weight** compares rolling seven-day weeks: average meals, snacks and shakes beside the change in average weight from the week before (within ±0.2 kg is steady). A week is compared only when it has at least 4 logged days and 3 weigh-ins, plus 3 weigh-ins in the week before. Once two comparable weeks share a trend, it shows what a typical day looked like in weeks you gained, held steady or lost.

Food records sync between paired devices and are included in complete backups. Each day is one record; the latest saved edit wins.

## Body progress, photos, and training phases

The Progress overview connects your goal, weight trend, measurements, photos and training phase. Record independent weigh-ins without starting a workout. Each local calendar day contributes one reading; an independent entry takes precedence over workout bodyweight. Seven-day averages count only recorded days.

Set a goal weight and optionally select suggested intermediate milestones. First reached and sustained are separate achievements. Sustained means a trailing seven-day average at or above the target with at least three recorded days. Gaps are allowed; missing readings are never invented.

Short-term outlooks extend recent bodyweight, top working weight and tape trends over 2, 3 or 4 weeks. They use median pairwise slopes and a widening residual-based scenario range, not a calibrated probability or a target. Weight needs 6 recorded days spanning 14 days; lifts need 4 sessions spanning 14 days; tape needs 4 recorded days spanning 21 days. Old, insufficient or implausibly changing data show an explanation instead of an estimate. Working-weight outlooks preserve the entered load convention, show reps for context, and do not estimate maximum strength.

Progress photos are compressed and kept in the dedicated `rolling-ppl-progress-photos` IndexedDB database. Captures inside the app are not written to the phone gallery. Imported originals remain wherever selected. Camera capture requires HTTPS or localhost and permission. The app does not estimate measurements or body fat from photos. Browser storage is private to this site/browser profile, not an encrypted vault; clearing site data or losing the device can lose the local copy.

**Progress → Photos → Storage and backups → Cloud backup** offers optional private cloud backup. Sign in once and enable backup; new photos save locally first and upload automatically while the app is open and online. Each photo shows **Backed up** or **Backup pending**. Existing device photos need one explicit **Back up existing photos** action. After clearing browser data or changing phones, sign in to the same account and choose **Recover photos**. Removing a device copy keeps its cloud backup unless you explicitly select cloud deletion. Pausing or signing out keeps local copies. An upload still pending cannot be recovered from the cloud.

Cloud photo and records backup use separate AWS S3, Cognito and serverless API resources. The public configuration contains no AWS credentials. See [deployment and recovery instructions](infra/photo-backup/README.md). Cloud backup defaults to 500 photos and 1 GiB per account and is metered by AWS usage; local exports remain useful as a separate copy.

When you open an outlook, the app saves a ready forecast at most once a week per metric. **Compare with forecast from** shows that fixed original forecast alongside recorded results and the latest projection. New readings never rewrite the original. Forecasts start when this feature is used; the app does not invent predictions for earlier dates. Saved forecasts live locally and are included in complete backups.

**Data → Backup** downloads workouts, active drafts, plans, food log, body records, goals, measurements, saved forecasts and optionally photos. Credentials and pairing keys are excluded. Keep the file outside this browser; the displayed timestamp means a download started, not that an external backup was verified. **Data → Restore** validates and merges complete backups or workout-history files, preserving unrelated records. Matching workout IDs use the backup copy; body records use their latest saved version. An existing active workout stays intact; restoring into an empty browser recovers the saved draft. **Data → Workout export** provides workout-only JSON/CSV transfers.

Independent weigh-ins, tape measurements, goals, workouts and training phases use device sync. Photos use explicit file backups or optional account-based cloud backup; they are not sent through device sync. Saved forecasts travel through complete backups. Body edits and deletions merge by record identity and saved timestamp. Update both paired browsers before exchanging this expanded data.

Complete backups have a 300 MiB limit; photo backups support up to 1,000 photos and 256 MiB per file. For larger collections, download a records backup and export photo batches by view/date from **Progress → Photos → Storage and backups**. Individual photos can be downloaded from their preview. A records backup cannot recover photos.

**Plan** supports whole programmes: Push/Pull/Legs, Upper/Lower, Full body, or your own ordered sequence of 1–12 named workouts. Edit exercises and prescriptions, then save a named phase. Prior phases remain available. Workouts retain their starting programme, sequence and prescriptions; later changes do not rewrite completed sessions or change an active session's plan.

Training and body tracking run in the offline-capable PWA without an account. Only optional cloud photo backup requires signing in. Install from Chrome on Android or Safari's Add to Home Screen on iPhone. Backups remain necessary even when persistent browser storage is granted.

## Cloud records backup

**Data → Backup → Cloud backup** keeps an automatic copy of workouts, active drafts, plans, the food log, body records, goals, measurements and saved forecasts in the same private account as photo backup. Photos are not included; they use photo backup. Turn it on per browser. It uploads about 30 seconds after a change (at most one upload every 30 seconds while logging), straight away when the app is hidden, and again when the app reopens or comes back online if anything is still waiting. Unchanged records are not re-sent, and a browser with no records never uploads.

Each browser uploads only its own copy, identified by a random ID kept in that browser. A cleared or half-synced browser therefore never replaces another browser's backup. The cloud keeps each browser's latest copy plus its last copy of every UTC day for 90 days. **Data → Restore → Restore from cloud** lists every browser's copy with its workout, food-day and weigh-in counts. Pick the latest or a daily copy, check it, then restore. Restoring merges like a downloaded complete backup and never deletes local records.

The copy is a gzip-compressed records-only complete backup (at most 4 MiB compressed; up to 20 browsers per account). Cloud records backup needs the backup stack from this commit or later; redeploy with `infra/photo-backup/deploy.sh`.

## Local development

Requires Node 22.18 or newer (unit tests import TypeScript directly). Browser regression scripts use isolated Chrome contexts. Run `scripts/test-body-progress.mjs` for logging, camera cleanup and backup/restore; `scripts/test-progress-outlooks.mjs` for synthetic outlooks and a custom programme. Set `PLAYWRIGHT_MODULE` to an installed Playwright module URL and `PROGRESS_TEST_URL` to the running server (these scripts default to port 4187; the dev server uses 4173). For a built preview, `PROGRESS_TEST_PRODUCTION=1` adds offline restoration checks to the body-progress script. Test artifacts stay under ignored `outputs/`.

`scripts/test-cloud-records-backup.mjs` checks records backup sign-in, upload throttling, upload on hide, the empty-browser guard and cloud restore with a mocked account. `scripts/test-cloud-photo-backup.mjs` exercises sign-in, upload retry, recovery, account isolation and deletion with mocked cloud services and synthetic photos. It never uses a personal browser profile or uploads real images. The backend's `test-live.mjs` verifies deployed AWS storage separately. Local development needs a matching callback/origin configuration to use live cloud sign-in; the checked-in config targets the published PWA.

`scripts/test-forecast-history.mjs` checks original/current/recorded curves, immutable backup merges, reload persistence, and saved forecasts with sparse or deleted current history at desktop and phone widths.

```bash
npm install
npm run dev
```

The dev server runs at `http://127.0.0.1:4173`, an origin already allowed by Autumn. Build the production site with `npm run build`; output is written to `dist/`.

## Free sessions

In **Train**, choose **Start free session**, then **Add exercise**. Search the shared 876-exercise library by name, muscle or equipment, preview an exercise, and choose **Use this exercise**. Alternatives such as pulldowns and pull-ups are separate choices with their own histories. Programme exercises keep their set/rep prescriptions; other exercises start with editable logging defaults. Targets use the latest logged sets for that exact exercise name. The logger records reps, not timed holds or distances.

**Plan → Choose from exercise library** uses the same catalogue and previews. Choosing a definition keeps that plan row's sets, reps, rest and priority. Type a custom name in a plan or use **Create** in the free-session search. Custom exercises become reusable after saving a plan or finishing a session, and travel with the existing backup/device-sync records.

Exercise definitions are separate from prescriptions. The public-domain Free Exercise DB snapshot is bundled for offline search; its images load only when a preview or exercise card is displayed. Downloaded library images are cached separately and retained across app upgrades. An unseen image needs internet; missing images do not block logging. The original programme's images remain bundled and available offline. Existing names, storage keys, plans, records and backup schemas are preserved; adopting the library does not rewrite history.

Upstream definitions and image URLs are pinned to a commit. To deliberately refresh the catalogue, run `node scripts/import-exercise-catalog.mjs <full-upstream-commit-sha>` and review the changes and identity mappings in `src/exerciseLibrary.ts`. Keep older exercise identities available if upstream ever removes a record. Source license: `src/data/FREE-EXERCISE-DB-LICENSE.md`.

Save exercises and finish as usual. The session appears in Sessions and updates the same lift history used by your main programme, while your queued programme workout stays next. Selections and entered sets recover after a reload and are included in device sync and backups. An exercise with entered sets cannot be removed until those sets are cleared.

## Edit past sessions

Open **Sessions > Edit session**. To remove a session logged by mistake, open **Session details > Delete session**; its sets leave lift history on every paired browser, and an Autumn record is not deleted. Correct the start/end time, bodyweight, note, loads, or reps; add missed exercises/sets or remove incorrect entries. **Save changes** updates the session and its progression history together. **Cancel editing** discards the draft. Existing session and set IDs are preserved, and the active workout and next-workout sequence stay intact. If the session changes on another device while the editor is open, reopen it before saving.

Edits sync to paired Rolling PPL browsers. An existing Autumn receipt is retained, but the Autumn record is not updated automatically; correct that record separately.

## Autumn sync

Open **More → Autumn**, connect with an Autumn username/password or API token, and choose the current gym project. The password is used only for sign-in and is never stored. The returned token stays in that browser and is excluded from Rolling PPL backups.

Once connected, each saved workout is sent automatically. The workout summary shows Sending, Synced, or the failure reason with **Try again**; the Autumn button shows a count of failed sessions. Sessions from the last three days that never reached Autumn (closed tab, offline) are retried when the app opens or comes back online. Autumn deduplicates by session ID, so retries never create duplicates.

## Sync your phone and laptop

Open **Devices → Show my QR** on your laptop. On your phone, open **Devices → Scan QR code**, allow the camera, and point it at the laptop. The browsers link and start syncing automatically; no copied link or extra approval is needed. The code authorizes one browser, expires after five minutes, and can be cancelled or closed. The camera stops after a successful scan, when you close the scanner, or when the app moves into the background. **Use a pairing link instead** remains available when a camera is unavailable. After an update, refresh both browsers and show a fresh QR. The scanner uses a full-width square view, compact QR data, and native QR detection where available, with a pixel decoder fallback.

Keep the app open on both devices for the first sync. Approved browsers reconnect automatically when available; **Sync now** retries a connection. Each paired browser shows whether it is connected, whether it is up to date, and when its last sync was acknowledged. **Pause sync** stops networking while local logging continues.

Workout history, bodyweight, notes, entered sets, active workouts, exercise save checkpoints, and the next workout travel between browsers. The app keeps a complete local copy in each browser. There is no central workout database and no sync account. Autumn credentials and display preferences stay in their original browser. Devices cannot fetch updates while every browser holding those updates is closed or suspended; mobile browsers should be kept in the foreground during a transfer.

Stable workout and set identities prevent duplicate records when a transfer repeats. Automerge exchanges missing changes and combines edits to different fields. Independent edits to the same field remain available under **Changes to review** until you choose the correct value. Deletions are recorded so a stale browser cannot silently restore a deleted record. Independently logging the same real workout twice still creates two distinct records.

Every browser has a private ECDH key stored in IndexedDB. Pairing authenticates the exchanged public keys with a temporary secret; subsequent connections authenticate paired keys and encrypt transfers. PeerJS Cloud provides signaling, with STUN used to discover connection routes. The default configuration does not provide a TURN relay: restrictive firewalls or some mobile networks may prevent connection. Try the same Wi-Fi on both devices if they cannot connect. Connection setup services do not store workout history.

Use **Remove** beside a paired device to stop syncing with it. Removal records reach other connected paired browsers and propagate to offline browsers when they reconnect. Already received copies cannot be erased remotely. To rejoin after removal, the removed browser creates a new identity when pairing again. If it was removed while offline and never received the notice, use **How device sync works → Reset browser pairing** first; this keeps its workouts. Pair each additional browser with at least one existing device; changes can pass through devices as they reconnect.

The sync store is kept locally in IndexedDB as a compacted document plus small incremental changes, alongside the original one-time migration snapshot. A synchronous recovery journal protects edits while database commits finish. A peer is acknowledged only after received changes are saved. Keep using **Data → Workout export** for independent backups; normal JSON/CSV exports contain workout data, not device private keys or the complete merge history. Use one Rolling PPL tab per browser profile while logging or syncing.

Validation: `npm test`, `npm run typecheck`, `npm run lint`, and `npm run build`. The optional `node scripts/test-peer-sync.mjs` browser check uses Playwright with installed Chrome in isolated contexts and synthetic data. Install Playwright separately or set `PLAYWRIGHT_MODULE` to its module URL. Run the dev server first; `SYNC_TEST_URL` overrides its URL. Set `SYNC_TEST_PRODUCTION=1` when testing a production preview to also verify service-worker offline reload. Screenshots are saved under ignored `outputs/peer-sync/`. `node scripts/test-pairing-scanner.mjs` verifies QR decoding, automatic linking, and camera cleanup using synthetic camera frames in isolated browsers (no webcam access). Camera cases use `SCANNER_FRAME=720x1280` (default), `1080x1920`, or `1280x720`; `SCANNER_QR_TOP=1` checks an off-center code. QR frames are scaled down and slightly blurred to exercise phone-like input.

Development references: [Automerge](https://automerge.org/docs/reference/documents/conflicts/), [PeerJS](https://peerjs.com/client/getting-started), and [WebRTC security](https://www.rfc-editor.org/rfc/rfc8827.html).

The Progress tab plots up to 24 bodyweight readings. Volume is the sum of recorded numeric load × reps for each exercise session, while working weight is the heaviest completed set. Exercise selections are remembered per chart. Dumbbell values stay as entered (per dumbbell), and bodyweight/text loads are excluded from kilogram charts.

Both JSON and current CSV backups restore workout-level bodyweight and notes. Older lift-only Rolling PPL CSV files remain importable; they simply contain no workout metadata to restore.

Under **Data**, choose **Workout export** or **Restore**. Export with **Download**, **Share…** (the device share sheet: Drive, WhatsApp, email, AirDrop and other installed apps) or **Copy to clipboard**. Choose JSON for workout history including sync receipts, or CSV for spreadsheets. Use **Data → Backup** for the complete app including body records and photos.

**Share…** opens the device share sheet, where you pick the app; browsers cannot preselect a share target, and available apps depend on the device and file type. The button only appears where the browser can share files. No transfer option opens a provider website. When file sharing is unavailable, use Download or Copy to clipboard and attach or paste the backup in the app. Desktop browsers (and any device that has refused a JSON share once) receive JSON as `.json.txt` — Edge on Windows reports it can share `.json` but then refuses — which this app imports without renaming. Import from a cloud provider in the device file picker, a saved attachment, or pasted JSON/CSV. Imports merge by record ID and preserve unrelated history.

Workouts are timed and completed locally first. Autumn sync then posts one completed session with the original start/end timestamps and a stable UUID, so an interrupted retry cannot create a duplicate.

This project provides general workout organization and technique reminders, not medical care.

Exercise images come from [Free Exercise DB](https://github.com/yuhonas/free-exercise-db), released under the Unlicense/public domain dedication.
