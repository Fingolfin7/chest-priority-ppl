import type { CompletedWorkout } from "./sessionModel.ts";
import { workoutSummary } from "./sessionModel.ts";

export const DEFAULT_AUTUMN_URL = "https://autumn-lg0b.onrender.com";

export type AutumnSettings = {
  baseUrl: string;
  token: string;
  username: string;
  projectId?: number;
  projectName?: string;
};

export type AutumnProject = {
  id: number;
  name: string;
  status?: string;
  context?: string | { name?: string };
};

type FetchLike = typeof fetch;

type UpdateValues = { start: string; end: string; note: string };
const updateFields = ["start", "end", "note"] as const;
export type AutumnUpdateField = typeof updateFields[number];

export type AutumnUpdatePreview = {
  settings: AutumnSettings;
  workoutId: string;
  sessionId: number;
  version: number;
  projectName: string;
  before: UpdateValues;
  after: UpdateValues;
  fields: AutumnUpdateField[];
};

class AutumnResponseError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export function defaultAutumnSettings(): AutumnSettings {
  return { baseUrl: DEFAULT_AUTUMN_URL, token: "", username: "" };
}

function baseUrl(settings: AutumnSettings) {
  return settings.baseUrl.trim().replace(/\/+$/, "");
}

async function responsePayload(response: Response) {
  const text = await response.text();
  let payload: Record<string, unknown> = {};
  try {
    const value = text ? JSON.parse(text) : {};
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    payload = value;
  } catch {
    if (response.ok) throw new Error("Autumn returned an unexpected response.");
  }
  if (!response.ok) {
    const detail = typeof payload.detail === "string" ? payload.detail : "";
    const envelope = payload.error && typeof payload.error === "object" ? payload.error as Record<string, unknown> : {};
    const apiError = typeof payload.error === "string" ? payload.error : typeof envelope.message === "string" ? envelope.message : "";
    const fieldDetails = envelope.code === "validation_error" && envelope.details && typeof envelope.details === "object" ? envelope.details : payload;
    const fields = Object.entries(fieldDetails)
      .filter(([key]) => key !== "detail" && key !== "error")
      .flatMap(([key, value]) => (Array.isArray(value) ? value : [value]).map((message) => `${key}: ${String(message)}`))
      .join(" ");
    throw new AutumnResponseError((envelope.code === "validation_error" && fields) || apiError || detail || fields || `Autumn returned ${response.status}.`, response.status);
  }
  return payload;
}

async function autumnRequest(settings: AutumnSettings, path: string, options: RequestInit = {}, fetcher: FetchLike = fetch, includeAuth = true) {
  if (!baseUrl(settings)) throw new Error("Add the Autumn URL first.");
  const headers = new Headers(options.headers);
  headers.set("Accept", "application/json");
  if (includeAuth && settings.token) headers.set("Authorization", `Token ${settings.token}`);
  const response = await fetcher(`${baseUrl(settings)}${path}`, { ...options, headers });
  return responsePayload(response);
}

export async function signInToAutumn(settings: AutumnSettings, username: string, password: string, fetcher: FetchLike = fetch) {
  const body = new URLSearchParams({ username, password });
  const payload = await autumnRequest(settings, "/get-auth-token/", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  }, fetcher, false);
  if (typeof payload.token !== "string" || !payload.token) throw new Error("Autumn did not return a token.");
  return payload.token;
}

export async function getAutumnAccount(settings: AutumnSettings, fetcher: FetchLike = fetch) {
  if (!settings.token) throw new Error("Connect to Autumn first.");
  const payload = await autumnRequest(settings, "/api/v2/me/", {}, fetcher);
  const user = payload.user && typeof payload.user === "object" ? payload.user as Record<string, unknown> : payload;
  return String(user.username || user.email || "Autumn");
}

export async function listAutumnProjects(settings: AutumnSettings, fetcher: FetchLike = fetch): Promise<AutumnProject[]> {
  if (!settings.token) throw new Error("Connect to Autumn first.");
  const payload = await autumnRequest(settings, "/api/v2/projects/?limit=500&ordering=name", {}, fetcher);
  const projects = Array.isArray(payload.projects) ? payload.projects : [];
  return projects
    .filter((project): project is Record<string, unknown> => Boolean(project && typeof project === "object"))
    .map((project) => ({
      id: Number(project.id),
      name: String(project.name || ""),
      status: typeof project.status === "string" ? project.status : undefined,
      context: project.context as AutumnProject["context"],
    }))
    .filter((project) => Number.isInteger(project.id) && project.id > 0 && project.name);
}

function autumnUpdateValues(session: CompletedWorkout): UpdateValues {
  return {
    start: session.startedAt,
    end: session.endedAt,
    note: workoutSummary(session),
  };
}

export function buildAutumnSessionPayload(session: CompletedWorkout, projectId: number) {
  return {
    project_id: projectId,
    ...autumnUpdateValues(session),
    uuid: session.id,
  };
}

export async function pushWorkoutToAutumn(
  settings: AutumnSettings,
  session: CompletedWorkout,
  fetcher: FetchLike = fetch,
) {
  if (!settings.token) throw new Error("Connect to Autumn before syncing.");
  if (!settings.projectId || !settings.projectName) throw new Error("Choose the Autumn project for gym sessions.");
  const payload = await autumnRequest(settings, "/api/v2/sessions/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(buildAutumnSessionPayload(session, settings.projectId)),
  }, fetcher);
  const id = Number(payload.id);
  if (!Number.isInteger(id) || id <= 0) throw new Error("Autumn saved the session but did not return its ID.");
  return { id };
}

export function linkedAutumnSessionId(session: CompletedWorkout) {
  const id = session.sync.autumnSessionId;
  return session.sync.status === "synced" && id && Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

function sameValue(field: AutumnUpdateField, left: string, right: string) {
  return field === "note" ? left === right : Date.parse(left) === Date.parse(right);
}

export async function readAutumnWorkoutUpdate(
  settings: AutumnSettings,
  session: CompletedWorkout,
  fetcher: FetchLike = fetch,
): Promise<AutumnUpdatePreview> {
  const sessionId = linkedAutumnSessionId(session);
  if (!sessionId) throw new Error("This workout has no linked Autumn session.");
  if (!settings.token) throw new Error("Connect to Autumn in More → Autumn to review this update.");

  const remote = await autumnRequest(settings, `/api/v2/sessions/${sessionId}/`, { cache: "no-store" }, fetcher);
  if (remote.id !== sessionId || remote.uuid !== session.id.toLowerCase()) {
    throw new Error("This Autumn session belongs to a different workout. Check your Autumn connection.");
  }
  const { start, end, note, version } = remote;
  if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 1 ||
      typeof start !== "string" || !Number.isFinite(Date.parse(start)) ||
      typeof end !== "string" || !Number.isFinite(Date.parse(end)) ||
      (typeof note !== "string" && note !== null)) {
    throw new Error("Autumn did not return a completed session with the fields needed to review this update.");
  }
  const project = remote.project as { name?: unknown } | undefined;
  const before = { start, end, note: note ?? "" };
  const after = autumnUpdateValues(session);
  return {
    settings, workoutId: session.id, sessionId, version,
    projectName: typeof project?.name === "string" ? project.name : "",
    before, after,
    fields: updateFields.filter((field) => !sameValue(field, before[field], after[field])),
  };
}

export function buildAutumnWorkoutUpdatePatch(
  preview: AutumnUpdatePreview,
  selected: readonly AutumnUpdateField[],
  note: string,
) {
  const patch: Partial<UpdateValues> = {};
  for (const field of preview.fields) {
    const value = field === "note" ? note.trim() : preview.after[field];
    if (selected.includes(field) && !sameValue(field, value, preview.before[field])) patch[field] = value;
  }
  return patch;
}

export async function applyAutumnWorkoutUpdate(
  settings: AutumnSettings,
  session: CompletedWorkout | undefined,
  preview: AutumnUpdatePreview,
  selected: readonly AutumnUpdateField[],
  note: string,
  fetcher: FetchLike = fetch,
) {
  if (baseUrl(settings) !== baseUrl(preview.settings) || settings.token !== preview.settings.token) {
    throw new Error("The Autumn connection changed. Review the update again.");
  }
  if (!session || session.id !== preview.workoutId || linkedAutumnSessionId(session) !== preview.sessionId) {
    throw new Error("The linked workout changed. Review the update again.");
  }
  const current = autumnUpdateValues(session);
  if (updateFields.some((field) => !sameValue(field, current[field], preview.after[field]))) {
    throw new Error("This workout changed while you were reviewing it. Review the update again.");
  }
  const patch = buildAutumnWorkoutUpdatePatch(preview, selected, note);
  if (!Object.keys(patch).length) return;
  if (Date.parse(patch.end ?? preview.before.end) < Date.parse(patch.start ?? preview.before.start)) {
    throw new Error("The selected changes would end the session before it starts.");
  }
  try {
    await autumnRequest(settings, `/api/v2/sessions/${preview.sessionId}/`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "If-Match": String(preview.version) },
      body: JSON.stringify(patch),
    }, fetcher);
  } catch (error) {
    if (error instanceof AutumnResponseError && (error.status === 409 || error.status === 412)) {
      throw new Error("This session changed in Autumn. Refresh the preview to review the latest version.");
    }
    throw error;
  }
}
