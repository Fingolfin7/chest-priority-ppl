# Design language

Rules for the Rolling PPL redesign, based on concept D (see [README.md](README.md)). Values come from the existing `src/styles.css` tokens unless noted.

## Principles

1. **Tool, not showcase.** The screen exists to log sets and read numbers. No hero blocks, display-size headlines, decorative gradients or promotional copy.
2. **Content before chrome.** The next workout and its lifts appear first. Setup, explanations and settings stay out of the way until needed.
3. **One open thing.** During a workout only the current exercise is expanded; everything else is one line.
4. **Every number has context.** Show the previous session and the target next to wherever a number is entered.
5. **Actions are buttons, views are tabs.** Never put a form behind a tab.
6. **One level of tabs.** A section may have one segmented control; no tabs inside tabs.
7. **Explain once, briefly.** Guidance lives in Rules or a help disclosure, not as footnotes on every page.
8. **No rest timer.** Rest is prescription text from the plan.

## Colour

Dark is the primary theme; light uses the existing light tokens.

| Role | Dark | Light |
| --- | --- | --- |
| Background | `#0f141a` | `#f2f4f6` |
| Surface (rows, open card) | `#171d24` | `#ffffff` |
| Tab bar | `#131920` | `#ffffff` |
| Divider | `#29323c` | `#edf0f2` |
| Border, control | `#303944` | `#dce1e6` |
| Input fill / border | `#10161c` / `#46515e` | `#ffffff` / `#cdd3d9` |
| Text | `#edf2f7` | `#18202a` |
| Secondary text | `#9ca8b5` | `#66717e` |
| Cue text | `#c3ccd5` | `#3f4a55` |

Workout colours mark identity and the active state only — the next-workout chip, the open exercise's border, the focused input, Start and Save:

| Workout | Accent | Soft fill | Soft text |
| --- | --- | --- | --- |
| Push | `#5f84f4` | `#202c4a` | `#9db5ff` |
| Pull | `#dc715c` | `#402a29` | `#f3a08f` |
| Legs | `#42a297` | `#1e3836` | `#86d2c9` |

Text on an accent-filled button uses the background colour (`#0f141a`). Use the accent once per region; secondary text stays grey.

## Type

- **Family:** the system UI font (`-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`). No webfonts are needed for the core UI.
- **Numbers:** `font-variant-numeric: tabular-nums` everywhere loads, reps, times and weights appear.
- **Scale:**

| Use | Size / weight |
| --- | --- |
| Screen title (workout name, section) | 22 / 700 |
| Open exercise name | 17 / 700 |
| Row title, body | 15 / 600 or 400 |
| Secondary line, cue, captions | 13 / 400 |
| Group label (MUST DO, IF TIME) | 12 / 600, uppercase, 0.06em tracking |
| Tab label | 11 / 600 |
| Set input value | 17 / 600 |

No monospace UI labels and no all-caps buttons.

## Spacing and shape

- 16 px screen gutter; 8 px between grouped blocks; 12 px inside cards.
- Radii: 8 (inputs, thumbnails), 10 (buttons, segmented controls), 12 (row groups, open card).
- Touch targets at least 44 px; set inputs 44 px tall.
- Grouped rows share one rounded surface, separated by 1 px dividers rather than separate cards.

## Navigation

- **Bottom tab bar:** Train, Progress, Sessions, Plan — icon plus label, 64 px. A dot on Train shows a workout in progress.
- **⋯ menu** (top-right of each screen): Devices, Autumn (with a pending-sync count), Data (backup, restore, export), Theme, Install.
- **Train:** Push / Pull / Legs segmented control to view any workout; the next one is marked. Change next sits beside Start.
- **During a workout:** the top bar shows the workout, elapsed time and Finish; ⋯ holds Adjust this workout and Cancel.
- **Progress:** Body / Lifts / Photos. Weigh-in and Measurements are buttons; Outlook and Training phase are rows that open detail screens.

## Components

- **Exercise row:** optional 48 px thumbnail · name · "sets × reps · prev …" · target on the right, in the workout's soft text colour. Saved rows show the logged sets and a check.
- **Open exercise card:** surface plus a 1 px accent border; name and Must / If time badge; prescription line (sets × reps · rest · warm-up); two 64 × 48 photo thumbnails that enlarge on tap, beside the cue; set grid (Set · Load kg · Reps) with targets as placeholders; previous session and next-target hint; Save exercise (accent) and History.
- **Alternatives:** shown as "Leg press or split squat" in the row; the choice control appears when the card is open.
- **Segmented control:** 40 px, surface background, the selected segment in the soft accent.
- **Sticky action bar:** above the tab bar on Train — Start (accent, full width) and Change next (outlined).
- **Charts:** one series per chart unless comparing like with like; thin 2 px line, grid lines in the divider colour, the latest point emphasised, with the existing point readout and data table kept.

## Copy

- Short labels: "Save exercise", "Start Legs", "Change next", "+ Weigh-in".
- Context lines read like a log: "Last: Pull · Fri 2 Oct · 63 min · synced to Autumn".
- Dates as "Fri 2 Oct"; loads as "65 × 8, 8, 7".
