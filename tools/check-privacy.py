#!/usr/bin/env python3
"""Check staged contents without printing potentially private matched values."""

import ipaddress
import re
import subprocess
import sys


def problems(text):
    findings = []
    for match in re.finditer(r"(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?![\w.])", text):
        try:
            address = ipaddress.ip_address(match.group())
        except ValueError:
            continue
        if not address.is_loopback:
            findings.append("non-loopback IP literal")
    patterns = {
        "personal home path": r"/(?:Users|home)/[A-Za-z0-9_.-]+",
        "private key": r"-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----",
        "token literal": r"(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]{20,}|sk-(?:proj-)?[A-Za-z0-9_-]{24,}",
        "cloud credential": r"AKIA[A-Z0-9]{16}",
        "email address": r"[A-Za-z0-9._%+-]+@(?!example\.invalid\b)[A-Za-z0-9.-]+\.[A-Za-z]{2,}",
    }
    for name, pattern in patterns.items():
        if re.search(pattern, text):
            findings.append(name)
    return sorted(set(findings))


def main():
    files = subprocess.check_output(["git", "ls-files", "-z"]).decode().split("\0")
    failed = False
    for file in filter(None, files):
        data = subprocess.check_output(["git", "show", ":" + file]).decode("utf-8")
        for problem in problems(data):
            print(f"{file}: {problem}", file=sys.stderr)
            failed = True
    if failed:
        return 1
    print("Staged privacy checks passed; manual review is still required.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
