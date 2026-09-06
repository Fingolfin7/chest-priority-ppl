# Rolling PPL

A phone-first, chest-prioritized rolling Push/Pull/Legs workout tracker. The sequence advances when a workout is finished instead of resetting every Monday, so missed days never create makeup work.

## Features

- Persistent next-workout sequence with start, elapsed-time, and finish controls
- Separate Train, Progress, and Sessions destinations, with three focused workout tabs inside Train
- Gym-readable exercise rows with work sets, optional warm-ups, rest, cues, and click-to-enlarge public-domain photos
- Crash-safe workout drafts and completed sessions with optional peer-to-peer browser sync
- Previous-session context, per-set target placeholders, and double-progression suggestions
- Edit past session times, bodyweight, notes, exercises, and sets from Sessions
- Optional bodyweight and session notes
- Responsive bodyweight, recorded-volume, and working-weight plots with readable axes, selectable points, previous/next reading controls, and accessible data tables
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

## Edit past sessions

Open **Sessions > Edit session**. Correct the start/end time, bodyweight, note, loads, or reps; add missed exercises/sets or remove incorrect entries. **Save changes** updates the session and its progression history together. **Cancel editing** discards the draft. Existing session and set IDs are preserved, and the active workout and next-workout sequence stay intact. If the session changes on another device while the editor is open, reopen it before saving.

Edits sync to paired Rolling PPL browsers. An existing Autumn receipt is retained, but the Autumn record is not updated automatically; correct that record separately.

## Autumn sync

Open **Autumn** from the header, connect with an Autumn username/password or API token, and choose the current gym project. The password is used only for sign-in and is never stored. The returned token stays in that browser and is excluded from Rolling PPL backups.

## Sync your phone and laptop

Open **Devices → Show my QR** on your laptop. On your phone, open **Devices → Scan QR code**, allow the camera, and point it at the laptop. The browsers link and start syncing automatically; no copied link or extra approval is needed. The code authorizes one browser, expires after five minutes, and can be cancelled or closed. The camera stops after a successful scan, when you close the scanner, or when the app moves into the background. **Use a pairing link instead** remains available when a camera is unavailable. Older invitations may still ask for approval on the device that created them. After an update, refresh both browsers and show a fresh QR. The scanner uses a full-width square view, compact QR data, and native QR detection where available, with a pixel decoder fallback.

Keep the app open on both devices for the first sync. Approved browsers reconnect automatically when available; **Sync now** retries a connection. Each paired browser shows whether it is connected, whether it is up to date, and when its last sync was acknowledged. **Pause sync** stops networking while local logging continues.

Workout history, bodyweight, notes, entered sets, active workouts, exercise save checkpoints, and the next workout travel between browsers. The app keeps a complete local copy in each browser. There is no central workout database and no sync account. Autumn credentials and display preferences stay in their original browser. Devices cannot fetch updates while every browser holding those updates is closed or suspended; mobile browsers should be kept in the foreground during a transfer.

Stable workout and set identities prevent duplicate records when a transfer repeats. Automerge exchanges missing changes and combines edits to different fields. Independent edits to the same field remain available under **Changes to review** until you choose the correct value. Deletions are recorded so a stale browser cannot silently restore a deleted record. Independently logging the same real workout twice still creates two distinct records.

Every browser has a private ECDH key stored in IndexedDB. Pairing authenticates the exchanged public keys with a temporary secret; subsequent connections authenticate paired keys and encrypt transfers. PeerJS Cloud provides signaling, with STUN used to discover connection routes. The default configuration does not provide a TURN relay: restrictive firewalls or some mobile networks may prevent connection. Try the same Wi-Fi on both devices if they cannot connect. Connection setup services do not store workout history.

Use **Remove** beside a paired device to stop syncing with it. Removal records reach other connected paired browsers and propagate to offline browsers when they reconnect. Already received copies cannot be erased remotely. To rejoin after removal, the removed browser creates a new identity when pairing again. If it was removed while offline and never received the notice, use **How device sync works → Reset browser pairing** first; this keeps its workouts. Pair each additional browser with at least one existing device; changes can pass through devices as they reconnect.

The sync store and original migration snapshot are kept locally in IndexedDB. A synchronous recovery journal protects edits while database commits finish. A peer is acknowledged only after received changes are saved. Keep using **Data → Export** for independent backups; normal JSON/CSV exports contain workout data, not device private keys or the complete merge history. Use one Rolling PPL tab per browser profile while logging or syncing.

Validation: `npm test`, `npm run typecheck`, `npm run lint`, and `npm run build`. The optional `node scripts/test-peer-sync.mjs` browser check uses Playwright with installed Chrome in isolated contexts and synthetic data. Install Playwright separately or set `PLAYWRIGHT_MODULE` to its module URL. Run the dev server first; `SYNC_TEST_URL` overrides its URL. Set `SYNC_TEST_PRODUCTION=1` when testing a production preview to also verify service-worker offline reload. Screenshots are saved under ignored `outputs/peer-sync/`. `node scripts/test-pairing-scanner.mjs` verifies QR decoding, automatic linking, and camera cleanup using synthetic camera frames in isolated browsers (no webcam access). Camera cases use `SCANNER_FRAME=720x1280` (default), `1080x1920`, or `1280x720`; `SCANNER_QR_TOP=1` checks an off-center code. QR frames are scaled down and slightly blurred to exercise phone-like input.

Development references: [Automerge](https://automerge.org/docs/reference/documents/conflicts/), [PeerJS](https://peerjs.com/client/getting-started), and [WebRTC security](https://www.rfc-editor.org/rfc/rfc8827.html).

The Progress tab plots up to 24 bodyweight readings. Volume is the sum of recorded numeric load × reps for each exercise session, while working weight is the heaviest completed set. Exercise selections are remembered per chart. Dumbbell values stay as entered (per dumbbell), and bodyweight/text loads are excluded from kilogram charts.

Both JSON and current CSV backups restore workout-level bodyweight and notes. Older lift-only Rolling PPL CSV files remain importable; they simply contain no workout metadata to restore.

Under **Data**, choose **Export to** or **Import from**. Export destinations include download, Google Drive, OneDrive, WhatsApp, ChatGPT, clipboard, and the device share sheet (for email, AirDrop, and other installed apps). Choose JSON for a full backup including sync receipts, or CSV for spreadsheets.

Tapping an export app immediately opens the device share sheet, where you select the installed app. Browsers cannot preselect a share target, and available apps depend on the device and file type. No transfer option opens a provider website. When file sharing is unavailable, use Download or Copy to clipboard and attach or paste the backup in the app. If a browser cannot share JSON directly, the share sheet receives the same backup as `.json.txt`, which this app can import without renaming. Import from a cloud provider in the device file picker, a saved attachment, or pasted JSON/CSV. Imports merge by record ID and preserve unrelated history.

Workouts are timed and completed locally first. **Sync to Autumn** then posts one completed session with the original start/end timestamps and a stable UUID, so an interrupted retry cannot create a duplicate.

This project provides general workout organization and technique reminders, not medical care.

Exercise images come from [Free Exercise DB](https://github.com/yuhonas/free-exercise-db), released under the Unlicense/public domain dedication.
