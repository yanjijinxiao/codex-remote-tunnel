const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { probeTurn, recoverOwnedProbe } = require("./probe-codex-app-server.js");

function fixture(options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-probe-test-"));
  const stateFile = path.join(directory, "probe.json");
  const listeners = new Set();
  const calls = [];
  const client = {
    failCleanup: options.failCleanup,
    emit(method, params) { for (const listener of listeners) listener({ method, params }); },
    onMessage(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async request(method, params) {
      calls.push({ method, params });
      if (method === "thread/start") return { thread: { id: "owned-thread" } };
      if (method === "turn/start") {
        this.emit("turn/started", { threadId: "owned-thread", turn: { id: "owned-turn" } });
        this.emit("turn/completed", { threadId: "unrelated-task", turn: { id: "other", status: "completed" } });
        if (options.complete || options.failure) setTimeout(() => {
          if (!options.failure) this.emit("item/completed", { threadId: "owned-thread", item: { type: "agentMessage", text: "READY" } });
          this.emit("turn/completed", { threadId: "owned-thread", turn: { id: "owned-turn", status: options.failure ? "failed" : "completed", error: options.failure ? { message: "workspace routing discovery failed" } : null } });
        }, 5);
        return { turn: { id: "owned-turn" } };
      }
      if (method === "thread/read") return { thread: { ephemeral: !options.persistent, status: { type: "active" } } };
      if (method === "turn/interrupt") {
        if (this.failCleanup) throw new Error("connection unavailable");
        return {};
      }
      throw new Error(`unexpected request: ${method}`);
    },
  };
  return { client, calls, stateFile, remove: () => fs.rmSync(directory, { recursive: true, force: true }) };
}

test("successful probe removes its marker without an interrupt", async () => {
  const f = fixture({ complete: true });
  try {
    await probeTurn(f.client, { active: [] }, 100, f.stateFile);
    assert.equal(fs.existsSync(f.stateFile), false);
    assert.equal(f.calls.some(x => x.method === "turn/interrupt"), false);
  } finally { f.remove(); }
});

test("timeout interrupts only the probe's exact thread and turn", async () => {
  const f = fixture();
  try {
    await assert.rejects(probeTurn(f.client, { active: [] }, 20, f.stateFile), /timed out/);
    assert.deepEqual(f.calls.filter(x => x.method === "turn/interrupt"), [
      { method: "turn/interrupt", params: { threadId: "owned-thread", turnId: "owned-turn" } },
    ]);
    assert.equal(fs.existsSync(f.stateFile), false);
  } finally { f.remove(); }
});

test("failed probes retain terminal evidence and the specific failure reason", async () => {
  const f = fixture({ failure: true });
  try {
    await assert.rejects(probeTurn(f.client, { active: [] }, 100, f.stateFile), /workspace routing discovery failed/);
    const record = JSON.parse(fs.readFileSync(`${f.stateFile}.completed`));
    assert.equal(record.threadId, "owned-thread");
    assert.equal(record.turnId, "owned-turn");
    assert.equal(record.turnStatus, "failed");
    assert.equal(fs.existsSync(f.stateFile), false);
    assert.equal(f.calls.some(x => x.method === "turn/interrupt"), false);
  } finally { f.remove(); }
});

test("SIGTERM cleans up the owned probe", async () => {
  const f = fixture();
  const timer = setTimeout(() => process.emit("SIGTERM"), 15);
  try {
    await assert.rejects(probeTurn(f.client, { active: [] }, 1000, f.stateFile), /interrupted/);
    assert.equal(f.calls.filter(x => x.method === "turn/interrupt").length, 1);
    assert.equal(fs.existsSync(f.stateFile), false);
  } finally { clearTimeout(timer); f.remove(); }
});

test("unreachable cleanup is persisted and recovered on the next check", async () => {
  const f = fixture({ failCleanup: true });
  try {
    await assert.rejects(probeTurn(f.client, { active: [] }, 20, f.stateFile), /timed out/);
    assert.equal(JSON.parse(fs.readFileSync(f.stateFile)).turnId, "owned-turn");
    f.client.failCleanup = false;
    await recoverOwnedProbe(f.client, f.stateFile);
    assert.equal(fs.existsSync(f.stateFile), false);
  } finally { f.remove(); }
});

test("persistent tasks are never interrupted by probe recovery", async () => {
  const f = fixture({ persistent: true });
  try {
    fs.writeFileSync(f.stateFile, JSON.stringify({ owner: "codex_tunnel_health", threadId: "owned-thread", turnId: "owned-turn" }));
    await assert.rejects(recoverOwnedProbe(f.client, f.stateFile), /persistent task/);
    assert.equal(f.calls.some(x => x.method === "turn/interrupt"), false);
  } finally { f.remove(); }
});
