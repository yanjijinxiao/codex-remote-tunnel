const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

function shell(t, body, decision = "fresh") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-auth-routing-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "auth-refresh-policy.py"), `print('${JSON.stringify({ state: decision })}')\n`);
  const setup = `source "$1"
STATE_DIR="$2"
LOG="$2/log"
AUTH_CHECK_FILE="$2/auth-check"
CONTROL_PENDING_FILE="$2/pending"
CONTROL_PROBE_FAIL_FILE="$2/probe-fail"
CONTROL_VERIFIED_FILE="$2/verified"
run_remote() { echo '{}' ; }
sync_auth() { echo sync >> "$STATE_DIR/syncs"; }
`;
  const result = spawnSync("/bin/bash", ["-c", setup + body, "test", path.join(__dirname, "check-tunnel.sh"), dir], { encoding: "utf8", timeout: 5000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
}

test("expired auth is repaired independently of route HTTP status", t => {
  shell(t, `
PROXY_KIND=upstream
proactive_auth_check
[ -f "$STATE_DIR/syncs" ] && [ -f "$CONTROL_PENDING_FILE" ]
`, "sync-needed");
});
test("auth checks respect five-minute interval", t => {
  shell(t, `
write_number "$AUTH_CHECK_FILE" "$(date +%s)"
run_remote() { exit 80; }
proactive_auth_check
[ ! -f "$STATE_DIR/syncs" ]
`, "sync-needed");
});
test("fresh and mismatched credentials are not overwritten", t => {
  for (const decision of ["fresh", "blocked"]) shell(t, `
proactive_auth_check || true
[ ! -f "$STATE_DIR/syncs" ]
`, decision);
});
test("SSH failure never causes credential copying", t => {
  shell(t, `
run_remote() { return 255; }
proactive_auth_check || true
[ ! -f "$STATE_DIR/syncs" ]
`, "sync-needed");
});
test("auth sync failure does not mark verification successful", t => {
  shell(t, `
sync_auth() { return 1; }
proactive_auth_check || true
[ ! -f "$CONTROL_VERIFIED_FILE" ] && [ ! -f "$CONTROL_PENDING_FILE" ]
`, "sync-needed");
});
test("healthy proxy avoids an extra model catalog request", t => {
  shell(t, `
proxy_check() { PROXY_KIND=ok; return 0; }
authenticated_models_check() { exit 80; }
primary_route_check
`);
});
test("HTTP 500 can fall back to an authenticated success", t => {
  shell(t, `
proxy_check() { PROXY_KIND=upstream; PROXY_RESULT=HTTP500; return 1; }
authenticated_models_check() { AUTHENTICATED_RESULT='http=200 content-type=application/json'; return 0; }
primary_route_check
[ "$PROXY_KIND" = ok ]
`);
});
test("authenticated failure remains unhealthy and does not recycle SSH", t => {
  shell(t, `
proxy_check() { PROXY_KIND=upstream; PROXY_RESULT=HTTP500; return 1; }
authenticated_models_check() { AUTHENTICATED_RESULT=http500; AUTHENTICATED_STATUS=0; return 1; }
if primary_route_check; then exit 80; fi
[ "$PROXY_KIND" = upstream ]
`);
});
test("SSH failures do not trigger a second full network probe", t => {
  shell(t, `
proxy_check() { PROXY_KIND=ssh; return 1; }
authenticated_models_check() { exit 80; }
if primary_route_check; then exit 81; fi
`);
});
test("public transport probe uses GET, not HEAD", t => {
  shell(t, `
run_remote() {
  case "$1" in *' -I '*) return 80;; esac
  printf 'HTTP/1.1 401 Unauthorized content-type=application/json cf-mitigated='
}
proxy_check
`);
});
