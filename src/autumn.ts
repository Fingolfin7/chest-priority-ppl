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
    payload = text ? JSON.parse(text) as Record<string, unknown> : {};
  } catch {
    if (response.ok) throw new Error("Autumn returned an unexpected response.");
  }
  if (!response.ok) {
    const detail = typeof payload.detail === "string" ? payload.detail : "";
    const apiError = typeof payload.error === "string" ? payload.error : "";
    const fields = Object.entries(payload)
      .filter(([key]) => key !== "detail" && key !== "error")
      .flatMap(([key, value]) => (Array.isArray(value) ? value : [value]).map((message) => `${key}: ${String(message)}`))
      .join(" ");
    throw new Error(apiError || detail || fields || `Autumn returned ${response.status}.`);
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

export function buildAutumnSessionPayload(session: CompletedWorkout, projectId: number) {
  return {
    project_id: projectId,
    start: session.startedAt,
    end: session.endedAt,
    note: workoutSummary(session),
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
