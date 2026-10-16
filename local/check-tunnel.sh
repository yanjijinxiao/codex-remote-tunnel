#!/bin/bash
set -u

LABEL="com.codex.remote-tunnel"
REMOTE_TARGET="${CODEX_SSH_TARGET:-codex-remote-control}"
SOCKS_PORT="${CODEX_SOCKS_PORT:-1080}"
CLIENT_VERSION="0.154.0"
LOG="$HOME/Library/Logs/codex-remote-tunnel-health.log"
STATE_DIR="$HOME/.codex/remote-tunnel"
FAIL_FILE="$STATE_DIR/remote-tunnel.failcount"
REPAIR_FILE="$STATE_DIR/remote-tunnel.last-repair"
REPAIR_PID_FILE="$STATE_DIR/remote-tunnel.last-repair-pid"
TUNNEL_PID_FILE="$STATE_DIR/remote-tunnel.pid"
CONTROL_REPAIR_FILE="$STATE_DIR/remote-control.last-repair"
CONTROL_DEGRADED_FILE="$STATE_DIR/remote-control.degraded"
CONTROL_PENDING_FILE="$STATE_DIR/remote-control.pending"
CONTROL_PROBE_FAIL_FILE="$STATE_DIR/remote-control.probe-failcount"
CONTROL_PROBE_CHECK_FILE="$STATE_DIR/remote-control.last-probe"
CONTROL_RESTART_FILE="$STATE_DIR/remote-control.last-restart"
CONTROL_RECYCLE_FILE="$STATE_DIR/remote-control.recycle-after-tunnel"
CONTROL_VERIFIED_FILE="$STATE_DIR/remote-control.last-verified"
HEALTH_FILE="$STATE_DIR/remote-health.json"
TASK_PROGRESS_UNAVAILABLE_FILE="$STATE_DIR/remote-progress.unavailable-since"
AUTH_CHECK_FILE="$STATE_DIR/remote-auth.last-check"
AUTH_CHECK_INTERVAL=300
TASK_PROGRESS_STATE="unknown"
TASK_PROGRESS_RESULT="{}"
HEALTH_REPORT_ENABLED=no
LOCK_DIR="$STATE_DIR/remote-tunnel-health.lock"
FAIL_THRESHOLD=2
RECHECK_DELAY=15
REPAIR_COOLDOWN=600
CONTROL_REPAIR_COOLDOWN=300
CONTROL_RESTART_COOLDOWN=600
REMOTE_COMMAND_TIMEOUT=75
CONTROL_PROBE_INTERVAL=600
CONTROL_PENDING_DELAY=60
CONTROL_PROBE_FAIL_THRESHOLD=2
APP_SERVER_PROBE_TIMEOUT=55
APP_SERVER_REQUEST_TIMEOUT=45000
APP_PROXY_WAIT=12
APP_PROXY_STATE="unknown"

log() {
  printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$LOG"
}

publish_health() {
  local overall functional verified now
  now=$(date +%s)
  verified=$(read_number "$CONTROL_VERIFIED_FILE")
  functional=unverified
  if [ "$verified" -gt 0 ] && [ "$now" -ge "$verified" ] &&
     [ $((now - verified)) -lt "$CONTROL_PROBE_INTERVAL" ]; then
    functional=recently-verified
  fi
  if [ "${PROXY_KIND:-unknown}" = upstream ] || [ "${PROXY_KIND:-unknown}" = challenge ]; then
    overall=upstream-unhealthy
    functional=unverified
  elif [ "${PROXY_KIND:-unknown}" != ok ]; then
    overall=transport-unhealthy
    functional=unverified
  elif [ "$TASK_PROGRESS_STATE" = needs-attention ]; then
    overall=needs-attention
  elif [ "$TASK_PROGRESS_STATE" = unknown ]; then
    overall=unverified
  elif [ -f "$CONTROL_DEGRADED_FILE" ]; then
    overall=degraded
  elif [ "$TASK_PROGRESS_STATE" = active ]; then
    overall=busy-unverified
  elif [ -f "$CONTROL_PENDING_FILE" ] || [ -f "$CONTROL_RECYCLE_FILE" ]; then
    overall=verification-pending
  elif [ "$functional" = recently-verified ]; then
    overall=verified-idle
  else
    overall=unverified
  fi
  /usr/bin/python3 - "$HEALTH_FILE" "$overall" "${PROXY_KIND:-unknown}" "$functional" "$verified" "$TASK_PROGRESS_STATE" "$TASK_PROGRESS_RESULT" <<'PY'
import json, os, sys, time
target, overall, transport, functional, verified, tasks, detail = sys.argv[1:]
try:
    detail = json.loads(detail)
except ValueError:
    detail = {"state": "unknown", "error": "invalid progress response"}
value = {"checkedAt": int(time.time()), "status": overall, "transport": transport,
         "modelRequest": functional, "lastVerifiedAt": int(verified), "tasks": tasks,
         "taskDetails": detail, "compact": "not-verified"}
temporary = target + ".%s.tmp" % os.getpid()
fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, "w") as stream:
    json.dump(value, stream)
os.replace(temporary, target)
PY
  log "health status=$overall transport=${PROXY_KIND:-unknown} model-request=$functional tasks=$TASK_PROGRESS_STATE compact=not-verified"
  if [ "$overall" = needs-attention ]; then
    log "ACTION_REQUIRED: task progress stalled or could not be inspected; unsafe interruption was refused. Details: $HEALTH_FILE"
  fi
}

process_task_progress() {
  local result_status now unavailable_since
  app_server_protocol_probe progress
  result_status=$?
  TASK_PROGRESS_RESULT=$(/usr/bin/python3 - "$APP_SERVER_RESULT" "$result_status" <<'PY'
import json, sys
expected = {0: "idle", 3: "active", 4: "needs-attention"}.get(int(sys.argv[2]))
for line in reversed(sys.argv[1].splitlines()):
    try:
        value = json.loads(line)
    except ValueError:
        continue
    if isinstance(value, dict) and value.get("state") == expected and expected and isinstance(value.get("tasks"), list) and isinstance(value.get("recovered"), list):
        print(json.dumps(value, separators=(",", ":")))
        sys.exit(0)
print(json.dumps({"state": "unknown", "error": "progress probe failed or returned invalid data"}))
sys.exit(1)
PY
  )
  if [ "$?" -ne 0 ]; then result_status=1; fi
  case "$result_status" in
    0)
      TASK_PROGRESS_STATE=idle
      case "$TASK_PROGRESS_RESULT" in
        *'"recovered":[]'*) ;;
        *'"recovered":['*) schedule_control_probe "targeted stalled-turn recovery requires verification" ;;
      esac
      ;;
    3) TASK_PROGRESS_STATE=active ;;
    4) TASK_PROGRESS_STATE=needs-attention ;;
    *)
      TASK_PROGRESS_STATE=unknown
      now=$(date +%s)
      unavailable_since=$(read_number "$TASK_PROGRESS_UNAVAILABLE_FILE")
      if [ "$unavailable_since" -eq 0 ] || [ "$now" -lt "$unavailable_since" ]; then
        write_number "$TASK_PROGRESS_UNAVAILABLE_FILE" "$now"
      elif [ $((now - unavailable_since)) -ge 600 ]; then
        TASK_PROGRESS_STATE=needs-attention
        log "ACTION_REQUIRED: task progress inspection has been unavailable for at least 600s; preserving processes"
      fi
      ;;
  esac
  if [ "$result_status" -eq 0 ] || [ "$result_status" -eq 3 ] || [ "$result_status" -eq 4 ]; then
    rm -f "$TASK_PROGRESS_UNAVAILABLE_FILE"
  fi
  log "task progress state=$TASK_PROGRESS_STATE result=$(printf '%s' "$TASK_PROGRESS_RESULT" | tr '\n' ' ' | cut -c1-2000)"
}

read_number() {
  local value
  if [ -f "$1" ]; then
    value=$(tr -cd '0-9' < "$1")
    printf '%s' "${value:-0}"
  else
    printf '0'
  fi
}

write_number() {
  printf '%s\n' "$2" > "$1"
}

run_remote() {
  /usr/bin/python3 "$STATE_DIR/supervise.py" timeout "$REMOTE_COMMAND_TIMEOUT" \
    /usr/bin/ssh \
    -o BatchMode=yes \
    -o ConnectTimeout=10 \
    -o LogLevel=ERROR \
    -o ServerAliveInterval=15 \
    -o ServerAliveCountMax=2 \
    "$REMOTE_TARGET" \
    "$1" 2>&1
}

proxy_check() {
  PROXY_RESULT=$(run_remote '
    response=$(curl --cacert "$HOME/.codex/codex-ca-bundle.pem" -sS -D - -o /dev/null --connect-timeout 8 --max-time 20 --socks5-hostname 127.0.0.1:'"$SOCKS_PORT"' "https://chatgpt.com/backend-api/codex/models?client_version='"$CLIENT_VERSION"'" 2>&1)
    curl_status=$?
    if [ "$curl_status" -ne 0 ]; then
      printf "%s" "$response" | tr "\r\n" "  " | cut -c1-500
      exit "$curl_status"
    fi
    first_line=$(printf "%s\n" "$response" | sed -n "1p" | tr -d "\r")
    content_type=$(printf "%s\n" "$response" | grep -i "^content-type:" | head -n 1 | cut -d: -f2- | tr -d "\r" | sed "s/^[[:space:]]*//")
    mitigation=$(printf "%s\n" "$response" | grep -i "^cf-mitigated:" | head -n 1 | cut -d: -f2- | tr -d "\r" | sed "s/^[[:space:]]*//")
    printf "%s content-type=%s cf-mitigated=%s" "$first_line" "$content_type" "$mitigation"
  ')
  PROXY_STATUS=$?

  if [ "$PROXY_STATUS" -eq 255 ] || [ "$PROXY_STATUS" -eq 124 ]; then
    PROXY_KIND="ssh"
    return 1
  fi
  if [ "$PROXY_STATUS" -ne 0 ]; then
    PROXY_KIND="transport"
    return 1
  fi
  case "$PROXY_RESULT" in
    *"cf-mitigated=challenge"*)
      PROXY_KIND="challenge"
      return 1
      ;;
  esac
  case "$PROXY_RESULT" in
    *"HTTP/1.1 405"*"content-type=application/json"*|*"HTTP/2 405"*"content-type=application/json"*|*"HTTP/1.1 401"*"content-type=application/json"*|*"HTTP/2 401"*"content-type=application/json"*)
      PROXY_KIND="ok"
      return 0
      ;;
  esac
  PROXY_KIND="upstream"
  return 1
}

auth_route_check() {
  AUTH_RESULT=$(run_remote '
    response=$(curl --cacert "$HOME/.codex/codex-ca-bundle.pem" -sS -I --connect-timeout 8 --max-time 20 --socks5-hostname 127.0.0.1:'"$SOCKS_PORT"' https://auth.openai.com/oauth/token 2>&1)
    curl_status=$?
    if [ "$curl_status" -ne 0 ]; then
      printf "%s" "$response" | tr "\r\n" "  " | cut -c1-500
      exit "$curl_status"
    fi
    first_line=$(printf "%s\n" "$response" | sed -n "1p" | tr -d "\r")
    mitigation=$(printf "%s\n" "$response" | grep -i "^cf-mitigated:" | head -n 1 | cut -d: -f2- | tr -d "\r" | sed "s/^[[:space:]]*//")
    printf "%s cf-mitigated=%s" "$first_line" "$mitigation"
  ')
  AUTH_STATUS=$?
  if [ "$AUTH_STATUS" -ne 0 ]; then
    return 1
  fi
  case "$AUTH_RESULT" in
    *"cf-mitigated=challenge"*) return 1 ;;
  esac
  case "$AUTH_RESULT" in
    "HTTP/"*) return 0 ;;
  esac
  return 1
}

authenticated_models_check() {
  AUTHENTICATED_RESULT=$(run_remote '
    token=$(sed -n "s/.*\"access_token\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" "$HOME/.codex/auth.json")
    account=$(sed -n "s/.*\"account_id\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" "$HOME/.codex/auth.json")
    if [ -z "$token" ] || [ -z "$account" ]; then
      printf "remote auth token or account id is missing"
      exit 65
    fi
    headers=$(mktemp)
    trap "rm -f \"$headers\"" EXIT
    metrics=$(curl --cacert "$HOME/.codex/codex-ca-bundle.pem" -sS -D "$headers" -o /dev/null --connect-timeout 8 --max-time 40 --socks5-hostname 127.0.0.1:'"$SOCKS_PORT"' -H "Authorization: Bearer $token" -H "ChatGPT-Account-Id: $account" "https://chatgpt.com/backend-api/codex/models?client_version='"$CLIENT_VERSION"'" -w "http=%{http_code} content-type=%{content_type}" 2>&1)
    curl_status=$?
    mitigation=$(grep -i "^cf-mitigated:" "$headers" | head -n 1 | cut -d: -f2- | tr -d "\r" | sed "s/^[[:space:]]*//")
    printf "%s cf-mitigated=%s" "$metrics" "$mitigation"
    exit "$curl_status"
  ')
  AUTHENTICATED_STATUS=$?
  if [ "$AUTHENTICATED_STATUS" -ne 0 ]; then
    return 1
  fi
  case "$AUTHENTICATED_RESULT" in
    *"cf-mitigated=challenge"*) return 1 ;;
    *"http=200"*"content-type=application/json"*) return 0 ;;
  esac
  return 1
}

proactive_auth_check() {
  local now last_check metadata decision
  now=$(date +%s)
  last_check=$(read_number "$AUTH_CHECK_FILE")
  if [ "$last_check" -gt 0 ] && [ "$now" -ge "$last_check" ] &&
     [ $((now - last_check)) -lt "$AUTH_CHECK_INTERVAL" ]; then
    return 0
  fi
  write_number "$AUTH_CHECK_FILE" "$now"
  metadata=$(run_remote 'node -e '\''
    const fs=require("fs"), crypto=require("crypto");
    const auth=JSON.parse(fs.readFileSync(process.env.HOME+"/.codex/auth.json","utf8"));
    const tokens=auth.tokens||{};
    let payload={};
    try {payload=JSON.parse(Buffer.from(tokens.access_token.split(".")[1],"base64url").toString())} catch {}
    console.log(JSON.stringify({now:Math.floor(Date.now()/1000),expiresAt:payload.exp||null,
      accountHash:tokens.account_id?crypto.createHash("sha256").update(tokens.account_id).digest("hex"):null}));
  '\''')
  if [ "$?" -ne 0 ]; then
    log "auth expiry check unavailable; no credentials changed"
    return 1
  fi
  decision=$(/usr/bin/python3 "$STATE_DIR/auth-refresh-policy.py" "$HOME/.codex/auth.json" "$metadata")
  if [ "$?" -ne 0 ]; then
    log "auth expiry policy unavailable; no credentials changed"
    return 1
  fi
  case "$decision" in
    *'"state":"fresh"'*) log "auth expiry check: $decision"; return 0 ;;
    *'"state":"sync-needed"'*)
      log "remote token expires soon or is expired; repairing from newer same-account local login: $decision"
      if sync_auth; then
        schedule_control_probe "same-account auth refreshed after expiry check"
        return 0
      fi
      log "ACTION_REQUIRED: same-account auth refresh failed"
      return 1
      ;;
    *)
      log "ACTION_REQUIRED: auth expiry repair refused; no credentials changed: $decision"
      return 1
      ;;
  esac
}

primary_route_check() {
  if proxy_check; then return 0; fi
  # Unauthenticated route failures are not enough to diagnose a broken tunnel.
  # Verify the real authenticated route before skipping all functional checks.
  case "$PROXY_KIND" in
    upstream|challenge)
      log "unauthenticated route failed; checking authenticated model route before deciding: $PROXY_RESULT"
      if authenticated_models_check; then
        PROXY_KIND=ok
        PROXY_STATUS=0
        PROXY_RESULT="authenticated fallback: $AUTHENTICATED_RESULT"
        return 0
      fi
      log "authenticated fallback failed status=$AUTHENTICATED_STATUS result=$AUTHENTICATED_RESULT"
      ;;
  esac
  return 1
}

listener_pid() {
  run_remote "ss -ltnp 2>/dev/null | grep \"127.0.0.1:$SOCKS_PORT\" | grep -o 'pid=[0-9]*' | head -n 1 | cut -d= -f2"
}

proxy_pids() {
  run_remote "pgrep -f '[c]odex-linux-x64.*/codex app-server proxy' || true"
}

app_server_pids() {
  run_remote "pgrep -f '[c]odex-linux-x64.*/codex -c features.code_mode_host=true app-server --listen unix://' || true"
}

app_server_protocol_probe() {
  local mode="${1:-status}"
  APP_SERVER_RESULT=$(run_remote '
    probe="$HOME/.codex/remote-tunnel/probe-codex-app-server.js"
    socket="$HOME/.codex/app-server-control/app-server-control.sock"
    if [ ! -r "$probe" ]; then
      printf "app-server probe helper is missing"
      exit 66
    fi
    if [ ! -S "$socket" ]; then
      printf "app-server control socket is missing"
      exit 67
    fi
    timeout '"$APP_SERVER_PROBE_TIMEOUT"' node "$probe" "$socket" '"$mode"' '"$APP_SERVER_REQUEST_TIMEOUT"'
  ')
  APP_SERVER_STATUS=$?
  case "$APP_SERVER_STATUS" in
    0) APP_SERVER_KIND="healthy" ;;
    3) APP_SERVER_KIND="active" ;;
    4) APP_SERVER_KIND="needs-attention" ;;
    66) APP_SERVER_KIND="helper-missing" ;;
    67) APP_SERVER_KIND="socket-missing" ;;
    124) APP_SERVER_KIND="timeout" ;;
    255) APP_SERVER_KIND="ssh" ;;
    *) APP_SERVER_KIND="protocol" ;;
  esac
  return "$APP_SERVER_STATUS"
}

current_tunnel_pid() {
  /bin/launchctl print "gui/$(/usr/bin/id -u)/$LABEL" 2>/dev/null |
    /usr/bin/awk '$1 == "pid" && $2 == "=" { print $3; exit }'
}

terminate_remote_processes() {
  process_name="$1"
  pid_list="$2"
  grace_period="${3:-6}"

  termination_result=$(run_remote "
    old_pids='$pid_list'
    for pid in \$old_pids; do
      kill -TERM \"\$pid\" 2>/dev/null || true
    done
    sleep '$grace_period'

    remaining=''
    for pid in \$old_pids; do
      if kill -0 \"\$pid\" 2>/dev/null; then
        remaining=\"\$remaining \$pid\"
      fi
    done

    if [ -n \"\$remaining\" ]; then
      for pid in \$remaining; do
        kill -KILL \"\$pid\" 2>/dev/null || true
      done
      sleep 3
    fi

    remaining=''
    states=''
    for pid in \$old_pids; do
      if kill -0 \"\$pid\" 2>/dev/null; then
        state=\$(ps -o stat= -p \"\$pid\" 2>/dev/null | tr -d ' ')
        remaining=\"\$remaining \$pid\"
        states=\"\$states \$pid:\${state:-unknown}\"
      fi
    done
    printf '%s|%s' \"\$remaining\" \"\$states\"
    [ -z \"\$remaining\" ]
  ")
  termination_status=$?
  if [ "$termination_status" -ne 0 ]; then
    log "$process_name termination did not remove every old pid; result=$termination_result"
    return 1
  fi

  log "$process_name old pids stopped cleanly: $pid_list"
  return 0
}

restart_app_server() {
  pids=$(app_server_pids)
  pids_status=$?
  if [ "$pids_status" -ne 0 ]; then
    log "app-server lookup failed status=$pids_status result=$pids"
    return 1
  fi
  if [ -z "$pids" ]; then
    local attempt replacement replacement_status
    log "app-server is missing; giving Codex App up to 15s to recreate it"
    for attempt in 1 2 3 4 5; do
      sleep 3
      replacement=$(app_server_pids)
      replacement_status=$?
      if [ "$replacement_status" -ne 0 ]; then
        log "app-server recreation lookup failed; not starting a competing instance"
        return 1
      fi
      if [ -n "$replacement" ]; then
        log "Codex App recreated app-server; preserving pids=$(printf '%s' "$replacement" | tr '\n' ' ')"
        return 0
      fi
    done
    log "no Codex code-mode app-server process found; clearing stale control socket and starting one"
    start_result=$(run_remote 'mkdir -p "$HOME/.codex/app-server-control"; rm -f "$HOME/.codex/app-server-control/app-server-control.sock"; nohup "$HOME/.local/bin/codex" -c features.code_mode_host=true app-server --listen unix:// >"$HOME/.codex/app-server-control/app-server.log" 2>&1 &')
    start_status=$?
    if [ "$start_status" -ne 0 ]; then
      log "app-server start failed status=$start_status result=$start_result"
      return 1
    fi
    sleep 6
    new_pids=$(app_server_pids)
    new_pids_status=$?
    if [ "$new_pids_status" -ne 0 ]; then
      log "app-server start sent; verification lookup failed status=$new_pids_status result=$new_pids"
      return 1
    fi
    if [ -z "$new_pids" ]; then
      start_log=$(run_remote 'tail -n 16 "$HOME/.codex/app-server-control/app-server.log" 2>&1 | tr "\n" " "')
      log "app-server start exited before verification; log=$start_log"
      return 1
    fi
    log "app-server start completed; current pids=$(printf '%s' "$new_pids" | tr '\n' ' ')"
    return 0
  fi

  log "restarting Codex app-server pids=$(printf '%s' "$pids" | tr '\n' ' ')"
  pid_list=$(printf '%s' "$pids" | tr '\n' ' ')
  if ! terminate_remote_processes "app-server" "$pid_list" 6; then
    log "app-server restart aborted because an old process is still alive"
    return 1
  fi

  sleep 1
  new_pids=$(app_server_pids)
  new_pids_status=$?
  if [ "$new_pids_status" -ne 0 ]; then
    log "app-server restart sent; verification lookup failed status=$new_pids_status result=$new_pids"
    return 1
  fi
  if [ -z "$new_pids" ]; then
    log "all stale app-server processes stopped; starting one clean instance"
    restart_app_server
    return $?
  fi
  log "app-server replacement detected; current pids=$(printf '%s' "$new_pids" | tr '\n' ' ')"
}

restart_app_server_proxy() {
  APP_PROXY_STATE="unknown"
  pids=$(proxy_pids)
  pids_status=$?
  if [ "$pids_status" -ne 0 ]; then
    APP_PROXY_STATE="error"
    log "proxy lookup failed status=$pids_status result=$pids"
    return 1
  fi
  if [ -z "$pids" ]; then
    APP_PROXY_STATE="pending"
    log "no Codex app-server proxy process is running; Codex App will recreate it on demand"
    return 0
  fi

  log "restarting Codex app-server proxy pids=$(printf '%s' "$pids" | tr '\n' ' ')"
  pid_list=$(printf '%s' "$pids" | tr '\n' ' ')
  if ! terminate_remote_processes "proxy" "$pid_list" 3; then
    APP_PROXY_STATE="stuck"
    log "proxy restart aborted because an old process is still alive"
    return 1
  fi

  waited=0
  while [ "$waited" -lt "$APP_PROXY_WAIT" ]; do
    sleep 3
    waited=$((waited + 3))
    new_pids=$(proxy_pids)
    new_pids_status=$?
    if [ "$new_pids_status" -ne 0 ]; then
      APP_PROXY_STATE="error"
      log "proxy restart sent; verification lookup failed status=$new_pids_status result=$new_pids"
      return 1
    fi
    if [ -n "$new_pids" ]; then
      APP_PROXY_STATE="ready"
      log "proxy restart completed; current pids=$(printf '%s' "$new_pids" | tr '\n' ' ')"
      return 0
    fi
  done

  APP_PROXY_STATE="pending"
  log "proxy stopped; Codex App has not recreated it after ${APP_PROXY_WAIT}s and will retry on demand"
  return 0
}

refresh_app_transport() {
  reason="$1"
  log "refreshing Codex App transport after tunnel recovery: $reason"
  if ! restart_app_server_proxy; then
    log "Codex App transport refresh failed: $reason"
    return 1
  fi
  if [ "$APP_PROXY_STATE" = "pending" ]; then
    log "Codex App transport is pending on-demand recreation: $reason"
  else
    log "Codex App transport refresh completed: $reason"
  fi
}

record_current_tunnel_pid() {
  current_pid=$(current_tunnel_pid)
  current_pid_status=$?
  if [ "$current_pid_status" -ne 0 ] || [ -z "$current_pid" ]; then
    log "could not record current tunnel pid"
    return 1
  fi
  write_number "$TUNNEL_PID_FILE" "$current_pid"
}

schedule_control_probe() {
  reason="$1"
  now=$(date +%s)
  write_number "$CONTROL_PENDING_FILE" "$now"
  write_number "$CONTROL_PROBE_FAIL_FILE" 0
  rm -f "$CONTROL_VERIFIED_FILE"
  log "scheduled app-server functional probe: $reason"
}

clear_control_probe_state() {
  rm -f "$CONTROL_PENDING_FILE" "$CONTROL_PROBE_FAIL_FILE"
}

restart_idle_control_plane() {
  local reason="$1"
  rm -f "$CONTROL_RECYCLE_FILE"
  log "app-server is idle after tunnel replacement; verifying before any restart: $reason"
  schedule_control_probe "$reason"
  process_control_plane_probe "$reason" force
}

reconcile_multiple_app_servers() {
  app_server_count="$1"
  reason="$2"

  app_server_protocol_probe activity
  activity_status=$?
  if [ "$activity_status" -ne 0 ]; then
    log "detected $app_server_count app-server instances but could not confirm activity; preserving them kind=$APP_SERVER_KIND status=$APP_SERVER_STATUS result=$(printf '%s' "$APP_SERVER_RESULT" | tr '\n' ' ' | cut -c1-1000)"
    return 1
  fi

  case "$APP_SERVER_RESULT" in
    *'"state":"active"'*)
      write_number "$CONTROL_RECYCLE_FILE" "$(date +%s)"
      log "detected $app_server_count app-server instances with active tasks; preserving them and scheduling an idle recycle: $(printf '%s' "$APP_SERVER_RESULT" | tr '\n' ' ' | cut -c1-1000)"
      return 0
      ;;
    *'"state":"idle"'*)
      log "detected $app_server_count idle app-server instances; verifying functionality without a blanket restart: $reason"
      if [ ! -f "$CONTROL_PENDING_FILE" ]; then
        schedule_control_probe "$reason"
      fi
      return 0
      ;;
  esac

  log "detected $app_server_count app-server instances with an unknown activity state; preserving them: $(printf '%s' "$APP_SERVER_RESULT" | tr '\n' ' ' | cut -c1-1000)"
  return 1
}

process_deferred_tunnel_recycle() {
  if [ ! -f "$CONTROL_RECYCLE_FILE" ]; then
    return 0
  fi

  app_server_protocol_probe activity
  activity_status=$?
  if [ "$activity_status" -ne 0 ]; then
    log "deferred app-server recycle could not confirm activity; preserving processes kind=$APP_SERVER_KIND status=$APP_SERVER_STATUS result=$(printf '%s' "$APP_SERVER_RESULT" | tr '\n' ' ' | cut -c1-1000)"
    return 1
  fi

  case "$APP_SERVER_RESULT" in
    *'"state":"active"'*)
      log "deferred app-server recycle still waiting for active tasks: $(printf '%s' "$APP_SERVER_RESULT" | tr '\n' ' ' | cut -c1-1000)"
      return 0
      ;;
    *'"state":"idle"'*)
      restart_idle_control_plane "deferred recycle after tunnel replacement"
      return $?
      ;;
  esac

  log "deferred app-server recycle received an unknown activity result; preserving processes: $(printf '%s' "$APP_SERVER_RESULT" | tr '\n' ' ' | cut -c1-1000)"
  return 1
}

restart_control_plane() {
  reason="$1"
  log "force restarting Codex control plane: $reason"
  if ! restart_app_server; then
    log "control-plane recovery failed while restarting app-server"
    return 1
  fi
  sleep 2
  if ! restart_app_server_proxy; then
    log "control-plane recovery failed while restarting app-server proxy"
    return 1
  fi
  # The requested recycle is complete once both control processes are fresh.
  # Do not repeat a disruptive restart if the authenticated route probe is
  # temporarily slow immediately after startup.
  rm -f "$CONTROL_RECYCLE_FILE"
  record_current_tunnel_pid || true
  write_number "$CONTROL_REPAIR_FILE" "$(date +%s)"
  write_number "$CONTROL_RESTART_FILE" "$(date +%s)"
  schedule_control_probe "verify forced control-plane restart"
  if ! repair_authenticated_models; then
    write_number "$CONTROL_DEGRADED_FILE" "$(date +%s)"
    log "control-plane recovery degraded: authenticated models check failed status=$AUTHENTICATED_STATUS result=$AUTHENTICATED_RESULT"
    return 1
  fi
  rm -f "$CONTROL_DEGRADED_FILE"
  log "authenticated models route healthy: $AUTHENTICATED_RESULT"
  if [ "$APP_PROXY_STATE" = "pending" ]; then
    log "control-plane app-server recovery completed; App proxy is pending on-demand recreation: $reason"
  else
    log "Codex control-plane recovery completed: $reason"
  fi
}

restart_control_plane_if_idle() {
  if ! app_server_protocol_probe activity; then
    log "manual idle-only restart refused: activity could not be confirmed"
    return 1
  fi
  case "$APP_SERVER_RESULT" in
    *'"state":"idle"'*) restart_control_plane "manual request with confirmed idle state" ;;
    *'"state":"active"'*) log "manual idle-only restart deferred: active tasks present"; return 3 ;;
    *) log "manual idle-only restart refused: unknown activity state"; return 1 ;;
  esac
}

recover_control_plane() {
  reason="$1"
  log "recovering Codex control plane after tunnel replacement: $reason"

  # Record the new tunnel immediately. A later probe failure must not make the
  # next health check treat the same tunnel process as another restart.
  record_current_tunnel_pid || true
  write_number "$CONTROL_REPAIR_FILE" "$(date +%s)"

  pids=$(app_server_pids)
  pids_status=$?
  if [ "$pids_status" -ne 0 ]; then
    log "app-server lookup failed during non-disruptive recovery status=$pids_status result=$pids"
    return 1
  fi

  app_server_count=$(printf '%s\n' "$pids" | /usr/bin/awk 'NF { count++ } END { print count + 0 }')
  if [ "$app_server_count" -eq 0 ]; then
    proxy_processes=$(proxy_pids)
    proxy_status=$?
    if [ "$proxy_status" -eq 0 ] && [ -n "$proxy_processes" ]; then
      log "app-server is missing while its proxy is present; starting one app-server"
      if ! restart_app_server; then
        log "non-disruptive recovery failed while starting missing app-server"
        return 1
      fi
    else
      log "no app-server or proxy is active; Codex App will create them on demand"
    fi
  elif [ "$app_server_count" -gt 1 ]; then
    reconcile_multiple_app_servers \
      "$app_server_count" \
      "multiple app-server instances after $reason"
    reconcile_status=$?
    if [ "$reconcile_status" -eq 2 ]; then
      return 0
    fi
  else
    app_server_protocol_probe activity
    activity_status=$?
    if [ "$activity_status" -eq 0 ]; then
      case "$APP_SERVER_RESULT" in
        *'"state":"active"'*)
          write_number "$CONTROL_RECYCLE_FILE" "$(date +%s)"
          log "preserving active app-server pid=$(printf '%s' "$pids" | tr '\n' ' '); scheduled recycle when idle: $(printf '%s' "$APP_SERVER_RESULT" | tr '\n' ' ' | cut -c1-1000)"
          ;;
        *'"state":"idle"'*)
          restart_idle_control_plane "idle after $reason"
          return $?
          ;;
        *)
          log "app-server activity result was unknown; preserving pid=$(printf '%s' "$pids" | tr '\n' ' ') result=$(printf '%s' "$APP_SERVER_RESULT" | tr '\n' ' ' | cut -c1-1000)"
          ;;
      esac
    else
      log "app-server activity lookup failed; preserving pid=$(printf '%s' "$pids" | tr '\n' ' ') kind=$APP_SERVER_KIND status=$APP_SERVER_STATUS result=$(printf '%s' "$APP_SERVER_RESULT" | tr '\n' ' ' | cut -c1-1000)"
    fi
  fi

  schedule_control_probe "$reason"

  if ! repair_authenticated_models; then
    write_number "$CONTROL_DEGRADED_FILE" "$(date +%s)"
    log "control-plane recovery degraded: authenticated models check failed status=$AUTHENTICATED_STATUS result=$AUTHENTICATED_RESULT"
    return 1
  fi

  rm -f "$CONTROL_DEGRADED_FILE"
  log "Codex control-plane route is healthy without an app-server restart: $AUTHENTICATED_RESULT"
  # The app-server can survive a tunnel replacement, but its App-facing proxy
  # may retain the dead SSH transport. Refresh only that proxy so active turns
  # keep running while the desktop App establishes a fresh connection.
  refresh_app_transport "$reason" || true
  process_control_plane_probe "after $reason" force || true
}

process_control_plane_probe() {
  local reason="$1" force="${2:-no}" now pending_since probe_status fail_count last_restart
  if [ ! -f "$CONTROL_PENDING_FILE" ]; then
    return 0
  fi

  now=$(date +%s)
  pending_since=$(read_number "$CONTROL_PENDING_FILE")
  if [ "$force" != "force" ] && [ "$pending_since" -gt 0 ] &&
     [ $((now - pending_since)) -lt "$CONTROL_PENDING_DELAY" ]; then
    return 0
  fi

  write_number "$CONTROL_PROBE_CHECK_FILE" "$now"
  app_server_protocol_probe turn
  probe_status=$?
  case "$probe_status" in
    0)
      clear_control_probe_state
      write_number "$CONTROL_VERIFIED_FILE" "$(date +%s)"
      log "app-server functional probe healthy: $(printf '%s' "$APP_SERVER_RESULT" | tr '\n' ' ' | cut -c1-1000)"
      return 0
      ;;
    3)
      # Busy is not a successful model request. Retain pending verification.
      TASK_PROGRESS_STATE=active
      write_number "$CONTROL_PROBE_FAIL_FILE" 0
      log "app-server functional probe deferred for active tasks; verification remains pending: $(printf '%s' "$APP_SERVER_RESULT" | tr '\n' ' ' | cut -c1-1000)"
      return 0
      ;;
    66|124|255)
      write_number "$CONTROL_PENDING_FILE" "$now"
      log "app-server functional probe unavailable kind=$APP_SERVER_KIND status=$APP_SERVER_STATUS result=$(printf '%s' "$APP_SERVER_RESULT" | tr '\n' ' ' | cut -c1-1000)"
      return 1
      ;;
  esac

  case "$APP_SERVER_RESULT" in
    *'"safeToRestart":true'*)
      ;;
    *)
      write_number "$CONTROL_PENDING_FILE" "$now"
      log "app-server probe failed without a confirmed idle state; preserving processes kind=$APP_SERVER_KIND status=$APP_SERVER_STATUS result=$(printf '%s' "$APP_SERVER_RESULT" | tr '\n' ' ' | cut -c1-1000)"
      return 1
      ;;
  esac

  fail_count=$(read_number "$CONTROL_PROBE_FAIL_FILE")
  fail_count=$((fail_count + 1))
  write_number "$CONTROL_PROBE_FAIL_FILE" "$fail_count"
  write_number "$CONTROL_PENDING_FILE" "$now"
  if [ "$fail_count" -lt "$CONTROL_PROBE_FAIL_THRESHOLD" ]; then
    log "app-server functional probe failed while idle count=$fail_count threshold=$CONTROL_PROBE_FAIL_THRESHOLD kind=$APP_SERVER_KIND result=$(printf '%s' "$APP_SERVER_RESULT" | tr '\n' ' ' | cut -c1-1000)"
    return 1
  fi

  last_restart=$(read_number "$CONTROL_RESTART_FILE")
  if [ "$last_restart" -gt 0 ] &&
     [ $((now - last_restart)) -lt "$CONTROL_RESTART_COOLDOWN" ]; then
    log "app-server functional failure confirmed but forced restart is within ${CONTROL_RESTART_COOLDOWN}s cooldown"
    return 1
  fi

  # A user may have started work while the functional probe was failing.
  if ! app_server_protocol_probe activity; then
    log "automatic restart refused: latest activity could not be confirmed"
    return 1
  fi
  case "$APP_SERVER_RESULT" in
    *'"state":"idle"'*) ;;
    *) log "automatic restart deferred: a task became active or unknown"; return 1 ;;
  esac
  write_number "$CONTROL_RESTART_FILE" "$now"
  log "app-server functional failure confirmed twice while idle; starting staged control-plane restart: $reason"
  if restart_control_plane "functional probe failed twice while idle: $reason"; then
    log "staged control-plane restart completed"
    return 0
  fi
  log "staged control-plane restart did not fully recover; verification remains pending"
  return 1
}

control_plane_health_cycle() {
  process_task_progress
  # Never use an idle result from a second probe to override failed observation.
  if [ "$TASK_PROGRESS_STATE" = unknown ] || [ "$TASK_PROGRESS_STATE" = needs-attention ]; then
    return 0
  fi
  if [ "$TASK_PROGRESS_STATE" = active ]; then
    if [ ! -f "$CONTROL_PENDING_FILE" ]; then
      schedule_control_probe "active tasks require later functional verification"
    fi
    return 0
  fi
  process_deferred_tunnel_recycle || true
  if [ -f "$CONTROL_RECYCLE_FILE" ]; then
    return 0
  fi

  if [ -f "$CONTROL_PENDING_FILE" ]; then
    process_control_plane_probe "pending verification" || true
    return 0
  fi

  now=$(date +%s)
  last_probe=$(read_number "$CONTROL_PROBE_CHECK_FILE")
  if [ "$last_probe" -gt 0 ] &&
     [ $((now - last_probe)) -lt "$CONTROL_PROBE_INTERVAL" ]; then
    return 0
  fi

  schedule_control_probe "periodic ${CONTROL_PROBE_INTERVAL}s functional check"
  process_control_plane_probe "periodic functional check" force || true
}

retry_degraded_control_check() {
  if [ ! -f "$CONTROL_DEGRADED_FILE" ]; then
    return 0
  fi

  now=$(date +%s)
  last_attempt=$(read_number "$CONTROL_DEGRADED_FILE")
  if [ "$last_attempt" -gt 0 ] &&
     [ $((now - last_attempt)) -lt "$CONTROL_REPAIR_COOLDOWN" ]; then
    return 0
  fi

  if repair_authenticated_models; then
    rm -f "$CONTROL_DEGRADED_FILE"
    log "degraded control-plane route is now authenticated and healthy: $AUTHENTICATED_RESULT"
    return 0
  fi
  write_number "$CONTROL_DEGRADED_FILE" "$now"
  log "degraded control-plane route is still unhealthy status=$AUTHENTICATED_STATUS result=$AUTHENTICATED_RESULT"
  return 1
}

handle_tunnel_pid_change() {
  current_pid=$(current_tunnel_pid)
  current_pid_status=$?
  if [ "$current_pid_status" -ne 0 ] || [ -z "$current_pid" ]; then
    log "tunnel pid lookup failed; leaving control plane untouched"
    return 1
  fi

  previous_pid=$(read_number "$TUNNEL_PID_FILE")
  if [ "$previous_pid" -eq 0 ]; then
    write_number "$TUNNEL_PID_FILE" "$current_pid"
    log "recorded initial tunnel pid=$current_pid"
    return 0
  fi
  if [ "$previous_pid" -eq "$current_pid" ]; then
    return 0
  fi

  # Consume the PID change before any network work. Otherwise a transient
  # recovery failure repeats this branch and can cause a reconnect loop.
  write_number "$TUNNEL_PID_FILE" "$current_pid"

  log "tunnel pid changed $previous_pid->$current_pid; preserving app-server and proxy pending functional verification"
  schedule_control_probe "tunnel pid changed $previous_pid->$current_pid"
}

ensure_single_app_server() {
  pids=$(app_server_pids)
  pids_status=$?
  if [ "$pids_status" -ne 0 ]; then
    log "app-server singleton lookup failed status=$pids_status result=$pids"
    return 1
  fi

  app_server_count=$(printf '%s\n' "$pids" | /usr/bin/awk 'NF { count++ } END { print count + 0 }')
  if [ "$app_server_count" -gt 1 ]; then
    reconcile_multiple_app_servers \
      "$app_server_count" \
      "multiple app-server instances detected by singleton check"
    reconcile_status=$?
    if [ "$reconcile_status" -eq 1 ]; then
      return 1
    fi
    return 0
  fi
  if [ "$app_server_count" -eq 0 ]; then
    proxy_processes=$(proxy_pids)
    proxy_status=$?
    if [ "$proxy_status" -eq 0 ] && [ -n "$proxy_processes" ]; then
      recover_control_plane "app-server missing while proxy is present"
      return $?
    fi
  fi
}

kickstart_tunnel() {
  log "kickstarting $LABEL"
  /bin/launchctl kickstart -k "gui/$(/usr/bin/id -u)/$LABEL" >> "$LOG" 2>&1
}

rebuild_tunnel_now() {
  pid=$(listener_pid)
  pid_status=$?
  if [ "$pid_status" -ne 0 ]; then
    log "manual tunnel rebuild could not inspect listener status=$pid_status result=$pid"
    return 1
  fi
  if [ -n "$pid" ]; then
    log "manual tunnel rebuild terminating remote sshd pid=$pid"
    cleanup_result=$(run_remote "kill -TERM $pid")
    cleanup_status=$?
    if [ "$cleanup_status" -ne 0 ]; then
      log "manual tunnel rebuild failed to terminate pid=$pid status=$cleanup_status result=$cleanup_result"
      return 1
    fi
  else
    log "manual tunnel rebuild found no remote listener"
  fi
  kickstart_tunnel
  sleep 5
  if proxy_check; then
    write_number "$FAIL_FILE" 0
    log "manual tunnel rebuild succeeded: $PROXY_RESULT"
    return 0
  fi
  log "manual tunnel rebuild verification failed status=$PROXY_STATUS result=$PROXY_RESULT"
  return 1
}

sync_auth() {
  local local_auth="$HOME/.codex/auth.json"
  local remote_home
  remote_home=$(run_remote 'printf "%s" "$HOME"') || return 1
  if [[ ! "$remote_home" =~ ^/[a-zA-Z0-9_./-]+$ ]]; then
    log "auth sync failed: remote home could not be safely resolved"
    return 1
  fi
  local remote_auth="$remote_home/.codex/auth.json"
  local remote_incoming="${remote_auth}.incoming"
  local prepare_result prepare_status
  local upload_result upload_status
  local local_hash remote_hash
  local activate_result activate_status

  if [ ! -r "$local_auth" ]; then
    log "auth sync failed: local auth file is not readable"
    return 1
  fi

  prepare_result=$(run_remote "set -eu; umask 077; mkdir -p \"$remote_home/.codex\"; if [ -f \"$remote_auth\" ]; then cp \"$remote_auth\" \"${remote_auth}.backup-\$(date +%Y%m%d-%H%M%S)\"; fi; rm -f \"$remote_incoming\"")
  prepare_status=$?
  if [ "$prepare_status" -ne 0 ]; then
    log "auth sync prepare failed status=$prepare_status result=$prepare_result"
    return 1
  fi

  upload_result=$(/usr/bin/python3 "$STATE_DIR/supervise.py" timeout "$REMOTE_COMMAND_TIMEOUT" \
    /usr/bin/scp \
    -o BatchMode=yes \
    -o ConnectTimeout=10 \
    -o LogLevel=ERROR \
    "$local_auth" \
    "$REMOTE_TARGET:$remote_incoming" 2>&1)
  upload_status=$?
  if [ "$upload_status" -ne 0 ]; then
    log "auth sync upload failed status=$upload_status result=$upload_result"
    run_remote "rm -f \"$remote_incoming\"" >/dev/null
    return 1
  fi

  local_hash=$(/usr/bin/shasum -a 256 "$local_auth" | /usr/bin/awk '{ print $1 }')
  remote_hash=$(run_remote "sha256sum \"$remote_incoming\" | cut -d' ' -f1")
  if [ -z "$remote_hash" ] || [ "$local_hash" != "$remote_hash" ]; then
    log "auth sync verification failed"
    run_remote "rm -f \"$remote_incoming\"" >/dev/null
    return 1
  fi

  activate_result=$(run_remote "set -eu; chmod 600 \"$remote_incoming\"; mv \"$remote_incoming\" \"$remote_auth\"")
  activate_status=$?
  if [ "$activate_status" -ne 0 ]; then
    log "auth sync activation failed status=$activate_status result=$activate_result"
    return 1
  fi

  log "auth sync completed"
}

repair_authenticated_models() {
  if authenticated_models_check; then
    return 0
  fi

  case "$AUTHENTICATED_RESULT" in
    *"http=401"*)
      log "authenticated models returned 401; syncing local auth to the remote host"
      if ! sync_auth; then
        log "automatic auth sync failed after models 401"
        return 1
      fi
      if authenticated_models_check; then
        log "authenticated models recovered after auth sync: $AUTHENTICATED_RESULT"
        return 0
      fi
      log "authenticated models still unhealthy after auth sync status=$AUTHENTICATED_STATUS result=$AUTHENTICATED_RESULT"
      ;;
  esac
  return 1
}

cli_probe() {
  CLI_PROBE_STATE="unhealthy"
  CLI_RESULT=$(run_remote 'cd "${CODEX_PROBE_CWD:-$HOME}" && timeout 30 "$HOME/.local/bin/codex" exec --ephemeral --skip-git-repo-check "Reply exactly READY."')
  CLI_STATUS=$?
  CLI_NETWORK_ERRORS=$(printf '%s\n' "$CLI_RESULT" | grep -E 'failed to refresh available models|http/request failed|stream disconnected before completion|cf-mitigated|Cloudflare' | head -n 4 | tr '\n' ' ')
  CLI_READY=$(printf '%s\n' "$CLI_RESULT" | tr -d '\r' | grep -c '^READY$')

  if [ "$CLI_STATUS" -ne 0 ]; then
    return 1
  fi
  if [ "$CLI_READY" -eq 0 ]; then
    CLI_STATUS=1
    return 1
  fi
  if [ -n "$CLI_NETWORK_ERRORS" ]; then
    CLI_PROBE_STATE="degraded"
    return 2
  fi
  CLI_PROBE_STATE="healthy"
  return 0
}

if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  return 0
fi

mkdir -p "$STATE_DIR"

if [ "${1:-}" = "--status" ]; then
  /usr/bin/python3 - "$HEALTH_FILE" <<'PY'
import json, sys, time
try:
    with open(sys.argv[1]) as stream:
        value = json.load(stream)
    age = int(time.time()) - value["checkedAt"]
    value["ageSeconds"] = age
    if age < 0 or age > 360:
        value["lastStatus"] = value["status"]
        value["status"] = "stale"
except (OSError, ValueError, KeyError):
    value = {"status": "unknown", "error": "health report unavailable"}
print(json.dumps(value, ensure_ascii=False, indent=2))
PY
  exit $?
fi

cleanup_lock() {
  lock_owner=$(read_number "$LOCK_DIR/pid")
  if [ "$lock_owner" -eq "$$" ]; then
    rm -f "$LOCK_DIR/pid"
    rmdir "$LOCK_DIR" 2>/dev/null || true
  fi
}

acquire_lock() {
  if mkdir "$LOCK_DIR" 2>/dev/null; then
    write_number "$LOCK_DIR/pid" "$$"
    return 0
  fi

  lock_pid=$(read_number "$LOCK_DIR/pid")
  lock_command=""
  if [ "$lock_pid" -gt 0 ]; then
    lock_command=$(/bin/ps -p "$lock_pid" -o command= 2>/dev/null || true)
  fi
  case "$lock_command" in
    *check-tunnel.sh*)
      log "previous health check pid=$lock_pid is still running; skipping"
      return 1
      ;;
  esac

  log "removing stale health-check lock pid=$lock_pid"
  rm -f "$LOCK_DIR/pid"
  if ! rmdir "$LOCK_DIR" 2>/dev/null || ! mkdir "$LOCK_DIR" 2>/dev/null; then
    log "could not replace stale health-check lock; skipping"
    return 1
  fi
  write_number "$LOCK_DIR/pid" "$$"
}

if ! acquire_lock; then
  case "${1:-}" in
    --*)
      log "manual command ${1:-unknown} could not acquire the health-check lock"
      exit 75
      ;;
  esac
  exit 0
fi
finish_check() {
  if [ "$HEALTH_REPORT_ENABLED" = yes ]; then publish_health; fi
  cleanup_lock
}
trap finish_check EXIT
trap 'exit 130' INT
trap 'exit 143' HUP TERM

if [ "${1:-}" = "--restart-proxy" ]; then
  restart_app_server_proxy
  exit $?
fi
if [ "${1:-}" = "--restart-app-server" ]; then
  restart_app_server
  exit $?
fi
if [ "${1:-}" = "--sync-auth" ]; then
  sync_auth
  exit $?
fi
if [ "${1:-}" = "--probe-auth" ]; then
  if auth_route_check; then
    log "auth route healthy: $AUTH_RESULT"
    exit 0
  fi
  log "auth route unhealthy status=$AUTH_STATUS result=$AUTH_RESULT"
  exit 1
fi
if [ "${1:-}" = "--probe-models" ]; then
  if authenticated_models_check; then
    log "authenticated models probe healthy: $AUTHENTICATED_RESULT"
    exit 0
  fi
  log "authenticated models probe unhealthy status=$AUTHENTICATED_STATUS result=$AUTHENTICATED_RESULT"
  exit 1
fi
if [ "${1:-}" = "--probe-cli" ]; then
  cli_probe
  cli_probe_status=$?
  case "$cli_probe_status" in
    0)
      log "Codex CLI probe healthy: READY"
      exit 0
      ;;
    2)
      log "Codex CLI probe degraded: core request returned READY; ancillary errors=$(printf '%s' "$CLI_NETWORK_ERRORS" | cut -c1-1000)"
      exit 2
      ;;
    *)
      log "Codex CLI probe unhealthy status=$CLI_STATUS errors=$(printf '%s' "$CLI_NETWORK_ERRORS" | cut -c1-1000) result=$(printf '%s' "$CLI_RESULT" | tr '\n' ' ' | cut -c1-1500)"
      exit 1
      ;;
  esac
fi
if [ "${1:-}" = "--probe-app-server" ]; then
  app_server_protocol_probe turn
  app_probe_status=$?
  case "$app_probe_status" in
    0)
      log "manual app-server functional probe healthy: $(printf '%s' "$APP_SERVER_RESULT" | tr '\n' ' ' | cut -c1-1000)"
      exit 0
      ;;
    3)
      log "manual app-server functional probe deferred for active tasks: $(printf '%s' "$APP_SERVER_RESULT" | tr '\n' ' ' | cut -c1-1000)"
      exit 3
      ;;
    *)
      log "manual app-server functional probe unhealthy kind=$APP_SERVER_KIND status=$APP_SERVER_STATUS result=$(printf '%s' "$APP_SERVER_RESULT" | tr '\n' ' ' | cut -c1-1000)"
      exit 1
      ;;
  esac
fi
if [ "${1:-}" = "--recover-control" ]; then
  recover_control_plane "manual request"
  exit $?
fi
if [ "${1:-}" = "--restart-control" ]; then
  restart_control_plane "manual forced restart"
  exit $?
fi
if [ "${1:-}" = "--restart-idle-control" ]; then
  restart_control_plane_if_idle
  exit $?
fi
if [ "${1:-}" = "--recover-remote" ]; then
  rebuild_tunnel_now && recover_control_plane "manual tunnel rebuild"
  exit $?
fi

HEALTH_REPORT_ENABLED=yes
proactive_auth_check || true
if primary_route_check; then
  write_number "$FAIL_FILE" 0
  handle_tunnel_pid_change || true
  ensure_single_app_server || true
  retry_degraded_control_check || true
  control_plane_health_cycle
  exit 0
fi

case "$PROXY_KIND" in
  ssh)
    write_number "$FAIL_FILE" 0
    log "unhealthy kind=ssh status=$PROXY_STATUS result=$PROXY_RESULT"
    log "control SSH is unreachable; leaving $LABEL untouched"
    exit 0
    ;;
  challenge|upstream)
    write_number "$FAIL_FILE" 0
    log "unhealthy kind=$PROXY_KIND status=$PROXY_STATUS result=$PROXY_RESULT"
    log "SOCKS transport reached the upstream service but the response was unhealthy; leaving the remote listener untouched"
    exit 0
    ;;
  transport)
    ;;
  *)
    write_number "$FAIL_FILE" 0
    log "unhealthy kind=$PROXY_KIND status=$PROXY_STATUS result=$PROXY_RESULT"
    log "unknown proxy failure kind=$PROXY_KIND; leaving $LABEL untouched"
    exit 0
    ;;
esac

fail_count=$(read_number "$FAIL_FILE")
fail_count=$((fail_count + 1))
write_number "$FAIL_FILE" "$fail_count"
log "unhealthy count=$fail_count kind=transport status=$PROXY_STATUS result=$PROXY_RESULT"

tunnel_pid=$(current_tunnel_pid)
if [ -n "$tunnel_pid" ] && [ "$fail_count" -lt "$FAIL_THRESHOLD" ]; then
  log "below repair threshold=$FAIL_THRESHOLD with active tunnel pid=$tunnel_pid; leaving remote listener untouched"
  exit 0
fi
if [ -z "$tunnel_pid" ]; then
  log "local tunnel has no active pid; bypassing failure threshold and confirming the remote listener now"
fi

pid_before=$(listener_pid)
pid_status=$?
if [ "$pid_status" -ne 0 ]; then
  log "listener check failed status=$pid_status result=$pid_before; leaving $LABEL untouched"
  exit 0
fi
if [ -z "$pid_before" ]; then
  log "remote $SOCKS_PORT has no listener; rebuilding tunnel"
  kickstart_tunnel
  sleep 5
  if proxy_check; then
    recover_control_plane "listener disappeared and tunnel was rebuilt" || true
  fi
  exit 0
fi

now=$(date +%s)
last_repair=$(read_number "$REPAIR_FILE")
last_repair_pid=$(read_number "$REPAIR_PID_FILE")
if [ "$last_repair" -gt 0 ] && [ "$last_repair_pid" -eq "$pid_before" ] &&
   [ $((now - last_repair)) -lt "$REPAIR_COOLDOWN" ]; then
  log "same stuck listener pid=$pid_before is within ${REPAIR_COOLDOWN}s cooldown; leaving it untouched"
  exit 0
fi
if [ "$last_repair" -gt 0 ] && [ $((now - last_repair)) -lt "$REPAIR_COOLDOWN" ] &&
   [ "$last_repair_pid" -ne "$pid_before" ]; then
  log "new stuck listener pid=$pid_before differs from cooled-down pid=$last_repair_pid; repairing immediately"
fi

log "confirming stuck listener pid=$pid_before after ${RECHECK_DELAY}s"
sleep "$RECHECK_DELAY"
if proxy_check; then
  write_number "$FAIL_FILE" 0
  log "recheck healthy: $PROXY_RESULT"
  exit 0
fi
case "$PROXY_KIND" in
  ssh)
    log "recheck control SSH failed; leaving listener pid=$pid_before untouched"
    exit 0
    ;;
  challenge|upstream)
    write_number "$FAIL_FILE" 0
    log "recheck reached an unhealthy upstream response; leaving listener pid=$pid_before untouched"
    exit 0
    ;;
  transport)
    ;;
  *)
    log "recheck returned unknown failure kind=$PROXY_KIND; leaving listener pid=$pid_before untouched"
    exit 0
    ;;
esac

pid_after=$(listener_pid)
pid_status=$?
if [ "$pid_status" -ne 0 ] || [ -z "$pid_after" ]; then
  log "listener disappeared during recheck; rebuilding tunnel"
  kickstart_tunnel
  sleep 5
  if proxy_check; then
    recover_control_plane "listener disappeared during recheck" || true
  fi
  exit 0
fi
if [ "$pid_before" != "$pid_after" ]; then
  log "listener changed from pid=$pid_before to pid=$pid_after; leaving it untouched"
  exit 0
fi

log "confirmed stuck remote sshd pid=$pid_before; terminating reverse forward"
cleanup_result=$(run_remote "kill -TERM $pid_before")
cleanup_status=$?
if [ "$cleanup_status" -ne 0 ]; then
  log "failed to terminate pid=$pid_before status=$cleanup_status result=$cleanup_result"
  exit 0
fi

write_number "$REPAIR_FILE" "$now"
write_number "$REPAIR_PID_FILE" "$pid_before"
kickstart_tunnel
sleep 5
if proxy_check; then
  write_number "$FAIL_FILE" 0
  log "automatic repair succeeded: $PROXY_RESULT"
  recover_control_plane "automatic tunnel repair" || true
else
  log "automatic repair started, verification still unhealthy status=$PROXY_STATUS result=$PROXY_RESULT"
fi
