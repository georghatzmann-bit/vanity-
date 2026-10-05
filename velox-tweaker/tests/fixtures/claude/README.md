Fake Claude API data for `tests/Run-Tests.ps1` (group `claude`).

- `plan-ok.json` is the JSON text Claude would put into the `text` block of a successful
  structured-output response. It deliberately contains an unknown id, a risky id, a one-shot
  action, a tweak that is not applicable on Windows 11 and a duplicate, so the filter in
  `core/Claude.ps1` (`Select-VxClaudePlan`) is exercised. Only `gaming.gamedvr-off` and
  `gaming.mmcss-games` survive (plus `security.vbs-off` with `allowRisky`).
- The surrounding message envelopes (refusal, max_tokens, 401, 429, 400 mentioning
  `fallbacks`, 529) are built in the test itself and served by a local HttpListener mock
  (`VELOX_ANTHROPIC_BASE_URL`).
