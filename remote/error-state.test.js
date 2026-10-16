const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { inspect } = require("./probe-codex-app-server.js");

function client(detail, initial = { type: "systemError" }) {
  return { async request(method, params) {
    if (method === "thread/loaded/list") return { data: ["task"] };
    if (method === "thread/read") return { thread: params.includeTurns ? detail : { status: initial } };
    throw new Error(`unexpected method ${method}`);
  } };
}
function ended(extra = {}) {
  return { status: { type: "systemError" }, turns: [{ id: "failed-turn", status: "failed", items: [{ type: "userMessage" }] }], ...extra };
}

test("a confirmed failed turn permits idle recovery without being called healthy", async () => {
  const result = await inspect(client(ended()), true, true);
  assert.deepEqual(result.active, []);
  assert.deepEqual(result.failed, [{ threadId: "task", turnId: "failed-turn" }]);
  assert.equal(result.modelCount, null);
});
test("a newly active task vetoes recovery", async () => {
  const result = await inspect(client(ended({ status: { type: "active" } })), true, true);
  assert.deepEqual(result.active, ["task"]);
  assert.deepEqual(result.failed, []);
});
test("unknown status remains protected", async () => {
  await assert.rejects(inspect(client(ended(), { type: "futureStatus" }), true, true), /unknown/);
});
test("a failed label without readable turns is not idle", async () => {
  for (const turns of [undefined, {}, [], [{ status: "failed" }], [{ status: "inProgress" }], [{ status: "completed" }]]) {
    await assert.rejects(inspect(client(ended({ turns })), true, true), /unconfirmed/);
  }
});
test("an older active turn also blocks recovery", async () => {
  await assert.rejects(inspect(client(ended({ turns: [{ status: "inProgress" }, { status: "failed" }] })), true, true), /unconfirmed/);
});
test("active flags on either snapshot block recovery", async () => {
  await assert.rejects(inspect(client(ended(), { type: "systemError", activeFlags: ["waitingOnApproval"] }), true, true), /unconfirmed/);
  await assert.rejects(inspect(client(ended({ status: { type: "systemError", activeFlags: ["waitingOnUserInput"] } })), true, true), /unconfirmed/);
});
test("a running item blocks recovery even in a failed turn", async () => {
  await assert.rejects(inspect(client(ended({ turns: [{ status: "failed", items: [{ status: "inProgress" }] }] })), true, true), /unconfirmed/);
});
test("an unreadable task blocks recovery", async () => {
  const c = client(ended());
  const request = c.request;
  c.request = async (method, params) => {
    if (params?.includeTurns) throw new Error("read failed");
    return request(method, params);
  };
  await assert.rejects(inspect(c, true, true), /read failed/);
});

test("only a matching recent completion proves our ephemeral probe ended", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-completed-probe-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "probe.json");
  const now = Math.floor(Date.now() / 1000);
  const record = { owner: "codex_tunnel_health", threadId: "task", turnId: "owned-turn", turnStatus: "failed", completedAt: now };
  const metadata = { ephemeral: true, updatedAt: now - 1, status: { type: "systemError" } };
  const c = { async request(method, params) {
    if (method === "thread/loaded/list") return { data: ["task"] };
    if (params.includeTurns) throw new Error("ephemeral history unavailable");
    return { thread: metadata };
  } };
  fs.writeFileSync(`${file}.completed`, JSON.stringify(record));
  assert.equal((await inspect(c, true, true, file)).failed[0].ownedProbe, true);
  for (const overrides of [
    { owner: "other" }, { threadId: "other" }, { turnId: null },
    { turnStatus: "inProgress" }, { completedAt: now - 700 }, { completedAt: now + 100 },
  ]) {
    fs.writeFileSync(`${file}.completed`, JSON.stringify({ ...record, ...overrides }));
    await assert.rejects(inspect(c, true, true, file), /history unavailable/);
  }
  fs.writeFileSync(`${file}.completed`, JSON.stringify(record));
  metadata.updatedAt = now + 1;
  assert.equal((await inspect(c, true, true, file)).failed[0].ownedProbe, true);
  metadata.updatedAt = now - 1;
  metadata.ephemeral = false;
  await assert.rejects(inspect(c, true, true, file), /history unavailable/);
});
