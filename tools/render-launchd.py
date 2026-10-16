#!/usr/bin/env python3
"""Render HOME placeholders into ignored local output, without installing jobs."""

import argparse
from pathlib import Path
import plistlib


def replace_home(value, home):
    if isinstance(value, str):
        return value.replace("__HOME__", str(home))
    if isinstance(value, list):
        return [replace_home(item, home) for item in value]
    if isinstance(value, dict):
        return {key: replace_home(item, home) for key, item in value.items()}
    return value


def render(source, output, home):
    output.mkdir(parents=True, exist_ok=True)
    for template in sorted(source.glob("*.plist.in")):
        with template.open("rb") as stream:
            document = plistlib.load(stream)
        target = output / template.name.removesuffix(".in")
        with target.open("wb") as stream:
            plistlib.dump(replace_home(document, home), stream)
        target.chmod(0o600)


if __name__ == "__main__":
    root = Path(__file__).resolve().parent.parent
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=root / "generated" / "launchd")
    args = parser.parse_args()
    render(root / "launchd", args.output, Path.home())
    print("Rendered templates; no services were installed or started.")
