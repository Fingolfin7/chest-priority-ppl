import assert from "node:assert/strict";
import test from "node:test";
import { buildAutumnSessionPayload, pushWorkoutToAutumn, signInToAutumn } from "../src/autumn.ts";

const settings = {
  baseUrl: "https://autumn.example/",
  token: "local-test-token",
  username: "mushu",
  projectId: 67,
  projectName: "Gym - 67kgs",
};
const session = {
  id: "5ea0ebd5-a632-4bda-9fb6-8bbf5799ac0a",
  workout: "pull",
  startedAt: "2026-08-23T05:00:00.000Z",
  endedAt: "2026-08-23T06:00:00.000Z",
  bodyweight: "64.6",
  note: "Good session.",
  exercises: [{ name: "Barbell curl", priority: "must", sets: [{ load: "20", reps: "12" }] }],
  sync: { status: "unsynced" },
};

test("uses the workout UUID and exact local timestamps for idempotent Autumn creation", () => {
  assert.deepEqual(buildAutumnSessionPayload(session, 67), {
    project_id: 67,
    start: session.startedAt,
    end: session.endedAt,
    note: "Pull day.\n\nBarbell curl: 20 kg × 12\n\nBodyweight: 64.6 kg.\n\nGood session.",
    uuid: session.id,
  });
});

test("posts a completed session with token auth and returns the Autumn ID", async () => {
  let request;
  const fetcher = async (url, options) => {
    request = { url, options };
    return new Response(JSON.stringify({ id: 321 }), { status: 201, headers: { "Content-Type": "application/json" } });
  };
  assert.deepEqual(await pushWorkoutToAutumn(settings, session, fetcher), { id: 321 });
  assert.equal(request.url, "https://autumn.example/api/v2/sessions/");
  assert.equal(request.options.method, "POST");
  assert.equal(request.options.headers.get("Authorization"), "Token local-test-token");
  assert.equal(JSON.parse(request.options.body).uuid, session.id);
});

test("sign-in sends the password transiently and returns only the token", async () => {
  const fetcher = async (_url, options) => {
    assert.equal(options.headers.has("Authorization"), false);
    assert.equal(options.body.get("password"), "secret");
    return new Response(JSON.stringify({ token: "returned-token" }), { status: 200 });
  };
  assert.equal(await signInToAutumn(settings, "mushu", "secret", fetcher), "returned-token");
});

test("surfaces Autumn validation errors", async () => {
  const fetcher = async () => new Response(JSON.stringify({ end: ["End must be on or after start."] }), { status: 400 });
  await assert.rejects(() => pushWorkoutToAutumn(settings, session, fetcher), /end: End must be on or after start/);
});
