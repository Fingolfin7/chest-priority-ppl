// Original exercise definitions: names are stable history keys.
export type LegacyExerciseDefinition = { name: string; cue: string; demos: Array<{label: string; slug: string}>; loadSuffix?: string };
export const legacyExerciseDefinitions: LegacyExerciseDefinition[] = [
  {
    "name": "Barbell bench press",
    "cue": "Set your upper back, plant your feet, and touch the same lower-chest point each rep. The fourth work set is optional.",
    "demos": [
      {
        "label": "Bench press",
        "slug": "bench"
      }
    ]
  },
  {
    "name": "Incline dumbbell bench press",
    "cue": "Use a modest incline. Lower with control and press up and slightly inward.",
    "demos": [
      {
        "label": "Incline press",
        "slug": "incline-press"
      }
    ],
    "loadSuffix": " each"
  },
  {
    "name": "Lateral raise",
    "cue": "Lead with your elbows, stop near shoulder height, and keep momentum out of it.",
    "demos": [
      {
        "label": "Lateral raise",
        "slug": "lateral-raise"
      }
    ],
    "loadSuffix": " each"
  },
  {
    "name": "Cable triceps pushdown",
    "cue": "Pin your upper arms, extend fully, then control the return.",
    "demos": [
      {
        "label": "Pushdown",
        "slug": "pushdown"
      }
    ]
  },
  {
    "name": "Overhead dumbbell triceps extension",
    "cue": "Hold one dumbbell with both hands. Keep your upper arms steady and use a comfortable depth. The third work set is optional.",
    "demos": [
      {
        "label": "Overhead dumbbell extension",
        "slug": "overhead-db-extension"
      }
    ]
  },
  {
    "name": "Chest press machine",
    "cue": "Set the seat so the handles meet mid-chest. Keep your upper back planted and control the return.",
    "demos": [
      {
        "label": "Chest press machine",
        "slug": "chest-press-machine"
      }
    ]
  },
  {
    "name": "Bent-over barbell row",
    "cue": "Brace before you pull, keep your torso angle steady, and drive your elbows toward your hips.",
    "demos": [
      {
        "label": "Barbell row",
        "slug": "barbell-row"
      }
    ]
  },
  {
    "name": "Lat pulldown",
    "cue": "Start by bringing your shoulders down, then pull your elbows toward your ribs without swinging.",
    "demos": [
      {
        "label": "Lat pulldown",
        "slug": "lat-pulldown"
      }
    ]
  },
  {
    "name": "Pull-ups",
    "cue": "Start by bringing your shoulders down, then pull your elbows toward your ribs without swinging.",
    "demos": [
      {
        "label": "Pull-ups",
        "slug": "pullups"
      }
    ]
  },
  {
    "name": "Rear-delt fly",
    "cue": "Use your rear delts and upper back. Keep your ribs down and avoid shrugging.",
    "demos": [
      {
        "label": "Rear-delt fly",
        "slug": "rear-delt-fly"
      }
    ]
  },
  {
    "name": "Barbell curl",
    "cue": "Keep your upper arms quiet, curl without leaning back, and own the lowering phase.",
    "demos": [
      {
        "label": "Barbell curl",
        "slug": "barbell-curl"
      }
    ]
  },
  {
    "name": "Dumbbell hammer curl",
    "cue": "Keep a neutral grip, leave your elbows by your sides, and lower without swinging. The third work set is optional.",
    "demos": [
      {
        "label": "Hammer curl",
        "slug": "hammer-curl"
      }
    ],
    "loadSuffix": " each"
  },
  {
    "name": "Back squat",
    "cue": "Brace before descending, keep pressure through your whole foot, and use safeties just below depth.",
    "demos": [
      {
        "label": "Back squat",
        "slug": "back-squat"
      }
    ]
  },
  {
    "name": "Conventional deadlift",
    "cue": "Wedge into the bar, push the floor away, and finish tall without leaning back.",
    "demos": [
      {
        "label": "Deadlift",
        "slug": "deadlift"
      }
    ]
  },
  {
    "name": "Leg curl",
    "cue": "Keep your hips anchored, curl through your hamstrings, and lower without letting the stack crash.",
    "demos": [
      {
        "label": "Leg curl",
        "slug": "leg-curl"
      }
    ]
  },
  {
    "name": "Leg press",
    "cue": "Choose the option you can control through a comfortable range. Keep your knee tracking over your foot.",
    "demos": [
      {
        "label": "Leg press",
        "slug": "leg-press"
      }
    ]
  },
  {
    "name": "Bulgarian split squat",
    "cue": "Choose the option you can control through a comfortable range. Keep your knee tracking over your foot.",
    "demos": [
      {
        "label": "Bulgarian split squat",
        "slug": "split-squat"
      }
    ]
  },
  {
    "name": "Calf raise",
    "cue": "Use a full comfortable stretch, pause briefly at the top, and avoid bouncing. The third work set is optional.",
    "demos": [
      {
        "label": "Calf raise",
        "slug": "calf-raise"
      }
    ]
  },
  {
    "name": "Ab crunch machine",
    "cue": "Bring your ribs toward your pelvis, pause in the crunch, and control the return. The third work set is optional.",
    "demos": [
      {
        "label": "Ab crunch machine",
        "slug": "ab-crunch-machine"
      }
    ]
  }
];
