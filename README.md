# NLPG Translator

TypeScript service and CLI that translate beginner-friendly natural language programming instructions into Python, using the [Aalto OpenAI API gateway](https://aalto-openai-apigw.azure-api.net/).

Designed for intro programming courses: step-by-step English or Finnish instructions → Python suitable for CS1 (variables, control flow, lists, functions, exceptions, and more in AST mode).

## Requirements

- Node.js 20+
- An Aalto API subscription key (`AALTO_API_KEY`)

## Setup

```bash
npm install
npm run build
```

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `AALTO_API_KEY` | Yes (CLI/server) | API subscription key |
| `AALTO_ENDPOINT` | No | Responses API URL (CLI `--endpoint` overrides) |
| `PORT` | No | HTTP server port (default `4000`) |

## CLI

After `npm run build`:

```bash
# Direct mode (model writes Python)
npx nlp2py examples/example.nl

# AST mode (model → JSON AST → deterministic Python; recommended for fidelity)
npx nlp2py --ast examples/example.nl

# Optional NL linter (blocks translation on errors)
npx nlp2py --lint examples/undefined_variable.nl

# Teacher/debug: translator diagnostics on stderr
npx nlp2py --ast --verbose examples/example.nl

# Strict print enforcement (legacy behavior)
npx nlp2py --ast --strict-output-fidelity examples/example.nl
```

Exit code `1` when `--lint` reports errors; otherwise Python is written to stdout.

### CLI flags

| Flag | Description |
|------|-------------|
| `--ast` | AST transcription pipeline |
| `--lint` | Run rule-based NL linter before calling the API |
| `--separate-blocks` | Translate each API block independently |
| `--unsupported comment\|fallback` | AST: comment vs direct-mode fallback for unknown constructs |
| `--reasoning minimal\|low\|medium\|high` | Reasoning effort for the model |
| `--verbose` | Print `diagnostic:` lines to stderr (AST mode) |
| `--strict-output-fidelity` | Drop/strip prints not grounded in explicit output verbs |
| `--endpoint <url>` | Override API endpoint |

## HTTP API

Start the server:

```bash
npm start
```

`POST /translate` with JSON body:

```json
{
  "blocks": [{ "id": "block-1", "text": "Let the score be 0.\nPrint the score." }],
  "astMode": true,
  "enableLint": false,
  "includeDiagnostics": false,
  "strictOutputFidelity": false,
  "unsupportedBehavior": "comment",
  "reasoningEffort": "low"
}
```

Response:

```json
{
  "pythonCode": "score = 0\nprint(score)",
  "errors": []
}
```

With `includeDiagnostics: true` and AST mode, non-fatal notices appear in `diagnostics` (intended for teachers/operators, not students).

## Library

```ts
import { translateProgram } from "nlp-translator-ts";

const result = await translateProgram(
  [{ id: "b1", text: "Let the score be 0.\nPrint the score." }],
  {
    aaltoApiKey: process.env.AALTO_API_KEY!,
    astMode: true,
  }
);

console.log(result.pythonCode);
```

## Translation modes

### Direct mode (default)

The model returns Python directly. Post-processing only strips markdown code fences. Prompts discourage invented logic and extra `print` calls.

### AST mode (`astMode: true`)

1. Model returns JSON matching the course AST schema (see `src/ast.ts`).
2. `verifyProgram` validates and grounds each node to a source line.
3. `generatePython` renders Python deterministically.

Unsupported constructs become `# unsupported: …` comments unless `unsupportedBehavior` is `fallback` (whole block re-translated in direct mode).

**Recommendation:** use AST mode for teaching fidelity; use direct mode for quick experiments or when the AST cannot represent a construct.

## Natural language linter

Optional (`enableLint` / `--lint`). Rule-based checks for:

- Assignment-style prose (“make a program that…”)
- Ambiguous words (`big`, `many`, …)
- Undefined variables (English patterns)
- Unsupported condition/loop forms

Lint rules are narrower than AST mode capabilities (English-centric v0).

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

Calls the real Aalto endpoint. Requires `AALTO_API_KEY` (optional: `AALTO_ENDPOINT`).

```bash
export AALTO_API_KEY=your-key
npm run test:integration
```

Skipped automatically when the key is unset (CI unit job stays green). A separate GitHub Actions job runs integration tests when the `AALTO_API_KEY` repository secret is configured.

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
| `src/translator.ts` | API client, prompts, pipelines |
| `src/linter.ts` | NL linter |
| `src/index.ts` | Public `translateProgram` API |
| `src/cli.ts` / `src/server.ts` | CLI and HTTP entrypoints |
| `tests/` | Unit tests |
