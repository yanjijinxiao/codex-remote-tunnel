const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { snapshot, observe, recover, monitor, STALL_MS, MAX_GAP_MS } = require("./task-progress");
const { inspect } = require("./probe-codex-app-server");

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-progress-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const history = path.join(dir, "rollout.jsonl");
  const stateFile = path.join(dir, "state.json");
  const events = [
    { type: "event_msg", payload: { type: "task_started", turn_id: "turn" } },
    { type: "response_item", payload: { type: "message", role: "user", content: "hi" } },
    { type: "event_msg", payload: { type: "error", message: "Connection failed: error sending request" } },
  ];
  fs.writeFileSync(history, events.map(e => JSON.stringify(e)).join("\n") + "\n");
  const thread = { id: "task", path: history, ephemeral: false, status: { type: "active", activeFlags: [] },
    turns: [{ id: "turn", status: "inProgress", items: [{ type: "userMessage" }] }] };
  const calls = [];
  const client = { async request(method, params) {
    calls.push({ method, params });
    if (method === "thread/read") return { thread: structuredClone(thread) };
    if (method === "thread/backgroundTerminals/list") return { data: [], nextCursor: null };
    if (method === "turn/interrupt") {
      thread.status.type = "idle";
      thread.turns[0].status = "interrupted";
      return {};
    }
    throw new Error(`unexpected request ${method}`);
  } };
  const current = snapshot(thread);
  let entry;
  for (let now = STALL_MS * 2; now <= STALL_MS * 3; now += 120000) entry = observe(current, entry, now);
  return { dir, history, stateFile, events, thread, client, calls, entry };
}

test("requires continuous repeated observations, not just an old turn", t => {
  const f = fixture(t);
  assert.equal(observe(snapshot(f.thread), undefined, 1e12).eligible, false);
  assert.equal(f.entry.eligible, true);
});
test("sleep, clock reversal, a new turn, and output each reset the stall clock", t => {
  const f = fixture(t);
  for (const [current, now] of [
    [snapshot(f.thread), f.entry.lastSeen + MAX_GAP_MS + 1],
    [snapshot(f.thread), f.entry.lastSeen - 1],
    [{ ...snapshot(f.thread), turnId: "new" }, f.entry.lastSeen + 120000],
    [{ ...snapshot(f.thread), fingerprint: "changed", progressFingerprint: "changed" }, f.entry.lastSeen + 120000],
  ]) {
    const result = observe(current, f.entry, now);
    assert.equal(result.eligible, false);
    assert.equal(result.samples, 1);
  }
});
test("rapid manual checks do not inflate sample counts", t => {
  const f = fixture(t);
  assert.equal(observe(snapshot(f.thread), f.entry, f.entry.lastSeen + 1).samples, f.entry.samples);
});
test("elapsed time is not task progress", t => {
  const f = fixture(t);
  f.thread.turns[0].durationMs = 999999;
  const result = observe(snapshot(f.thread), f.entry, f.entry.lastSeen + 120000);
  assert.equal(result.eligible, true);
});
test("repeated network errors do not reset the empty-turn stall clock", t => {
  const f = fixture(t);
  fs.appendFileSync(f.history, JSON.stringify(f.events[2]) + "\n");
  const current = snapshot(f.thread);
  assert.notEqual(current.fingerprint, f.entry.fingerprint);
  assert.equal(current.progressFingerprint, f.entry.progressFingerprint);
  assert.equal(observe(current, f.entry, f.entry.lastSeen + 120000).eligible, true);
});
test("approvals and unknown active flags protect a task", t => {
  const f = fixture(t);
  for (const flags of [["waitingOnApproval"], ["waitingOnUserInput"], undefined]) {
    f.thread.status.activeFlags = flags;
    const current = snapshot(f.thread);
    assert.equal(current.waiting, true);
    assert.equal(observe(current, { ...f.entry, fingerprint: current.fingerprint }, f.entry.lastSeen).eligible, false);
  }
});
test("tools, compaction, and reasoning are never auto-interrupted", t => {
  const f = fixture(t);
  for (const type of ["commandExecution", "functionCall", "contextCompaction", "reasoning", "agentMessage"]) {
    f.thread.turns[0].items.push({ type, status: "inProgress" });
    assert.equal(snapshot(f.thread).empty, false);
  }
});
test("raw rollout work protects tasks even when the API omits items", t => {
  const f = fixture(t);
  fs.appendFileSync(f.history, JSON.stringify({ type: "response_item", payload: { type: "function_call" } }) + "\n");
  assert.equal(snapshot(f.thread).empty, false);
});
test("user-quoted network errors are not outage evidence", t => {
  const f = fixture(t);
  f.events.pop();
  f.events[1].payload.content = "Connection failed: error sending request";
  fs.writeFileSync(f.history, f.events.map(e => JSON.stringify(e)).join("\n"));
  assert.equal(snapshot(f.thread).networkFailure, false);
});
test("errors in a previous turn do not authorize recovery", t => {
  const f = fixture(t);
  fs.appendFileSync(f.history, JSON.stringify({ type: "event_msg", payload: { type: "task_started", turn_id: "other" } }) + "\n");
  assert.equal(snapshot(f.thread).networkFailure, false);
});
test("unreadable, partial and symlinked history cannot authorize recovery", t => {
  const f = fixture(t);
  fs.appendFileSync(f.history, "{unfinished");
  assert.throws(() => snapshot(f.thread), /incomplete/);
  const link = path.join(f.dir, "link");
  fs.symlinkSync(f.history, link);
  f.thread.path = link;
  assert.throws(() => snapshot(f.thread));
});
test("eligible recovery backs up history and interrupts only the exact turn", async t => {
  const f = fixture(t);
  const result = await recover(f.client, f.entry, { version: 1, turns: {} }, f.stateFile, f.entry.lastSeen);
  assert.equal(result.recovered, true);
  assert.equal(fs.statSync(result.backup).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(result.backup, "utf8"), fs.readFileSync(f.history, "utf8"));
  assert.deepEqual(f.calls.filter(c => c.method === "turn/interrupt"), [
    { method: "turn/interrupt", params: { threadId: "task", turnId: "turn" } },
  ]);
});
test("background work, unknown responses and pagination refuse interruption", async t => {
  const f = fixture(t);
  for (const value of [{ data: [{ processId: "p" }] }, {}, { data: [], nextCursor: "more" }]) {
    const client = { request: async () => value };
    try {
      const result = await recover(client, f.entry, {}, f.stateFile, f.entry.lastSeen);
      assert.equal(result.recovered, false);
    } catch (error) { assert.match(error.message, /unavailable|incomplete/); }
  }
});
test("a task changing during recovery is left alone", async t => {
  const f = fixture(t);
  f.thread.turns[0].id = "new-turn";
  await assert.rejects(recover(f.client, f.entry, {}, f.stateFile, f.entry.lastSeen), /changed/);
  assert.equal(f.calls.some(c => c.method === "turn/interrupt"), false);
});
test("failed interrupt is not sent twice, even after cooldown", async t => {
  const f = fixture(t);
  const state = { version: 1, turns: {} };
  const original = f.client.request.bind(f.client);
  f.client.request = async (method, params) => {
    if (method === "turn/interrupt") throw new Error("connection lost");
    return original(method, params);
  };
  await assert.rejects(recover(f.client, f.entry, state, f.stateFile, f.entry.lastSeen), /connection lost/);
  const result = await recover(f.client, f.entry, JSON.parse(fs.readFileSync(f.stateFile)), f.stateFile, f.entry.lastSeen + STALL_MS);
  assert.equal(result.reason, "previous-attempt-needs-review");
});
test("cooldown limits recovery across tasks", async t => {
  const f = fixture(t);
  const result = await recover(f.client, f.entry, { lastRecovery: f.entry.lastSeen - 1 }, f.stateFile, f.entry.lastSeen);
  assert.equal(result.reason, "recovery-cooldown");
  assert.equal(f.calls.length, 0);
});
test("monitor surfaces stalled tasks without network evidence instead of killing them", async t => {
  const f = fixture(t);
  f.events.pop();
  fs.writeFileSync(f.history, f.events.map(e => JSON.stringify(e)).join("\n"));
  let result;
  for (let now = STALL_MS * 2; now <= STALL_MS * 3; now += 120000) {
    result = await monitor(f.client, ["task"], { stateFile: f.stateFile, now });
  }
  assert.equal(result.state, "needs-attention");
  assert.equal(f.calls.some(c => c.method === "turn/interrupt"), false);
});
test("monitor recovers a proven empty stalled turn and reports idle", async t => {
  const f = fixture(t);
  let result;
  for (let now = STALL_MS * 2; now <= STALL_MS * 3; now += 120000) {
    result = await monitor(f.client, ["task"], { stateFile: f.stateFile, now });
  }
  assert.equal(result.state, "idle");
  assert.equal(result.recovered.length, 1);
});
test("corrupt progress state fails closed", async t => {
  const f = fixture(t);
  fs.writeFileSync(f.stateFile, "not-json");
  await assert.rejects(monitor(f.client, ["task"], { stateFile: f.stateFile }));
  assert.equal(f.calls.length, 0);
});
test("partial task inventory and unknown status cannot prove idle", async () => {
  for (const loaded of [{ data: ["task"], nextCursor: "more" }, { data: Array(101).fill("task") }]) {
    await assert.rejects(inspect({ request: async () => loaded }, true, true), /inventory/);
  }
  for (const [type, expected] of [["futureStatus", /unknown/], ["systemError", /unconfirmed/]]) {
    const client = { request: async method => method === "thread/loaded/list" ? { data: ["task"] } : { thread: { status: { type } } } };
    await assert.rejects(inspect(client, true, true), expected);
  }
});
