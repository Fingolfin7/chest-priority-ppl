# Redesign concepts

Exploration notes for a UI/UX and navigation redesign of Rolling PPL. Nothing here changes the app; it is reference material for building the redesign later.

- [design-language.md](design-language.md) — the visual and interaction rules the redesign should follow.
- [mockups/index.html](mockups/index.html) — static phone mockups of the round-2 concepts. Open it in a browser from a local checkout; the mockups load photos from `public/exercises/`.

## Constraints

- **Phone first.** Training happens on the phone; the laptop is mainly for reviewing synced data. Design for 390 px wide, then let the layout widen for the laptop.
- **A training tool, not a landing page.** No hero headlines, oversized display type, decorative cards or promotional copy.
- **Functionality stays.** Rolling sequence, Must do / If time ranking, exercise alternatives, form photos with enlarge, cues and warm-ups, per-set targets, previous session, next-target guidance, save each exercise then finish once, finish review with bodyweight and note, adjust this workout, change next, session editing, phases, body / lift / photo progress, outlooks, device sync, Autumn, backup and restore, theme, install.
- **No rest timer.** Leaving it out is deliberate. Show the plan's rest guidance as text only.

## Problems in the current UI

Taken from screenshots of the live app (Train, Progress › Overview / Log weigh-in / Measurements / Short-term outlook, Lifts, Photos, Sessions, Plan).

1. **Train is one very long page.** Every exercise card is fully expanded: two photos (with dead space under them), prescription, cue, warm-up, rest, set inputs, next target, save and history. Six cards plus the rules section fill several screens before anything is logged.
2. **Crowded header.** Devices, Autumn, Data, Install and the theme toggle sit next to the four primary tabs.
3. **Nested tabs in Progress.** Overview contains a second row (Overview, Log weigh-in, Measurements, Short-term outlook), so "Overview" appears twice, and two of those "tabs" are really actions that open forms.
4. **Sessions is sparse.** Each tall card holds one line of information; details are behind a disclosure. Ten sessions take a full desktop screen.
5. **Setup and explanation before content.** Photos opens with backup setup copy; most pages end with explanatory footnotes.
6. **Hard-to-read charts.** Training volume draws four crossing lines; Lifts follows with 18 "recent lift" cards.
7. **Inconsistent type.** Tiny uppercase monospace labels (TARGET, RECORDED BEST, EDIT SESSION) mixed with normal sans buttons.

Worth keeping: the dark palette, the per-workout colours, chart point readouts with previous/next controls and data tables, and the clean Plan page.

## Round 1 — rejected

Three directions — A "Focus" (dark, one lift per screen), B "Ledger" (light notebook tables), C "Coach" (bright card dashboard). All three were rejected for feeling like marketing pages rather than a training tool: huge display type, hero blocks, decorative colour. They also invented a rest timer and per-set logging that the app deliberately does not have.

## Round 2 — training-tool concepts

All three use the existing palette, the system font, real data from the app, no rest timer, and the existing save-each-exercise-then-finish flow.

### D · Checklist — preferred base

- **Navigation:** bottom tab bar — Train, Progress, Sessions, Plan. Devices, Autumn, Data, theme and install move behind a ⋯ menu in each screen's top bar.
- **Train:** Push / Pull / Legs segmented control (marks which is next), one line of last-session context, then compact rows grouped Must do / If time. Each row shows a thumbnail, sets × reps, the previous session and the next target. A sticky bar holds Start and Change next.
- **Mid-workout:** the open exercise expands in place (photos, cue, set inputs, previous, next-target hint, Save exercise, History); saved and upcoming exercises stay one line each. Finish and the timer live in the top bar; Adjust and Cancel go in the ⋯ menu.
- **Progress:** flattened to Body / Lifts / Photos. Weigh-in and Measurements become buttons, not tabs. Body shows the weight chart with 7-day averages, the goal, latest measurements, and single rows linking to the outlook and the training phase.
- **Trade-off:** closest to today's app; you scroll a little between lifts.
- **Verdict:** best of the set, but not yet "good". It needs refinement rather than a new structure.

### E · Log sheet

- **Navigation:** text tabs at the top.
- **Train:** the whole session is one table of set rows (Set / Prev / kg / reps). Targets show as greyed placeholders before starting. Form photos, cue and warm-up sit behind an ⓘ per lift; each lift has its own Save.
- **Sessions:** a dense date / workout / min / kg table that expands in place, showing about twice as many sessions per screen.
- **Trade-off:** everything visible at once and reads well on a laptop; smaller inputs, and photos are a tap away.

### F · Workout-first

- **Navigation:** no tab bar. Train is home; Progress, Sessions, Plan and the utilities live under Menu.
- **Mid-workout:** one lift per screen with the largest inputs, both photos, Previous next to Target, a chip row to jump between lifts, and "Save · next" (still one save per exercise).
- **Lifts:** one lift's chart at a time instead of overlapping lines, with every lift's best set listed underneath.
- **Trade-off:** least to read mid-set; Progress and Sessions are two taps away.

## Next: refining D

D's structure works; what is missing is character and polish. The plan was to vary one thing at a time on the D mid-workout screen and pick per axis:

| Axis | Option to compare against D |
| --- | --- |
| Surfaces | Flat full-width rows with hairline dividers, no cards, no row thumbnails |
| Hierarchy | Numbers first: large tabular set inputs, previous set beside each row |
| Type and tone | A characterful sans with monospaced numbers on a warm dark ground |
| Theme | Light, high-contrast for bright gyms |
| Workout identity | The day's colour carried into the header and active states |
| Photos | Photo-led open exercise with larger form images |

Still open: whether row thumbnails earn their space, how the finish review looks in D, the laptop layout for Progress and Sessions, and the ⋯ menu contents.

Mockup numbers mid-workout, the set details in E3's expanded Pull session, and the sparkline shapes in F3 are illustrative; everything else is taken from the live app.
