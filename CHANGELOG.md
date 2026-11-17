# Changelog

## Unreleased

### Behaviour changes

- **LLM failures no longer throw by default (Phase 3).** `translateProgram` now
  reports an HTTP error, timeout, unparseable, incomplete or empty model
  response as a *failed block* (`status: "failed"`, `blocks[].failureReason`)
  instead of rejecting. Set `throwOnFailure: true` to get the old behaviour when
  every block fails (the original error is rethrown). Configuration errors
  (e.g. a missing API key) still throw.
- **Failed blocks leave a marker.** `pythonCode` contains
  `# [block <id>: translation failed]` for a failed block instead of silently
  omitting it. Disable with `failedBlockMarker: false`.
- **`extractResponseText` no longer returns a JSON dump.** It concatenates all
  `output_text` parts of all messages, and throws `LlmResponseError`
  (`incomplete_response` / `empty_response`) when there is no usable text or the
  response is `incomplete`.
- **Diagnostics are always collected internally.** `includeDiagnostics` only
  controls whether they are returned. `verifyProgram` / `verifyStatements`
  ignore `collectDiagnostics` (kept for compatibility).
- **Identifiers keep their case** (Phase 2): `Score` and `score` are different
  variables; Python keywords get a `_` suffix; non-identifier method, function,
  exception and parameter names make the step invalid (dropped with a
  diagnostic).
- **Operator parentheses are minimal** (Phase 2): `(a + b) + c` is emitted as
  `a + b + c`.
- **HTTP server (Phase 1):** request-supplied `endpoint`, `model` and `llmApi`
  are ignored; `HOST` defaults to `127.0.0.1` and a non-loopback `HOST`
  requires `SERVER_AUTH_TOKEN`.

### Additions

- **Multi-sample consistency (Phase 6).** `samples` (1–7, AST mode),
  `consistency` result field, `CONSISTENCY_DISAGREEMENT` / `SAMPLE_FAILED`
  diagnostics, `src/consistency.ts`. `temperature` option (gateway only, only
  when set; never sent to azure). `samples: 1` behaves exactly as before.
  Vitest `testTimeout` raised to 30 s for the python-spawning tests.

- **Evidence-based grounding, AST schema v2 (Phase 5).** `AST_SCHEMA_VERSION = 2`:
  statements carry `evidence` and `print` carries `outputCue` (prompt
  `ast.v2`, schema v2). New `grounding: "off" | "warn" | "strict"` option
  (default `"warn"`, CLI `--grounding`) and `maxStatementsPerLine`; checks live
  in `src/grounding.ts`, number words in `src/numberWords.ts`. Output gating no
  longer relies only on the verb table when an `outputCue` is present. v1 ASTs
  still verify. The `astMode` docs no longer claim a guarantee.

- **Structured output for AST mode (Phase 4).** `structuredOutput: "auto" | "on" | "off"`
  (default `"auto"`) sends the AST JSON Schema (`src/astSchema.ts`) as
  `text.format` (`json_schema`, strict). In `auto`, a schema/format-related
  400/422 triggers one retry without it and the endpoint is remembered as
  unsupported for the process lifetime (diagnostic `STRUCTURED_OUTPUT_UNSUPPORTED`).
  `null` placeholders for absent optional fields are removed before
  verification. `parseJsonObject` remains as the fallback path.

- `TranslationResult.blocks`, `status`, `diagnosticsDetailed` (structured
  diagnostics with `blockId`, `line`, `severity`, `code`, `message`).
- `TranslateOptions.throwOnFailure`, `failedBlockMarker`, `timeoutMs`.
- Verification limits: statement nesting depth 32, expression depth 64.
