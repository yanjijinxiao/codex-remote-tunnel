const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const script = path.join(__dirname, "check-tunnel.sh");

function shell(t, body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-health-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const setup = `source "$1"
STATE_DIR="$2"
LOG="$2/log"
for key in FAIL_FILE REPAIR_FILE REPAIR_PID_FILE TUNNEL_PID_FILE CONTROL_REPAIR_FILE CONTROL_DEGRADED_FILE CONTROL_PENDING_FILE CONTROL_PROBE_FAIL_FILE CONTROL_PROBE_CHECK_FILE CONTROL_RESTART_FILE CONTROL_RECYCLE_FILE CONTROL_VERIFIED_FILE HEALTH_FILE TASK_PROGRESS_UNAVAILABLE_FILE; do
  printf -v "$key" '%s/%s' "$2" "$key"
done
run_remote() { echo 'unexpected live remote call' >&2; return 99; }
restart_control_plane() { echo restart >> "$STATE_DIR/restarts"; }
`;
  const result = spawnSync("/bin/bash", ["-c", setup + body, "test", script, dir], { encoding: "utf8", timeout: 5000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return { dir, result };
}

test("busy functional probe retains pending verification", t => {
  shell(t, `
app_server_protocol_probe() { APP_SERVER_RESULT='{"state":"active"}'; return 3; }
write_number "$CONTROL_PENDING_FILE" 1
write_number "$CONTROL_PROBE_FAIL_FILE" 1
process_control_plane_probe test force
[ -f "$CONTROL_PENDING_FILE" ] && [ ! -f "$CONTROL_VERIFIED_FILE" ] && [ "$(read_number "$CONTROL_PROBE_FAIL_FILE")" = 0 ]
`);
});
test("deferred recycle still samples task progress each cycle", t => {
  shell(t, `
process_task_progress() { TASK_PROGRESS_STATE=active; echo sample >> "$STATE_DIR/samples"; }
process_deferred_tunnel_recycle() { exit 88; }
write_number "$CONTROL_RECYCLE_FILE" 1
control_plane_health_cycle
control_plane_health_cycle
[ "$(wc -l < "$STATE_DIR/samples" | tr -d ' ')" = 2 ] && [ -f "$CONTROL_PENDING_FILE" ]
`);
});
test("uncertain progress stops automatic control-plane restart", t => {
  shell(t, `
process_task_progress() { TASK_PROGRESS_STATE=needs-attention; }
process_deferred_tunnel_recycle() { exit 88; }
process_control_plane_probe() { exit 89; }
write_number "$CONTROL_RECYCLE_FILE" 1
control_plane_health_cycle
[ ! -f "$STATE_DIR/restarts" ]
`);
});
test("idle functional success records real verification", t => {
  shell(t, `
app_server_protocol_probe() { APP_SERVER_RESULT='{"state":"healthy"}'; return 0; }
write_number "$CONTROL_PENDING_FILE" 1
process_control_plane_probe test force
[ ! -f "$CONTROL_PENDING_FILE" ] && [ "$(read_number "$CONTROL_VERIFIED_FILE")" -gt 0 ]
`);
});
test("restart still requires two failures and a fresh idle check", t => {
  shell(t, `
app_server_protocol_probe() {
  if [ "$1" = activity ]; then APP_SERVER_RESULT='{"state":"idle"}'; return 0; fi
  APP_SERVER_RESULT='{"safeToRestart":true}'; APP_SERVER_KIND=protocol; APP_SERVER_STATUS=1; return 1
}
write_number "$CONTROL_PENDING_FILE" 1
process_control_plane_probe test force || true
[ ! -f "$STATE_DIR/restarts" ] || exit 90
process_control_plane_probe test force
[ -f "$STATE_DIR/restarts" ]
`);
});
test("a new active task vetoes a previously justified restart", t => {
  shell(t, `
app_server_protocol_probe() {
  if [ "$1" = activity ]; then APP_SERVER_RESULT='{"state":"active"}'; return 0; fi
  APP_SERVER_RESULT='{"safeToRestart":true}'; APP_SERVER_KIND=protocol; APP_SERVER_STATUS=1; return 1
}
write_number "$CONTROL_PENDING_FILE" 1
write_number "$CONTROL_PROBE_FAIL_FILE" 1
process_control_plane_probe test force || true
[ ! -f "$STATE_DIR/restarts" ]
`);
});
test("restart cooldown is retained", t => {
  shell(t, `
app_server_protocol_probe() { APP_SERVER_RESULT='{"safeToRestart":true}'; APP_SERVER_KIND=protocol; APP_SERVER_STATUS=1; return 1; }
write_number "$CONTROL_PENDING_FILE" 1
write_number "$CONTROL_PROBE_FAIL_FILE" 1
write_number "$CONTROL_RESTART_FILE" "$(date +%s)"
process_control_plane_probe test force || true
[ ! -f "$STATE_DIR/restarts" ]
`);
});

for (const [name, task, flag, verified, expected] of [
  ["proxy alone is not healthy", "unknown", "", false, "unverified"],
  ["busy is not healthy", "active", "", true, "busy-unverified"],
  ["stalled is actionable", "needs-attention", "", true, "needs-attention"],
  ["pending overrides earlier success", "idle", "CONTROL_PENDING_FILE", true, "verification-pending"],
  ["deferred recycle is pending", "idle", "CONTROL_RECYCLE_FILE", true, "verification-pending"],
  ["auth failure overrides success", "idle", "CONTROL_DEGRADED_FILE", true, "degraded"],
  ["verified idle has bounded meaning", "idle", "", true, "verified-idle"],
]) {
  test(name, t => {
    const { dir } = shell(t, `
PROXY_KIND=ok
TASK_PROGRESS_STATE=${task}
${flag ? `write_number "$${flag}" 1` : ""}
${verified ? 'write_number "$CONTROL_VERIFIED_FILE" "$(date +%s)"' : ""}
publish_health
`);
    const status = JSON.parse(fs.readFileSync(path.join(dir, "HEALTH_FILE")));
    assert.equal(status.status, expected);
    assert.equal(status.compact, "not-verified");
    assert.equal(fs.statSync(path.join(dir, "HEALTH_FILE")).mode & 0o777, 0o600);
  });
}
test("old verification expires", t => {
  const { dir } = shell(t, `
PROXY_KIND=ok
TASK_PROGRESS_STATE=idle
write_number "$CONTROL_VERIFIED_FILE" 1
publish_health
`);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "HEALTH_FILE"))).status, "unverified");
});
test("transport failures cannot reuse a healthy status", t => {
  const { dir } = shell(t, `
PROXY_KIND=transport
TASK_PROGRESS_STATE=idle
write_number "$CONTROL_VERIFIED_FILE" "$(date +%s)"
publish_health
`);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "HEALTH_FILE"))).status, "transport-unhealthy");
});
test("targeted recovery schedules verification", t => {
  shell(t, `
app_server_protocol_probe() { APP_SERVER_RESULT='{"state":"idle","tasks":[],"recovered":[{"threadId":"task"}]}'; return 0; }
process_task_progress
[ -f "$CONTROL_PENDING_FILE" ] && [ "$TASK_PROGRESS_STATE" = idle ]
`);
});
test("invalid progress output never proves idle", t => {
  shell(t, `
app_server_protocol_probe() { APP_SERVER_RESULT='not-json'; return 0; }
process_task_progress
[ "$TASK_PROGRESS_STATE" = unknown ] && [ ! -f "$CONTROL_PENDING_FILE" ]
`);
});
test("probe cleanup diagnostics do not corrupt the structured progress report", t => {
  shell(t, `
app_server_protocol_probe() { APP_SERVER_RESULT=$'{"recoveredProbe":"owned"}\\n{"state":"active","tasks":[{"threadId":"task"}],"recovered":[]}'; return 3; }
process_task_progress
[ "$TASK_PROGRESS_STATE" = active ]
`);
});
test("prolonged unavailable progress becomes actionable without killing tasks", t => {
  shell(t, `
app_server_protocol_probe() { APP_SERVER_RESULT='timeout'; return 124; }
write_number "$TASK_PROGRESS_UNAVAILABLE_FILE" 1
process_task_progress
[ "$TASK_PROGRESS_STATE" = needs-attention ] && [ ! -f "$STATE_DIR/restarts" ]
`);
});
