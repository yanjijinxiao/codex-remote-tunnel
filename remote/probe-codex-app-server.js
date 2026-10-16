#!/usr/bin/env node

const crypto = require("node:crypto");
const net = require("node:net");
const fs = require("node:fs");
const path = require("node:path");
const defaultStateFile = path.join(require("node:os").homedir(), ".codex/remote-tunnel/health-probe-active.json");

const socketPath = process.argv[2];
const mode = process.argv[3] || "status";
const timeoutMs = Number(process.argv[4] || 25000);
let idleStateConfirmed = false;

if (require.main === module && !socketPath) {
  console.error("usage: probe-codex-app-server.js SOCKET [activity|status|turn|progress] [TIMEOUT_MS]");
  process.exit(64);
}

class UnixWebSocket {
  constructor(path, timeout) {
    this.path = path;
    this.timeout = timeout;
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Set();
    this.fragmentOpcode = null;
    this.fragments = [];
  }

  async connect() {
    const key = crypto.randomBytes(16).toString("base64");
    this.socket = net.createConnection({ path: this.path });

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("unix socket connect timeout")), this.timeout);
      this.socket.once("connect", () => {
        clearTimeout(timer);
        resolve();
      });
      this.socket.once("error", reject);
    });

    this.socket.write([
      "GET / HTTP/1.1",
      "Host: localhost",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Key: ${key}`,
      "Sec-WebSocket-Version: 13",
      "",
      "",
    ].join("\r\n"));

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("websocket handshake timeout")), this.timeout);
      const onData = (chunk) => {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        const end = this.buffer.indexOf("\r\n\r\n");
        if (end === -1) return;
        const headers = this.buffer.subarray(0, end).toString("utf8");
        this.buffer = this.buffer.subarray(end + 4);
        this.socket.off("data", onData);
        clearTimeout(timer);
        if (!headers.startsWith("HTTP/1.1 101")) {
          reject(new Error(`websocket handshake failed: ${headers.split("\r\n")[0]}`));
          return;
        }
        resolve();
      };
      this.socket.on("data", onData);
      this.socket.once("error", reject);
    });

    this.socket.on("data", (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.parseFrames();
    });
    this.socket.on("error", (error) => this.failAll(error));
    this.socket.on("close", () => this.failAll(new Error("app-server websocket closed")));
    this.parseFrames();
  }

  frame(opcode, payload = Buffer.alloc(0)) {
    const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
    const mask = crypto.randomBytes(4);
    let header;
    if (body.length < 126) {
      header = Buffer.from([0x80 | opcode, 0x80 | body.length]);
    } else if (body.length <= 0xffff) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 126;
      header.writeUInt16BE(body.length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(body.length), 2);
    }
    const masked = Buffer.alloc(body.length);
    for (let i = 0; i < body.length; i += 1) masked[i] = body[i] ^ mask[i % 4];
    return Buffer.concat([header, mask, masked]);
  }

  send(message) {
    this.socket.write(this.frame(0x1, JSON.stringify(message)));
  }

  notify(method, params = {}) {
    this.send({ method, params });
  }

  request(method, params = {}, requestTimeout = this.timeout) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, requestTimeout);
      this.pending.set(id, { resolve, reject, timer, method });
      this.send({ method, id, params });
    });
  }

  onMessage(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  parseFrames() {
    while (this.buffer.length >= 2) {
      const first = this.buffer[0];
      const second = this.buffer[1];
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.buffer.length < 4) return;
        length = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.buffer.length < 10) return;
        const value = this.buffer.readBigUInt64BE(2);
        if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("websocket frame too large");
        length = Number(value);
        offset = 10;
      }
      const masked = (second & 0x80) !== 0;
      const maskLength = masked ? 4 : 0;
      if (this.buffer.length < offset + maskLength + length) return;
      const mask = masked ? this.buffer.subarray(offset, offset + 4) : null;
      offset += maskLength;
      const payload = Buffer.from(this.buffer.subarray(offset, offset + length));
      this.buffer = this.buffer.subarray(offset + length);
      if (mask) {
        for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
      }
      this.handleFrame(first & 0x0f, (first & 0x80) !== 0, payload);
    }
  }

  handleFrame(opcode, fin, payload) {
    if (opcode === 0x8) {
      this.socket.end();
      return;
    }
    if (opcode === 0x9) {
      this.socket.write(this.frame(0xA, payload));
      return;
    }
    if (opcode === 0xA) return;
    if (opcode === 0x1 || opcode === 0x2) {
      this.fragmentOpcode = opcode;
      this.fragments = [payload];
    } else if (opcode === 0x0 && this.fragmentOpcode !== null) {
      this.fragments.push(payload);
    } else {
      return;
    }
    if (!fin) return;
    const complete = Buffer.concat(this.fragments);
    const completeOpcode = this.fragmentOpcode;
    this.fragmentOpcode = null;
    this.fragments = [];
    if (completeOpcode !== 0x1) return;
    let message;
    try {
      message = JSON.parse(complete.toString("utf8"));
    } catch (error) {
      this.failAll(new Error(`invalid app-server JSON: ${error.message}`));
      return;
    }
    if (message.id !== undefined && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id);
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(`${pending.method}: ${message.error.message || JSON.stringify(message.error)}`));
      else pending.resolve(message.result);
    }
    for (const listener of this.listeners) listener(message);
  }

  failAll(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  close() {
    if (this.socket && !this.socket.destroyed) this.socket.end(this.frame(0x8));
  }
}

function arrayFromResult(result) {
  if (Array.isArray(result)) return result;
  for (const key of ["data", "threads", "threadIds", "items"]) {
    if (Array.isArray(result?.[key])) return result[key];
  }
  return [];
}

function statusType(thread) {
  return thread?.status?.type || thread?.status || "unknown";
}

async function inspect(client, stopWhenActive, skipModels, stateFile = defaultStateFile) {
  idleStateConfirmed = false;
  const loaded = await client.request("thread/loaded/list", {});
  if (loaded?.nextCursor) throw new Error("loaded task inventory is incomplete; preserving all tasks");
  const loadedRows = arrayFromResult(loaded);
  const ids = loadedRows.map((row) => typeof row === "string" ? row : row.id || row.threadId).filter(Boolean);
  const active = [];
  const failed = [];
  if (ids.length > 100) throw new Error("loaded task inventory exceeds inspection bound");
  for (const threadId of ids) {
    const result = await client.request("thread/read", { threadId, includeTurns: false });
    const thread = result?.thread || result;
    if (statusType(thread) === "active") active.push(threadId);
    else if (statusType(thread) === "systemError") {
      let ownedCompletion;
      try { ownedCompletion = JSON.parse(fs.readFileSync(`${stateFile}.completed`, "utf8")); } catch {}
      // Ephemeral threads have no readable turn history. Only our recorded
      // turn/completed event can establish a terminal health probe here.
      // Their updatedAt can be synthesized at read time, so it is not activity evidence.
      if (thread.ephemeral === true && !thread.status?.activeFlags?.length &&
          ownedCompletion?.owner === "codex_tunnel_health" &&
          ownedCompletion.threadId === threadId && ownedCompletion.turnId &&
          ownedCompletion.turnStatus === "failed" &&
          Number.isInteger(ownedCompletion.completedAt) &&
          Date.now() / 1000 >= ownedCompletion.completedAt &&
          Date.now() / 1000 - ownedCompletion.completedAt < 600) {
        failed.push({ threadId, turnId: ownedCompletion.turnId, ownedProbe: true });
        continue;
      }
      // An error label alone does not prove that every turn has stopped.
      const detail = await client.request("thread/read", { threadId, includeTurns: true });
      const current = detail?.thread || detail;
      if (statusType(current) === "active") {
        active.push(threadId);
        continue;
      }
      const turns = current.turns;
      const latest = Array.isArray(turns) ? turns.at(-1) : undefined;
      if (!["systemError", "idle"].includes(statusType(current)) ||
          thread.status?.activeFlags?.length || current.status?.activeFlags?.length ||
          !Array.isArray(turns) || !turns.length || !latest.id || latest.status !== "failed" ||
          turns.some(turn => !["completed", "failed", "interrupted"].includes(turn.status)) ||
          latest.items?.some(item => ["inProgress", "in_progress", "running"].includes(item.status))) {
        throw new Error("failed task has unconfirmed activity; preserving all tasks");
      }
      failed.push({ threadId, turnId: latest.id });
    } else if (!["idle", "notLoaded"].includes(statusType(thread))) throw new Error("task activity is unknown; preserving all tasks");
  }

  // An active turn is enough to prove that the app-server protocol is alive,
  // and it must be protected even if an unrelated upstream model refresh fails.
  if (stopWhenActive && active.length > 0) {
    return { modelCount: null, loadedCount: ids.length, active, failed };
  }

  idleStateConfirmed = active.length === 0;

  if (skipModels) {
    return { modelCount: null, loadedCount: ids.length, active, failed };
  }

  const models = await client.request("model/list", { limit: 5, includeHidden: false });
  const modelRows = arrayFromResult(models);
  if (modelRows.length === 0) throw new Error("model/list returned no models");
  return { modelCount: modelRows.length, loadedCount: ids.length, active, failed };
}

function saveProbe(stateFile, state) {
  const temporary = `${stateFile}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify({ owner: "codex_tunnel_health", ...state }), { mode: 0o600 });
  fs.renameSync(temporary, stateFile);
}

async function recoverOwnedProbe(client, stateFile = defaultStateFile) {
  if (!fs.existsSync(stateFile)) return;
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  if (state.owner !== "codex_tunnel_health" || !state.threadId) throw new Error("invalid health probe state");
  let thread;
  try {
    ({ thread } = await client.request("thread/read", { threadId: state.threadId, includeTurns: false }, 3000));
  } catch (error) {
    if (!/not found|not loaded/i.test(error.message)) throw error;
    fs.unlinkSync(stateFile);
    return;
  }
  if (!thread.ephemeral) throw new Error("refusing to interrupt a persistent task from probe state");
  if (statusType(thread) === "active") {
    if (!state.turnId) throw new Error("owned probe is active but its turn id is unknown");
    await client.request("turn/interrupt", { threadId: state.threadId, turnId: state.turnId }, 3000);
    console.error(JSON.stringify({ recoveredProbe: state.threadId }));
  }
  fs.unlinkSync(stateFile);
}

async function probeTurn(client, initial, duration = timeoutMs, stateFile = defaultStateFile) {
  if (initial.active.length > 0) {
    console.log(JSON.stringify({ state: "active", ...initial }));
    process.exitCode = 3;
    return;
  }

  const started = await client.request("thread/start", {
    cwd: process.env.CODEX_PROBE_CWD || require("node:os").homedir(),
    ephemeral: true,
    approvalPolicy: "never",
    sandbox: "read-only",
  });
  const threadId = started?.thread?.id || started?.threadId;
  if (!threadId) throw new Error("thread/start returned no thread id");
  saveProbe(stateFile, { threadId });

  let text = "";
  let completed;
  let turnId;
  let timer;
  let off;
  let stop;
  const done = new Promise((resolve, reject) => {
    stop = () => reject(new Error("probe interrupted"));
    timer = setTimeout(() => reject(new Error("probe turn timed out")), duration);
    off = client.onMessage((message) => {
      const params = message.params || {};
      const eventThreadId = params.threadId || params.thread?.id || params.turn?.threadId;
      if (eventThreadId !== threadId) return;
      if (message.method === "turn/started") {
        turnId = params.turn?.id;
        saveProbe(stateFile, { threadId, turnId });
      }
      if (message.method === "item/agentMessage/delta") text += params.delta || "";
      if (message.method === "item/completed" && params.item?.type === "agentMessage") {
        text = params.item.text || text;
      }
      if (message.method === "turn/completed") {
        clearTimeout(timer);
        off();
        completed = params.turn || {};
        resolve();
      }
    });
  });
  done.catch(() => {});
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);

  try {
    const response = await Promise.race([client.request("turn/start", {
      threadId,
      input: [{ type: "text", text: "Reply exactly READY. Do not run tools or modify files." }],
    }), done.then(() => null)]);
    if (response?.turn?.id) {
      turnId = response.turn.id;
      saveProbe(stateFile, { threadId, turnId });
    }
    await done;
  } finally {
    clearTimeout(timer);
    off?.();
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGINT", stop);
    if (completed) {
      saveProbe(`${stateFile}.completed`, {
        threadId, turnId, turnStatus: completed.status,
        completedAt: Math.floor(Date.now() / 1000),
      });
      fs.rmSync(stateFile, { force: true });
    } else {
      // Persist ownership if cleanup cannot reach the server; the next check retries it.
      await recoverOwnedProbe(client, stateFile).catch(error => {
        console.error(JSON.stringify({ probeCleanupDeferred: threadId, error: error.message }));
      });
    }
  }
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized !== "READY" || completed?.status !== "completed") {
    const detail = String(completed?.error?.message || "").replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]").slice(0, 300);
    throw new Error(`probe turn failed status=${completed?.status || "unknown"} text=${normalized.slice(0, 200)} error=${detail}`);
  }
  console.log(JSON.stringify({ state: "healthy", ...initial, turnStatus: completed?.status || "completed" }));
}

async function main() {
  const client = new UnixWebSocket(socketPath, timeoutMs);
  try {
    await client.connect();
    await client.request("initialize", {
      clientInfo: {
        name: "codex_tunnel_health",
        title: "Codex Tunnel Health",
        version: "1.0.0",
      },
      capabilities: { experimentalApi: true },
    });
    client.notify("initialized", {});
    if (["turn", "progress"].includes(mode)) await recoverOwnedProbe(client);
    const state = await inspect(client, mode === "turn", ["activity", "progress"].includes(mode));
    if (mode === "turn") await probeTurn(client, state);
    else if (mode === "progress") {
      const progress = await require("./task-progress.js").monitor(client, state.active);
      console.log(JSON.stringify(progress));
      process.exitCode = progress.state === "needs-attention" ? 4 : progress.state === "active" ? 3 : 0;
    }
    else if (mode === "activity") {
      console.log(JSON.stringify({ state: state.active.length > 0 ? "active" : "idle", ...state }));
    } else console.log(JSON.stringify({ state: "healthy", ...state }));
  } catch (error) {
    console.error(JSON.stringify({
      state: "error",
      safeToRestart: idleStateConfirmed,
      error: error.message,
    }));
    process.exitCode = 1;
  } finally {
    client.close();
  }
}

if (require.main === module) main();
module.exports = { UnixWebSocket, probeTurn, recoverOwnedProbe, inspect };
