#!/bin/bash
set -u

REMOTE_TARGET="${CODEX_SSH_TARGET:-codex-remote-control}"
TUNNEL_TARGET="${CODEX_SSH_TUNNEL_TARGET:-codex-remote-tunnel}"
SOCKS_PORT="${CODEX_SOCKS_PORT:-1080}"

# A dropped SSH connection can leave its remote forwarding listener alive for
# a short time. Clear only the dedicated sshd listener before launchd starts a
# replacement tunnel, otherwise ExitOnForwardFailure creates a restart loop.
cleanup_result=$(/usr/bin/python3 "$HOME/.codex/remote-tunnel/supervise.py" timeout 30 \
  /usr/bin/ssh \
  -o BatchMode=yes \
  -o ConnectTimeout=10 \
  -o LogLevel=ERROR \
  -o ServerAliveInterval=5 \
  -o ServerAliveCountMax=2 \
  "$REMOTE_TARGET" \
  'pid=$(ss -ltnp 2>/dev/null | grep "127.0.0.1:'"$SOCKS_PORT"'" | grep -o "pid=[0-9]*" | head -n 1 | cut -d= -f2)
   if [ -z "$pid" ]; then
     exit 0
   fi
   command=$(ps -o comm= -p "$pid" | tr -d " ")
   case "$command" in
     sshd*) ;;
     *) printf "refusing to stop non-sshd listener pid=%s command=%s" "$pid" "$command"; exit 73 ;;
   esac
   kill -TERM "$pid" 2>/dev/null || true
   waited=0
   while [ "$waited" -lt 8 ]; do
     if ! ss -ltnp 2>/dev/null | grep -q "127.0.0.1:'"$SOCKS_PORT"'"; then
       printf "removed stale remote listener pid=%s" "$pid"
       exit 0
     fi
     sleep 1
     waited=$((waited + 1))
   done
   printf "remote listener pid=%s did not stop" "$pid"
   exit 74' 2>&1)
cleanup_status=$?

if [ "$cleanup_status" -ne 0 ]; then
  printf 'tunnel preflight cleanup deferred status=%s result=%s\n' \
    "$cleanup_status" "$cleanup_result" >&2
elif [ -n "$cleanup_result" ]; then
  printf 'tunnel preflight: %s\n' "$cleanup_result" >&2
fi

exec /usr/bin/python3 "$HOME/.codex/remote-tunnel/supervise.py" tunnel \
  /usr/bin/ssh \
  -N \
  -o BatchMode=yes \
  -o ConnectTimeout=10 \
  -o ConnectionAttempts=1 \
  -o ExitOnForwardFailure=yes \
  -o ServerAliveInterval=30 \
  -o ServerAliveCountMax=3 \
  -o TCPKeepAlive=yes \
  "$TUNNEL_TARGET"
