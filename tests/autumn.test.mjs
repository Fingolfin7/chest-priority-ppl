import assert from "node:assert/strict";
import test from "node:test";
import {
  applyAutumnWorkoutUpdate, buildAutumnSessionPayload, linkedAutumnSessionId, pushWorkoutToAutumn,
  readAutumnWorkoutUpdate, signInToAutumn,
} from "../src/autumn.ts";

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

const linked = { ...session, sync: { status: "synced", autumnSessionId: 321 } };
const current = {
  id: 321, uuid: session.id, version: 7, start: "2026-08-23T05:00:00+00:00", end: session.endedAt,
  note: "Note added directly in Autumn.", project: { name: "Original gym project" },
};
const edited = { ...linked, endedAt: "2026-08-23T06:10:00.000Z", note: "Note updated in Rolling PPL." };

test("previews the linked session and patches only selected fields with its version", async () => {
  const requests = [];
  const fetcher = async (url, options) => {
    requests.push({ url, options });
    return Response.json(current);
  };
  const preview = await readAutumnWorkoutUpdate(settings, edited, fetcher);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].options.method, undefined);
  assert.equal(requests[0].options.cache, "no-store");
  assert.equal(preview.projectName, "Original gym project");
  assert.deepEqual(preview.fields, ["end", "note"]);
  assert.equal(preview.before.note, current.note);
  assert.match(preview.after.note, /Note updated in Rolling PPL/);

  await applyAutumnWorkoutUpdate(settings, edited, preview, [], preview.after.note, fetcher);
  assert.equal(requests.length, 1);
  await applyAutumnWorkoutUpdate(settings, edited, preview, ["end"], preview.after.note, fetcher);
  assert.equal(requests.length, 2);
  for (const { url, options } of requests) {
    assert.equal(url, "https://autumn.example/api/v2/sessions/321/");
    assert.equal(options.headers.get("Authorization"), "Token local-test-token");
  }
  assert.equal(requests[1].options.method, "PATCH");
  assert.equal(requests[1].options.headers.get("If-Match"), "7");
  assert.deepEqual(JSON.parse(requests[1].options.body), { end: edited.endedAt });
});

test("sends the note the user reviewed and reconciles a lost response by rereading", async () => {
  let remote = { ...current, note: buildAutumnSessionPayload(linked, 67).note };
  const fetcher = async (_url, options) => {
    if (options.method === "PATCH") {
      const patch = JSON.parse(options.body);
      assert.deepEqual(Object.keys(patch), ["end", "note"]);
      assert.equal(patch.note, buildAutumnSessionPayload(edited, 67).note);
      remote = { ...remote, ...patch, version: remote.version + 1 };
      throw new TypeError("Connection closed");
    }
    return Response.json(remote);
  };
  const preview = await readAutumnWorkoutUpdate(settings, edited, fetcher);
  await assert.rejects(() => applyAutumnWorkoutUpdate(settings, edited, preview, ["end", "note"], ` ${preview.after.note}\n`, fetcher), /Connection closed/);
  const retry = await readAutumnWorkoutUpdate(settings, edited, fetcher);
  assert.deepEqual(retry.fields, []);
  await applyAutumnWorkoutUpdate(settings, edited, retry, ["end", "note"], retry.after.note, fetcher);
  assert.equal(remote.version, 8);
});

test("refreshing a version conflict reveals a direct Autumn edit before another write", async () => {
  let patches = 0;
  let remote = current;
  const fetcher = async (_url, options) => {
    if (options.method !== "PATCH") return Response.json(remote);
    patches += 1;
    if (options.headers.get("If-Match") !== String(remote.version)) {
      return Response.json({ error: { code: "version_conflict", message: "The session has changed." } }, { status: 409 });
    }
    const patch = JSON.parse(options.body);
    remote = { ...remote, ...patch, version: remote.version + 1 };
    return Response.json(remote);
  };
  const stale = await readAutumnWorkoutUpdate(settings, edited, fetcher);
  remote = { ...remote, version: 8, note: "Another edit in Autumn." };
  await assert.rejects(() => applyAutumnWorkoutUpdate(settings, edited, stale, ["note"], stale.after.note, fetcher), /changed in Autumn/);
  assert.equal(patches, 1);
  const refreshed = await readAutumnWorkoutUpdate(settings, edited, fetcher);
  assert.equal(refreshed.before.note, "Another edit in Autumn.");
  const combined = `${refreshed.after.note}\n\n${refreshed.before.note}`;
  await applyAutumnWorkoutUpdate(settings, edited, refreshed, ["note"], combined, fetcher);
  assert.equal(patches, 2);
  assert.equal(remote.note, combined);
  assert.equal(remote.end, current.end);
});

test("rejects changed, deleted and switched-account previews before writing", async () => {
  const preview = await readAutumnWorkoutUpdate(settings, edited, async () => Response.json(current));
  const unexpectedRequest = () => assert.fail("A stale preview attempted a network request");
  const apply = (connection, session) => applyAutumnWorkoutUpdate(connection, session, preview, ["note"], preview.after.note, unexpectedRequest);
  await assert.rejects(() => apply(settings, { ...edited, note: "A newer local edit" }), /workout changed while/);
  await assert.rejects(() => apply(settings, undefined), /linked workout changed/);
  await assert.rejects(() => apply({ ...settings, token: "a-different-token" }, edited), /connection changed/);
  await assert.rejects(() => apply({ ...settings, baseUrl: "https://other.example" }, edited), /connection changed/);
});

test("does not update a legacy receipt or a remote session with the wrong UUID or no version", async () => {
  for (const sync of [{ status: "legacy" }, { status: "synced" }, { status: "synced", autumnSessionId: "321" }]) {
    const legacy = { ...linked, sync };
    assert.equal(linkedAutumnSessionId(legacy), undefined);
    await assert.rejects(() => readAutumnWorkoutUpdate(settings, legacy, () => assert.fail("No linked ID")), /no linked Autumn session/);
  }
  await assert.rejects(() => readAutumnWorkoutUpdate(settings, linked, async () => Response.json({ ...current, uuid: "other-workout" })), /different workout/);
  await assert.rejects(() => readAutumnWorkoutUpdate(settings, linked, async () => Response.json({ ...current, version: null })), /fields needed/);
});

test("rejects a time selection that would end the session before it starts", async () => {
  const later = { ...edited, startedAt: "2026-08-23T06:05:00Z" };
  const preview = await readAutumnWorkoutUpdate(settings, later, async () => Response.json(current));
  await assert.rejects(() => applyAutumnWorkoutUpdate(settings, later, preview, ["start"], preview.after.note, () => assert.fail("Invalid date range")), /before it starts/);
});
