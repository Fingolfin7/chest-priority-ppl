type TrackedSession = { sets: Array<{ load: string; reps: string }> };

function repRange(value: string) {
  const values = value.match(/\d+/g)?.map(Number) ?? [];
  return values.length >= 2 ? { min: values[0], max: values[1] } : null;
}

function isTopSession(reps: string, session?: TrackedSession) {
  const range = repRange(reps);
  if (!range || !session?.sets.length) return false;
  return session.sets.every((entry) => Number(entry.reps) >= range.max);
}

function loadSignature(session?: TrackedSession) {
  return session?.sets.map((entry) => entry.load.trim().toLowerCase() || "bw").join("|") ?? "";
}

function shouldAddWeight(reps: string, sessions: TrackedSession[]) {
  return isTopSession(reps, sessions[0])
    && isTopSession(reps, sessions[1])
    && loadSignature(sessions[0]) === loadSignature(sessions[1]);
}

export function nextStep(reps: string, sessions: TrackedSession[]) {
  const latest = sessions[0];
  const range = repRange(reps);
  if (!latest) return "Log this session to get your next target.";
  if (!range) return "Add reps or difficulty after two fully controlled sessions.";
  const recordedReps = latest.sets.map((entry) => Number(entry.reps));
  if (recordedReps.some((value) => !Number.isFinite(value) || value < range.min)) return "Hold or reduce the load until every set is back in range.";
  if (!isTopSession(reps, latest)) return "Add reps within the range next time.";
  if (shouldAddWeight(reps, sessions)) return "Add the smallest available weight next time.";
  return "Repeat the top-end reps once more, then add weight.";
}

export function setTarget(reps: string, sessions: TrackedSession[], setIndex: number) {
  const latest = sessions[0];
  const previousSet = latest?.sets[setIndex];
  if (!previousSet) return null;
  const load = previousSet.load.trim() || "BW";
  const range = repRange(reps);
  if (!range) return { load, reps: previousSet.reps };

  const belowRange = latest.sets.some((entry) => !Number.isFinite(Number(entry.reps)) || Number(entry.reps) < range.min);
  if (belowRange) return {
    load: load.toLowerCase() === "bw" ? "BW / assist" : `≤ ${load}`,
    reps: String(range.min),
  };
  if (shouldAddWeight(reps, sessions)) return { load: `${load} + min`, reps: String(range.min) };

  const previousReps = Number(previousSet.reps);
  return {
    load,
    reps: String(Math.min(Math.max(previousReps, range.min - 1) + 1, range.max)),
  };
}
