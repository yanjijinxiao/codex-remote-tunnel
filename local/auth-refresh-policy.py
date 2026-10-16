#!/usr/bin/python3
"""Decide whether same-account, newer local login data can repair remote expiry."""

import base64
import hashlib
import json
import sys
import time


def decide(local, remote, now):
    tokens = local.get("tokens") or {}
    account = tokens.get("account_id")
    if not isinstance(account, str) or not account:
        return {"state": "blocked", "reason": "local-chatgpt-account-missing"}
    digest = hashlib.sha256(account.encode()).hexdigest()
    if digest != remote.get("accountHash"):
        return {"state": "blocked", "reason": "account-mismatch-or-unknown"}
    try:
        segment = tokens["access_token"].split(".")[1]
        payload = json.loads(base64.urlsafe_b64decode(segment + "=" * (-len(segment) % 4)))
        local_expiry = payload["exp"]
        remote_expiry = remote["expiresAt"]
        if type(local_expiry) is not int or type(remote_expiry) is not int:
            raise ValueError("expiry is not an integer")
    except (KeyError, IndexError, ValueError, TypeError, AttributeError):
        return {"state": "blocked", "reason": "expiry-unavailable"}
    if abs(remote.get("now", now) - now) > 300:
        return {"state": "blocked", "reason": "clock-skew"}
    detail = {"remoteExpiresAt": remote_expiry, "localExpiresAt": local_expiry}
    if remote_expiry > now + 3600:
        return {"state": "fresh", **detail}
    if local_expiry <= now + 3600 or local_expiry <= remote_expiry + 300:
        return {"state": "blocked", "reason": "no-newer-valid-local-token", **detail}
    return {"state": "sync-needed", **detail}


if __name__ == "__main__":
    try:
        with open(sys.argv[1], encoding="utf-8") as stream:
            local_auth = json.load(stream)
        result = decide(local_auth, json.loads(sys.argv[2]), int(time.time()))
    except (OSError, ValueError, TypeError, AttributeError, IndexError):
        result = {"state": "blocked", "reason": "auth-metadata-unavailable"}
    print(json.dumps(result, separators=(",", ":")))
