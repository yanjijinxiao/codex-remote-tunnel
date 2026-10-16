const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const STALL_MS = 30 * 60 * 1000;
const MAX_GAP_MS = 10 * 60 * 1000;
const SAMPLE_MS = 60 * 1000;
const NETWORK_ERROR = /connection failed|error sending request|stream disconnected|reconnecting|remote compact.*(?:failed|error)/i;

function save(file, value) {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(temporary, file);
}

function load(file) {
  if (!fs.existsSync(file)) return { version: 1, turns: {} };
  const state = JSON.parse(fs.readFileSync(file, "utf8"));
  if (state.version !== 1 || !state.turns) throw new Error("invalid task progress state");
  return state;
}

function historyEvidence(thread, turn) {
  if (!thread.path || thread.ephemeral) throw new Error("persistent history unavailable");
  const fd = fs.openSync(thread.path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error("history is not a regular file");
    const length = Math.min(stat.size, 512 * 1024);
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, stat.size - length);
    const lines = buffer.toString("utf8").split("\n");
    if (stat.size > length) lines.shift();
    let currentTurn;
    let networkFailure = false;
    let hasWork = false;
    for (const line of lines) {
      if (!line.trim()) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { throw new Error("incomplete history snapshot"); }
      const payload = entry.payload || {};
      if (entry.type === "event_msg" && payload.type === "task_started") {
        currentTurn = payload.turn_id;
        networkFailure = false;
        hasWork = false;
      }
      if (entry.type === "turn_context" && payload.turn_id !== currentTurn) {
        currentTurn = payload.turn_id;
        networkFailure = false;
        hasWork = false;
      }
      if (currentTurn !== turn.id) continue;
      if (entry.type === "event_msg" && ["error", "warning", "stream_error"].includes(payload.type)) {
        if (NETWORK_ERROR.test(JSON.stringify(payload))) networkFailure = true;
      }
      // Do not trust an incomplete API item list when the rollout shows actual work.
      if (entry.type === "response_item" && !(payload.type === "message" && payload.role === "user")) hasWork = true;
      if (entry.type === "event_msg" && /agent_|exec_|tool_|patch_|approval|request_user/.test(payload.type || "")) hasWork = true;
    }
    const after = fs.fstatSync(fd);
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) throw new Error("history changed during observation");
    return {
      stamp: `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`,
      networkFailure: currentTurn === turn.id && networkFailure,
      emptyTurnConfirmed: currentTurn === turn.id && !hasWork,
    };
  } finally { fs.closeSync(fd); }
}

function snapshot(thread) {
  const turn = thread.turns?.at(-1);
  if (thread.status?.type !== "active" || turn?.status !== "inProgress" || !turn.id) {
    throw new Error("active turn could not be confirmed");
  }
  const evidence = historyEvidence(thread, turn);
  const flags = thread.status.activeFlags;
  const waiting = !Array.isArray(flags) || flags.length > 0;
  const items = turn.items || [];
  const empty = items.length > 0 && items.every(item => item.type === "userMessage");
  const lastItem = items.at(-1);
  const busyTool = lastItem && lastItem.type !== "userMessage" && ["inProgress", "pending", "running"].includes(lastItem.status);
  const hash = value => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
  const content = { turnId: turn.id, status: turn.status, items, flags };
  const fingerprint = hash({ ...content, error: turn.error, stamp: evidence.stamp });
  // Repeated transport errors and elapsed-time counters are not useful progress.
  // Keep the full stamp separately for the last-moment recovery safety check.
  const progressFingerprint = empty && evidence.emptyTurnConfirmed ? hash(content) : fingerprint;
  return { threadId: thread.id, turnId: turn.id, fingerprint, waiting, busyTool: !!busyTool,
    progressFingerprint, empty: empty && evidence.emptyTurnConfirmed, networkFailure: evidence.networkFailure };
}

function observe(current, previous, now) {
  const continuous = previous && previous.turnId === current.turnId &&
    (previous.progressFingerprint || previous.fingerprint) === (current.progressFingerprint || current.fingerprint) && now >= previous.lastSeen &&
    now - previous.lastSeen <= MAX_GAP_MS;
  const entry = { ...current, since: continuous ? previous.since : now, lastSeen: now,
    samples: continuous ? previous.samples : 1, sampledAt: continuous ? previous.sampledAt : now };
  if (continuous && now - entry.sampledAt >= SAMPLE_MS) {
    entry.samples += 1;
    entry.sampledAt = now;
  }
  entry.stalled = !current.waiting && !current.busyTool && entry.samples >= 3 && now - entry.since >= STALL_MS;
  entry.eligible = entry.stalled && current.empty && current.networkFailure;
  return entry;
}

async function noBackgroundWork(client, threadId) {
  const result = await client.request("thread/backgroundTerminals/list", { threadId }, 3000);
  if (!Array.isArray(result?.data) || result.nextCursor) throw new Error("background terminal status unavailable or incomplete");
  return result.data.length === 0;
}

async function recover(client, entry, state, stateFile, now, readSnapshot = snapshot) {
  if (!entry.eligible) return { recovered: false, reason: "not-eligible" };
  if (state.attempts?.[entry.threadId]?.turnId === entry.turnId) {
    return { recovered: false, reason: "previous-attempt-needs-review" };
  }
  if (now - (state.lastRecovery || 0) < STALL_MS) return { recovered: false, reason: "recovery-cooldown" };
  if (!await noBackgroundWork(client, entry.threadId)) return { recovered: false, reason: "background-command" };
  const read = async () => {
    const { thread } = await client.request("thread/read", { threadId: entry.threadId, includeTurns: true }, 5000);
    const current = readSnapshot(thread);
    if (current.turnId !== entry.turnId || current.fingerprint !== entry.fingerprint ||
        current.waiting || !current.empty || !current.networkFailure) throw new Error("task changed; recovery cancelled");
    return thread;
  };
  const thread = await read();
  const backup = `${thread.path}.before-health-recovery-${now}`;
  fs.copyFileSync(thread.path, backup, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(backup, 0o600);
  // Recheck after backup, and persist the attempt before issuing any interrupt.
  await read();
  if (!await noBackgroundWork(client, entry.threadId)) return { recovered: false, reason: "background-command" };
  await read();
  state.lastRecovery = now;
  state.attempts ||= {};
  state.attempts[entry.threadId] = { threadId: entry.threadId, turnId: entry.turnId, backup, at: now };
  save(stateFile, state);
  await client.request("turn/interrupt", { threadId: entry.threadId, turnId: entry.turnId }, 5000);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const { thread: current } = await client.request("thread/read", { threadId: entry.threadId, includeTurns: true }, 3000);
    const latest = current.turns?.at(-1);
    if (latest?.id === entry.turnId && latest.status === "interrupted" && current.status?.type === "idle") {
      return { recovered: true, threadId: entry.threadId, turnId: entry.turnId, backup };
    }
    if (latest?.id !== entry.turnId) throw new Error("a new turn started; no further recovery allowed");
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error("interrupt not confirmed; preserving server and awaiting review");
}

async function monitor(client, active, options = {}) {
  const stateFile = options.stateFile || path.join(require("node:os").homedir(), ".codex/remote-tunnel/task-progress.json");
  const now = options.now ?? Date.now();
  const state = load(stateFile);
  const previous = state.turns;
  state.turns = {};
  const tasks = [];
  const recovered = [];
  for (const threadId of active) {
    try {
      const { thread } = await client.request("thread/read", { threadId, includeTurns: true }, 5000);
      if (thread.status?.type === "idle") continue;
      const entry = observe(snapshot(thread), previous[threadId], now);
      state.turns[threadId] = entry;
      let result;
      if (entry.eligible) result = await recover(client, entry, state, stateFile, now);
      if (result?.recovered) {
        recovered.push(result);
        delete state.turns[threadId];
      } else {
        tasks.push({ threadId, turnId: entry.turnId, state: entry.waiting || entry.busyTool ? "protected" : entry.stalled ? "needs-attention" : "observing",
          unchangedSeconds: Math.floor((now - entry.since) / 1000), samples: entry.samples,
          reason: result?.reason || (entry.stalled ? "no-progress-auto-recovery-not-safe" : "active-not-proof-of-health") });
      }
    } catch (error) {
      tasks.push({ threadId, state: "needs-attention", reason: error.message });
    }
  }
  save(stateFile, state);
  const attention = tasks.some(task => task.state === "needs-attention");
  return { state: attention ? "needs-attention" : tasks.length ? "active" : "idle", tasks, recovered };
}

module.exports = { snapshot, observe, recover, monitor, historyEvidence, STALL_MS, MAX_GAP_MS };
