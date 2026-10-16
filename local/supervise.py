#!/usr/bin/python3
"""Bound short-lived checks and keep the health loop alive across SSH failures."""

import fcntl
import os
from pathlib import Path
import signal
import subprocess
import sys
import time


STOP_SIGNAL = 0
STATE_DIR = Path.home() / ".codex" / "remote-tunnel"
TUNNEL_LABEL = "com.codex.remote-tunnel"
HEALTH_LABEL = "com.codex.remote-tunnel-health"


def request_stop(signum, _frame):
    global STOP_SIGNAL
    STOP_SIGNAL = signum


def log(message):
    print(time.strftime("%Y-%m-%d %H:%M:%S"), message, flush=True)


def stop_group(process):
    # Only this invocation's new process group is eligible for termination.
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    except PermissionError:
        if process.poll() is None:
            raise
        return
    # Keep the group leader unreaped until cleanup is complete. Reaping it
    # early permits PID reuse and can detach remaining children from ownership.
    time.sleep(3)
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    except PermissionError:
        # Some macOS process-group checks reject an already-exited leader.
        # Never broaden the signal target when group ownership is unavailable.
        if process.poll() is None:
            raise
    process.wait()


def run_bounded(command, seconds, **kwargs):
    if STOP_SIGNAL:
        return 128 + STOP_SIGNAL
    process = subprocess.Popen(command, start_new_session=True, **kwargs)
    deadline = time.monotonic() + seconds
    try:
        while process.poll() is None:
            if STOP_SIGNAL:
                stop_group(process)
                return 128 + STOP_SIGNAL
            if time.monotonic() >= deadline:
                stop_group(process)
                return 124
            time.sleep(0.1)
        return process.returncode if process.returncode >= 0 else 128 - process.returncode
    finally:
        if process.poll() is None:
            stop_group(process)


def ensure_service(label):
    # kickstart without -k is idempotent: never kill a healthy tunnel.
    result = run_bounded(
        ["/bin/launchctl", "kickstart", "gui/%s/%s" % (os.getuid(), label)],
        15,
        stdout=subprocess.DEVNULL,
    )
    if result:
        log("supervisor: start request failed label=%s status=%s" % (label, result))


def ensure_tunnel():
    ensure_service(TUNNEL_LABEL)


def stop_tunnel(process):
    process.terminate()
    try:
        process.wait(timeout=3)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait()


def watch_tunnel(command):
    # Keep SSH in the launchd job's process group so launchd also cleans it
    # up if this supervisor is killed without a chance to handle SIGTERM.
    process = subprocess.Popen(command, start_new_session=False)
    log("tunnel supervisor started pid=%s ssh_pid=%s" % (os.getpid(), process.pid))
    next_check = 0
    try:
        while process.poll() is None:
            if STOP_SIGNAL:
                stop_tunnel(process)
                return 128 + STOP_SIGNAL
            if time.time() >= next_check:
                ensure_service(HEALTH_LABEL)
                next_check = time.time() + 30
            time.sleep(1)
        result = process.returncode if process.returncode >= 0 else 128 - process.returncode
        log("tunnel supervisor: SSH exited status=%s; health supervisor can request restart" % result)
        return result
    finally:
        if process.poll() is None:
            stop_tunnel(process)


def health_loop():
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    with (STATE_DIR / "remote-health-supervisor.lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            log("health supervisor: another supervisor is already running")
            return 75
        log("health supervisor started pid=%s interval=120 deadline=240" % os.getpid())
        next_check = 0
        while not STOP_SIGNAL:
            now = time.time()
            if now >= next_check:
                ensure_tunnel()
                if STOP_SIGNAL:
                    break
                log("health supervisor: starting check")
                started = time.monotonic()
                result = run_bounded(
                    ["/bin/bash", str(STATE_DIR / "check-tunnel.sh")], 240
                )
                log("health supervisor: check finished status=%s elapsed=%.1fs" %
                    (result, time.monotonic() - started))
                next_check = time.time() + 120
            # Wall-clock scheduling runs a check soon after wake, without
            # preventing sleep or relying on another launchd interval spawn.
            time.sleep(1)
        log("health supervisor stopped signal=%s" % STOP_SIGNAL)
    return 0


def main():
    for signum in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(signum, request_stop)
    if len(sys.argv) == 2 and sys.argv[1] == "health":
        return health_loop()
    if len(sys.argv) >= 3 and sys.argv[1] == "tunnel":
        return watch_tunnel(sys.argv[2:])
    if len(sys.argv) >= 4 and sys.argv[1] == "timeout":
        seconds = float(sys.argv[2])
        if not 0 < seconds <= 3600:
            raise ValueError("timeout must be between 0 and 3600 seconds")
        return run_bounded(sys.argv[3:], seconds)
    print("usage: supervise.py health | tunnel COMMAND ... | timeout SECONDS COMMAND ...", file=sys.stderr)
    return 64


if __name__ == "__main__":
    sys.exit(main())
