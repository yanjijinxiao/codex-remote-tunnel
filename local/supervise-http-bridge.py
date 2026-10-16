#!/usr/bin/python3
"""Keep the loopback HTTP bridge owned by a live launchd-managed SSH session."""

import os
import signal
import subprocess
import time

stopping = False


def request_stop(_signum, _frame):
    global stopping
    stopping = True


def main():
    for signum in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
        signal.signal(signum, request_stop)
    command = [
        "/usr/bin/ssh", "-T",
        "-o", "BatchMode=yes", "-o", "ConnectTimeout=10",
        "-o", "ServerAliveInterval=10", "-o", "ServerAliveCountMax=3",
        "-o", "LogLevel=ERROR", os.environ.get("CODEX_SSH_TARGET", "codex-remote-control"),
        'exec "${CODEX_NODE_BIN:-$HOME/.local/bin/node}" "$HOME/.codex/remote-tunnel/http-bridge/http-bridge.mjs"',
    ]
    # Share launchd's process group so a killed supervisor cannot orphan SSH.
    child = subprocess.Popen(command, stdin=subprocess.PIPE, bufsize=0)
    os.set_blocking(child.stdin.fileno(), False)
    next_heartbeat = 0
    try:
        while child.poll() is None and not stopping:
            if time.monotonic() >= next_heartbeat:
                try:
                    os.write(child.stdin.fileno(), b"\n")
                except (BrokenPipeError, BlockingIOError):
                    break
                next_heartbeat = time.monotonic() + 10
            time.sleep(0.5)
    finally:
        child.stdin.close()
        if child.poll() is None:
            child.terminate()
            try:
                child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                child.kill()
        child.wait()
    return child.returncode if child.returncode >= 0 else 128 - child.returncode


if __name__ == "__main__":
    raise SystemExit(main())
