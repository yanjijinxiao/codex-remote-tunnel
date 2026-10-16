SHELL := /bin/bash

.PHONY: deps check test privacy

deps:
	npm ci --ignore-scripts --no-audit --no-fund --prefix remote/http-bridge

check:
	@for file in local/*.sh remote/codex-wrapper; do bash -n "$$file" || exit; done
	python3 -m compileall -q local tools
	@for file in remote/*.js remote/http-bridge/*.mjs local/*.test.js; do node --check "$$file" || exit; done
	@for file in launchd/*.plist.in; do plutil -lint "$$file" || exit; done

test: check
	node --test local/*.test.js remote/*.test.js remote/http-bridge/*.test.mjs
	PYTHONDONTWRITEBYTECODE=1 python3 local/test_auth_policy.py
	PYTHONDONTWRITEBYTECODE=1 python3 tools/test_render_launchd.py
	PYTHONDONTWRITEBYTECODE=1 python3 tools/test_privacy.py

privacy:
	python3 tools/check-privacy.py
