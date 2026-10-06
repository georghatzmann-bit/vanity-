Fake Claude Code CLI for the tests (`tests/Run-Tests.ps1` group `ai`, `tests/ui/run-ui-tests.mjs --real`).

- `claude` is a Node script (executable) that answers `--version`, `auth status` and `-p` with canned
  JSON shaped like Claude Code 2.1.x. It never touches the network. `claude.cmd` wraps it for Windows.
- `VELOX_FAKE_CLAUDE_MODE`: `ok` (structured_output), `text` (JSON in a ``` fence in `result`),
  `old` (rejects the newer flags like an old CLI and has no `auth` command), `logged-out`, `limit`
  (usage limit reached), `schema-fail` (structured output retries exhausted), `slow` (hangs 60 s).
- `VELOX_FAKE_CLAUDE_LOG`: every call appends `{ argv, cwd, stdin, systemFile, env }` as one JSON line.
- The tests put this folder first on `PATH` and set `VELOX_CLAUDE_CLI` + `VELOX_CLAUDE_CLI_ONLY=1`, so a
  real Claude Code installation is never found or run.
