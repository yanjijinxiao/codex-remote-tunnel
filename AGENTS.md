# Maintenance Rules

- Keep this repository deployment-neutral. Use external SSH configuration,
  environment variables, HOME-relative paths, and rendered templates.
- Edit here first. Keep production deployment separate from source edits and
  Git commits; do not automatically install, restart, or refresh credentials.
- Run `make test` for changes to script behavior. The tests use mocks and
  temporary files; never replace them with live production operations.
- Never commit credentials, environment files, certificates, SSH keys, logs,
  session histories, runtime state, backups, or dependency directories.
- Never include real hosts, ports, usernames, home paths, project names,
  organization names, or deployment fingerprints in files or Git metadata.
- Run `make privacy` against staged content and manually review it before a push.
- Before an authorized deployment, compare installed files with the expected
  version and preserve concurrent edits. Back up before replacing files.
- A restart requires a fresh task-activity check. Active or unknown task state
  must block it. Do not kill SSHD or unrelated application processes.
- Do not replay user tasks as a connectivity test. An authorized model probe
  must be separate, ephemeral, read-only, bounded, and cleaned up.
- Do not weaken TLS verification or change proxy scope during maintenance.
- Private repository visibility is not permission to include private data.
