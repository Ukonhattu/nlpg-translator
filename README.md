# NLPG Translator

TypeScript service and CLI that translate beginner-friendly natural language programming instructions into Python via the OpenAI **Responses API**, using either the [Aalto Azure gateway](https://aalto-openai-apigw.azure-api.net/) or the [Aalto k8s LLM gateway](https://llm-gateway.k8s.aalto.fi/docs).

Designed for intro programming courses: step-by-step English or Finnish instructions → Python suitable for CS1 (variables, control flow, lists, functions, exceptions, and more in AST mode).

## Requirements

- Node.js 20+
- For Azure Responses API: `AALTO_API_KEY`
- For k8s LLM gateway: `LLM_GATEWAY_API_KEY` (when using `llmApi: "gateway"`)

## Setup

```bash
npm install
npm run build
```

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `AALTO_API_KEY` | For `llmApi=azure` (default) | Azure APIM subscription key |
| `AALTO_ENDPOINT` | No | Responses API URL (library/CLI can override; the HTTP server cannot be overridden per request) |
| `AALTO_MODEL` | No | Default model for Responses API |
| `LLM_GATEWAY_API_KEY` | For `llmApi=gateway` | k8s gateway token (`Authorization: Bearer …`) |
| `LLM_GATEWAY_RESPONSES_ENDPOINT` | No | Gateway Responses URL (default: `/api/v1/responses`) |
| `LLM_GATEWAY_MODEL` | No | Default model for gateway |
| `PORT` | No | HTTP server port (default `4000`) |
| `HOST` | No | HTTP bind address (default `127.0.0.1`). A non-loopback value requires `SERVER_AUTH_TOKEN` |
| `SERVER_AUTH_TOKEN` | If `HOST` is not loopback | Bearer token required on `POST /translate` |
| `SERVER_MODEL_PROFILES` | No | JSON map of named model profiles, see [Security](#security-http-server) |
| `MAX_BLOCKS` | No | Max blocks per request (default `50`) |
| `MAX_TEXT_CHARS` | No | Max total block text length (default `20000`) |
| `LLM_TIMEOUT_MS` | No | Timeout per upstream LLM request (default `60000`) |

## CLI

After `npm run build`:

```bash
# Direct mode (model writes Python)
npx nlp2py examples/example.nl

# AST mode (model → JSON AST → deterministic Python; makes additions visible)
npx nlp2py --ast examples/example.nl

# Optional NL linter (--lint blocks translation on errors; --lint-mode warn only reports)
npx nlp2py --lint examples/undefined_variable.nl

# Teacher/debug: translator diagnostics on stderr
npx nlp2py --ast --verbose examples/example.nl

# Strict print enforcement (legacy behavior)
npx nlp2py --ast --strict-output-fidelity examples/example.nl

# K8s gateway — requires LLM_GATEWAY_API_KEY
npx nlp2py --api gateway --ast examples/example.nl
```

Exit code `1` when `--lint` reports errors; otherwise Python is written to stdout.

### CLI flags

| Flag | Description |
|------|-------------|
| `--api azure\|gateway` | LLM backend (default `azure`) |
| `--model <name>` | Override model for the selected backend |
| `--ast` | AST transcription pipeline |
| `--lint` | Run the English NL linter and block on errors (same as `--lint-mode block`) |
| `--lint-mode off\|warn\|block` | Linter behaviour (`warn` reports findings and still translates) |
| `--separate-blocks` | Translate each API block independently |
| `--unsupported comment\|fallback` | AST: comment vs direct-mode fallback for unknown constructs |
| `--reasoning minimal\|low\|medium\|high` | Reasoning effort for the model |
| `--verbose` | Print `diagnostic:` lines to stderr (AST mode) |
| `--strict-output-fidelity` | AST: drop prints not grounded in explicit output verbs (direct mode only warns) |
| `--grounding off\|warn\|strict` | AST: check steps against the source text (default `warn`) |
| `--endpoint <url>` | Override API endpoint |

## HTTP API

Start the server:

```bash
npm start
```

`POST /translate` uses the **same JSON shape** for Azure (`llmApi: "azure"`, default) and the k8s gateway (`llmApi: "gateway"`). Both backends support **direct mode** (omit `astMode`) and **AST mode** (`astMode: true`).

Shared fields:

| Field | Description |
|-------|-------------|
| `blocks` | Required instruction blocks |
| `modelProfile` | Name of a server-side model profile (optional; first profile or env defaults if omitted). Unknown name → 400 |
| `astMode` | `true` for AST pipeline, omit/false for direct Python |
| `reasoningEffort` | Reasoning effort for the model |

API keys are never sent in the request body (server uses `AALTO_API_KEY` or `LLM_GATEWAY_API_KEY`).

**Azure Responses (AST mode):**

```json
{
  "blocks": [{ "id": "block-1", "text": "Let the score be 0.\nPrint the score." }],
  "modelProfile": "gpt5",
  "astMode": true,
  "reasoningEffort": "low"
}
```

**K8s gateway (AST mode):**

```json
{
  "blocks": [{ "id": "block-1", "text": "Let the score be 0.\nPrint the score." }],
  "modelProfile": "qwen",
  "astMode": true,
  "reasoningEffort": "low"
}
```

Profiles are configured on the server, e.g. `SERVER_MODEL_PROFILES='{"gpt5":{"llmApi":"azure","model":"gpt-5-2025-08-07"},"qwen":{"llmApi":"gateway"}}'`. Set `LLM_GATEWAY_API_KEY` on the server when a profile uses the gateway. `llmApi`, `model` and `endpoint` in the request body are ignored.

Response:

```json
{
  "pythonCode": "score = 0\nprint(score)",
  "errors": []
}
```

With `includeDiagnostics: true` and AST mode, non-fatal notices appear in `diagnostics` (intended for teachers/operators, not students).

## Security (HTTP server)

The HTTP server is meant for **internal deployment behind authentication**, not for direct exposure to the internet.

- Endpoints, models and API keys come only from server environment variables; request bodies cannot redirect the server to another URL or select arbitrary models. Use `modelProfile` to choose among operator-defined profiles.
- The server binds to `127.0.0.1` by default. Set `HOST` to expose it; any non-loopback `HOST` requires `SERVER_AUTH_TOKEN`, and the server refuses to start without it. Clients send `Authorization: Bearer <token>` (compared in constant time; 401 on mismatch).
- Requests are limited to 64 kB of JSON, `MAX_BLOCKS` blocks and `MAX_TEXT_CHARS` characters; each block needs a string `id` and `text`.
- Upstream LLM calls time out after `LLM_TIMEOUT_MS`. Upstream error bodies are logged server-side and never returned; clients get a generic 502/504/500 with a `requestId`.

The library and CLI still accept `endpoint`/`model` overrides, because there the caller owns the API key. `timeoutMs` is available in `TranslateOptions`.

### Direct mode: no silent repairs

Direct mode returns what the model wrote, after removing markdown fences and comments (string-aware). It does not delete or rewrite lines. Suspicious output is reported instead: `DIRECT_EXTRA_PRINTS` (more `print()` calls than source lines asking for output) and `DIRECT_SYNTAX_ERROR` (checked with a WASM tree-sitter parser; the block becomes `partial`, the code is untouched). For experimental baselines use `directPostProcess: "none"` (only fences removed) and pin `promptVersion` (`"v2"` default, `"v1"` for the original prompt). Both modes default to `reasoningEffort: "low"`.

### AST mode: what is verified (and what is not)

The model transcribes the instructions into a JSON AST (schema v2); Python is generated deterministically from it. Every step must cite its source `line` and quote verbatim `evidence`, and `print` steps must name the `outputCue` word on that line. Verification then checks:

- **Shape and safety:** node shapes, identifiers, line numbers, nesting depth.
- **Grounding** (`grounding: "warn"` by default, `"strict"`, or `"off"`), reported as `GROUNDING_*` diagnostics:
  `EVIDENCE` (quote is on the cited line), `OUTPUT_CUE` (print has a real output word, not "the"), `LITERAL` (every number and string appears on the line, including number words such as "twenty" / "kaksikymmentä"), `IDENTIFIER` (name parts occur in the block), `LINE_UNCITED` (a source line no step represents), `LINE_MULTI` (one line cited by too many steps), `NESTING` (a child step outside its parent's line span). ASTs without evidence (v1) still work; `GROUNDING_V1_INPUT` notes that evidence checks were skipped.
- In `"strict"` mode a step failing the evidence, cue or literal check is replaced by `# unsupported: ...` (a compound step takes its nested steps with it) and the block becomes `partial`.

This makes invented steps, values and prints **visible or removable**. It does **not** check that the model's interpretation is semantically right: a step can be traceable to the text and still misread it.

### Multi-sample consistency (AST mode)

`samples: N` (1–7, default 1) asks the model for N independent ASTs per block (run concurrently, at most 4 at a time). Each is verified and grounded on its own; programs are compared after dropping `evidence`, `outputCue`, `source`, `raw` and notes (line numbers stay). The most frequent program is used; ties go to the sample with the fewest grounding warnings, then the fewest `unknown` steps, then the first. The result gains:

```json
"consistency": { "samples": 3, "agreement": 0.67, "disagreeingLines": [{ "blockId": "b", "line": 1, "variants": 2 }] }
```

and a `CONSISTENCY_DISAGREEMENT` warning per line that was read in more than one way ("this step can be read in more than one way"). This library only reports it; showing it to students is up to the host system. Failed samples are ignored (`SAMPLE_FAILED`). `samples` costs N times the tokens and is ignored in direct mode.

Sampling diversity: `temperature` is sent only to the `gateway` backend and only when you set it; gpt-5 models on `azure` ignore or reject it, so it is never sent there.

### Structured output (AST mode)

In AST mode the request carries a strict JSON Schema for the AST (`text.format`), so the model can only return well-formed nodes. `structuredOutput: "auto"` (default) falls back to plain JSON once if an endpoint (e.g. the vLLM gateway) rejects the schema; use `"off"` to never send it or `"on"` to require it. The schema constrains shape only; line numbers, identifiers and grounding are still checked by verification.

## Result status and diagnostics

`translateProgram` returns, besides `pythonCode` and `errors`:

| Field | Description |
|-------|-------------|
| `status` | Worst block status: `"ok"`, `"partial"` (some nodes dropped or `unknown`) or `"failed"` (no usable code) |
| `blocks[]` | Per block: `id`, `status`, `pythonCode`, `droppedNodes`, `unknownNodes`, and `failureReason` (`parse_error`, `incomplete_response`, `empty_response`, `http_error`, `timeout`) when failed |
| `diagnostics` / `diagnosticsDetailed` | Only with `includeDiagnostics: true`. Detailed entries are `{ blockId, line?, severity, code, message }` |

A failed block contributes `# [block <id>: translation failed]` to `pythonCode` (`failedBlockMarker: false` disables it). Failures do not throw unless `throwOnFailure: true` and every block failed; the CLI and HTTP server set it so total failures stay errors (the server maps them to 502/504). See `CHANGELOG.md` for behaviour changes.

## Library

Same options as the HTTP API (`llmApi`, `endpoint`, `model`, `astMode`, …). Keys can be passed explicitly or read from the environment by `resolveLlmConfig`.

```ts
import { translateProgram } from "nlp-translator-ts";

// Azure + AST
const azure = await translateProgram(blocks, {
  llmApi: "azure",
  aaltoApiKey: process.env.AALTO_API_KEY!,
  model: "gpt-5-2025-08-07",
  astMode: true,
});

// Gateway + direct
const gateway = await translateProgram(blocks, {
  llmApi: "gateway",
  gatewayApiKey: process.env.LLM_GATEWAY_API_KEY!,
  model: "Qwen/Qwen3-30B-A3B-Instruct-2507-FP8",
});
```

## Translation modes

Direct and AST modes work with **both** `llmApi: "azure"` and `llmApi: "gateway"`.

### Direct mode (default)

The model returns Python directly. Post-processing only strips markdown code fences. Prompts discourage invented logic and extra `print` calls.

### AST mode (`astMode: true`)

1. Model returns JSON matching the course AST schema (see `src/ast.ts`).
2. `verifyProgram` validates and grounds each node to a source line.
3. `generatePython` renders Python deterministically.

Unsupported constructs become `# unsupported: …` comments unless `unsupportedBehavior` is `fallback` (whole block re-translated in direct mode).

**Recommendation:** use AST mode for teaching fidelity; use direct mode for quick experiments or when the AST cannot represent a construct.

## Natural language linter

**English only** (Finnish instructions are not linted). Rule-based checks for:

- Assignment-style prose (“make a program that…”)
- Ambiguous words (`big`, `small`, `huge`, `many`, `few`), matched as whole words outside quoted text (so “ambiguous”, “biggest”, “Germany” are fine)
- Undefined variables (English patterns; operation phrases such as “the sum of x and y” are skipped)
- Unsupported condition forms (comparisons against a number or another variable, or equality between variables) and `Repeat` loops without a count (`Repeat 3 times:` or `Repeat the following 3 times`)

`lintMode` controls what happens with the findings:

| Mode | Behaviour |
|------|-----------|
| `"off"` (default) | No linting |
| `"warn"` | Translate anyway; findings are returned as `LINT_*` diagnostics (always returned, for the author of the instructions); `errors` stays empty |
| `"block"` | Return the findings in `errors` and translate nothing |

`enableLint: true` / CLI `--lint` still mean `"block"`; CLI `--lint-mode off|warn|block` and the HTTP field `lintMode` set it explicitly. Lint rules are narrower than AST mode capabilities, so prefer `"warn"`.

## Development

```bash
npm run lint      # ESLint
npm test          # Unit tests (no API key)
npm run test:watch
npm run build
```

Unit tests cover AST verification, codegen (including complex constructs), golden AST fixtures, output-verb heuristics, fidelity helpers, and the NL linter without calling the live API.

Golden fixtures live in `tests/fixtures/golden/`; integration scenarios in `tests/integration/cases.ts` and `examples/integration/`.

### Integration tests (live API)

Calls the real LLM endpoints. Requires `AALTO_API_KEY` for Azure tests (optional: `AALTO_ENDPOINT`). Gateway tests run when `LLM_GATEWAY_API_KEY` is set.

```bash
export AALTO_API_KEY=your-key
npm run test:integration
```

Skipped automatically when the key is unset (CI unit job stays green). A separate GitHub Actions job runs integration tests when the `AALTO_API_KEY` repository secret is configured. Gateway tests run only when `LLM_GATEWAY_API_KEY` is set.

## Docker

Build TypeScript first, then image:

```bash
npm run build
docker build -t nlpg-translator .
docker run -e AALTO_API_KEY=... -p 4000:4000 nlpg-translator
```

## Examples

Sample instruction files live in [`examples/`](examples/). Useful cases:

- `example.nl` — basic score loop
- `undefined_variable.nl` — lint error demo
- `ambiguous_language.nl`, `invalid_condition.nl`, `invalid_loop.nl` — linter edge cases

## Project layout

| Path | Role |
|------|------|
| `src/ast.ts` | AST types, validation, verify |
| `src/codegen.ts` | AST → Python |
| `src/llmConfig.ts` | Per-request LLM provider resolution |
| `src/translator.ts` | API client, prompts, pipelines |
| `src/linter.ts` | NL linter |
| `src/index.ts` | Public `translateProgram` API |
| `src/cli.ts` / `src/server.ts` | CLI and HTTP entrypoints |
| `tests/` | Unit tests |
