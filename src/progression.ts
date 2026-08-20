type TrackedSession = { sets: Array<{ load: string; reps: string }> };

function repRange(value: string) {
  const values = value.match(/\d+/g)?.map(Number) ?? [];
  return values.length >= 2 ? { min: values[0], max: values[1] } : null;
}

function requiredEntries(session: TrackedSession | undefined, requiredSets: number) {
  return session?.sets.slice(0, requiredSets) ?? [];
}

function isTopSession(reps: string, session: TrackedSession | undefined, requiredSets: number) {
  const range = repRange(reps);
  const entries = requiredEntries(session, requiredSets);
  if (!range || entries.length < requiredSets) return false;
  return entries.every((entry) => Number(entry.reps) >= range.max);
}

function loadSignature(session: TrackedSession | undefined, requiredSets: number) {
  return requiredEntries(session, requiredSets).map((entry) => entry.load.trim().toLowerCase() || "bw").join("|");
}

function shouldAddWeight(reps: string, sessions: TrackedSession[], requiredSets: number) {
  return isTopSession(reps, sessions[0], requiredSets)
    && isTopSession(reps, sessions[1], requiredSets)
    && loadSignature(sessions[0], requiredSets) === loadSignature(sessions[1], requiredSets);
}

function optionalSetTarget(reps: string, sessions: TrackedSession[], setIndex: number) {
  const performed = sessions.filter((session) => session.sets[setIndex]);
  const latestSet = performed[0]?.sets[setIndex];
  if (!latestSet) return null;
  const load = latestSet.load.trim() || "BW";
  const range = repRange(reps);
  if (!range) return { load, reps: latestSet.reps };

  const previousSet = performed[1]?.sets[setIndex];
  const repeatedTopSet = Number(latestSet.reps) >= range.max
    && Number(previousSet?.reps) >= range.max
    && (previousSet?.load.trim().toLowerCase() || "bw") === (latestSet.load.trim().toLowerCase() || "bw");
  if (repeatedTopSet) return { load: `${load} + min`, reps: String(range.min) };

  const previousReps = Number(latestSet.reps);
  return {
    load,
    reps: String(Math.min(Math.max(previousReps, range.min - 1) + 1, range.max)),
  };
}

export function nextStep(reps: string, sessions: TrackedSession[], requiredSets: number) {
  const latest = sessions[0];
  const range = repRange(reps);
  if (!latest) return "Log this session to get your next target.";
  if (!range) return "Add reps or difficulty after two fully controlled sessions.";
  const entries = requiredEntries(latest, requiredSets);
  if (entries.length < requiredSets) return `Log all ${requiredSets} required sets to get your next target.`;
  const recordedReps = entries.map((entry) => Number(entry.reps));
  if (recordedReps.some((value) => !Number.isFinite(value) || value < range.min)) return "Hold or reduce the load until every set is back in range.";
  if (!isTopSession(reps, latest, requiredSets)) return "Add reps within the range next time.";
  if (shouldAddWeight(reps, sessions, requiredSets)) return "Add the smallest available weight next time.";
  return "Repeat the top-end reps once more, then add weight.";
}

export function setTarget(reps: string, sessions: TrackedSession[], setIndex: number, requiredSets: number) {
  if (setIndex >= requiredSets) return optionalSetTarget(reps, sessions, setIndex);
  const latest = sessions[0];
  const previousSet = latest?.sets[setIndex];
  if (!previousSet) return null;
  const load = previousSet.load.trim() || "BW";
  const range = repRange(reps);
  if (!range) return { load, reps: previousSet.reps };

  const belowRange = requiredEntries(latest, requiredSets).some((entry) => !Number.isFinite(Number(entry.reps)) || Number(entry.reps) < range.min);
  if (belowRange) return {
    load: load.toLowerCase() === "bw" ? "BW / assist" : `≤ ${load}`,
    reps: String(range.min),
  };
  if (shouldAddWeight(reps, sessions, requiredSets)) return { load: `${load} + min`, reps: String(range.min) };

  const previousReps = Number(previousSet.reps);
  return {
    load,
    reps: String(Math.min(Math.max(previousReps, range.min - 1) + 1, range.max)),
  };
}
