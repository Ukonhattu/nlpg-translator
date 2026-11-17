# Plan: multiple target languages (Python → Python + C → more)

Status: implemented for C (Phases 0–6) · 2026-11-17. See [§9](#9-what-was-built-and-where-it-differs-from-the-plan) for what differs from the original proposal.

## 1. Where we are

The pipeline already has the right shape for multiple targets:

```
NL text ──LLM──▶ JSON AST ──verify/ground──▶ Stmt[] ──codegen──▶ Python
                 (src/ast.ts)  (ast.ts, grounding.ts)   (codegen.ts)
```

The LLM never writes code in AST mode, so **the expensive, nondeterministic part
(LLM call, verification, grounding, sampling/consensus) is target-independent.**
Adding C is mostly a new deterministic back end. One AST can feed several targets
from one LLM call.

Python is wired in at these points:

| Place | Python coupling |
|---|---|
| `src/codegen.ts` | Whole file is the Python emitter (`generatePython`) |
| `src/identifiers.ts` | Python keywords and builtins; `isValidNormalizedIdentifier` (used by verify) checks *Python* validity |
| `src/pythonSyntax.ts` | tree-sitter-python syntax check (direct mode) |
| `src/direct.ts` | Python tokenizer for stripping comments and dead ternaries |
| `src/prompts/direct.v*.ts` | "translate into Python" |
| `src/prompts/ast.v2.ts` | Says "You DO NOT write Python" and "stop is EXCLUSIVE (Python range)". These describe the IR semantics, so they can stay |
| `src/translator.ts` | `pythonCode` everywhere; `# [block …: translation failed]` marker; per-block codegen and string concatenation in `assemble` |
| `src/index.ts`, `cli.ts`, `server.ts` | `pythonCode` in the public API; `nlp2py` bin |
| `src/linter.ts`, `astRecovery.ts` | Use `toPythonIdentifier` only to normalise names (not really Python-specific) |
| Tests | `tests/helpers/python.ts`, golden fixtures (raw AST → Python) |

## 2. The core problem C adds: the AST is untyped and Pythonic

Python lets the generator be a near-1:1 printer. C needs information the AST
does not carry:

1. **Static types.** `x = 5`, `name = input()`, `xs = [1, 2]`, function params and returns all need C types.
2. **Declarations and scope.** Python scope is per function. C scope is per block, so a variable first assigned inside an `if` and used after it must be declared earlier.
3. **Program structure.** Functions go at file scope (with prototypes) and statements go inside `int main(void)`.
4. **Semantics that differ.** `/` is true division in the AST (Python semantics). `%` on floats needs `fmod`. Strings are immutable values with `+`. Lists grow dynamically. `in`, `len`, `sum/max/min`, `str()` and `int()` casts, and f-strings have no direct C equivalent.
5. **No equivalent at all (in CS1-level C).** `try/except`, `raise`, tuple return/unpack, and arbitrary `methodcall`s.

So the plan adds a **target-independent semantic pass** (type inference + scope
analysis) between verification and codegen. Every statically typed target (C,
then Java, C#, TypeScript, …) reuses it.

## 3. Target architecture

### 3.1 `Target` interface

```ts
// src/targets/types.ts
export type TargetId = "python" | "c";

export interface Target {
  id: TargetId;
  displayName: string;            // "Python 3.10", "C11"
  fileExtension: string;          // ".py", ".c"
  lineComment(text: string): string;          // "# …", "// …"

  /** Per-node capability check, run before codegen. Unsupported nodes become
   *  `unknown`-like nodes with a TARGET_UNSUPPORTED diagnostic, so they count
   *  toward `unknownNodes`, status becomes "partial", and the existing
   *  `--unsupported fallback` path (direct mode) works unchanged. */
  checkSupport(program: AnalyzedProgram): SupportReport;

  /** Deterministic AST → code. Gets the *whole program* (all blocks), see 3.3. */
  generate(program: AnalyzedProgram, ctx: CodegenContext): GeneratedProgram;

  /** Identifier policy (keywords, reserved runtime names, charset). */
  identifiers: IdentifierPolicy;

  /** Direct mode. */
  directPrompt: PromptInfo;
  postProcessDirect(raw: string, source: string, mode: DirectPostProcess): DirectResult;
  checkSyntax(code: string): Promise<SyntaxProblem[] | null>;   // tree-sitter-<lang>.wasm
}
```

Layout:

```
src/targets/
  types.ts, registry.ts         getTarget(id), listTargets()
  python/  codegen.ts (moved from src/codegen.ts), identifiers.ts, syntax.ts, direct.ts
  c/       codegen.ts, identifiers.ts, runtime.ts (helper snippets), syntax.ts, direct.ts
src/semantics/
  types.ts      Type = int | float | bool | str | list<T> | none | unknown
  infer.ts      type inference + scope/declaration analysis
```

### 3.2 Semantic pass (`src/semantics`)

Input: verified `Stmt[]`. Output: an `AnalyzedProgram` (the AST plus side tables;
do not mutate the AST, because golden fixtures and consistency hashing rely on it):

- `exprType: Map<Expr, Type>` and `varType: Map<Scope, Map<name, Type>>`
- `declarations`: for each function and the top level, the set of locals with types (C hoists declarations to the top of the function, which matches Python scoping)
- `functions`: signatures inferred from call sites and `return`s, solved together as a small fixpoint (monomorphic: one signature per function)
- `diagnostics`: `TYPE_CONFLICT` (variable reassigned with a different type), `TYPE_UNKNOWN` (e.g. a parameter never called, or an empty-list element type)

Rules (simple local inference is enough for CS1 programs):

- Literals give their own types. `input()` gives `str`; `input` with `cast` and `cast` give the cast type.
- `int (op) float` gives `float`. `/` always gives `float` (true division). `+` on `str` gives `str`.
- `compare`, `boolop`, `not` and `contains` give `bool`.
- `list` items unify to `list<T>`. An empty list `[]` gets its T from later `append`, `assign`-by-index or `forin` use.
- `len` gives `int`. `sum`, `max` and `min` on `list<T>` give `T`. `str()` gives `str`.
- `int` and `float` unify to `float` (with an info diagnostic). Any other conflict is an error for typed targets.

Python ignores the result (it stays a 1:1 printer), but it can use the
diagnostics as teacher hints later.

### 3.3 Whole-program codegen and block assembly

Today each block is generated on its own and `assemble()` joins strings with
`\n\n`. C needs one translation unit (one `main`, hoisted functions, one
`#include` set, types that cross blocks). Change:

- `BlockOutcome` keeps its verified `statements` (and still keeps its per-block code for Python).
- `assemble()` calls `target.generate()` once over the concatenated statements of all non-failed blocks, with block boundaries kept as markers (`// --- block b2 ---`), so failed-block markers still land in the right place.
- `BlockResult.code` for C is that block's fragment of `main`, for display. The runnable program is the top-level `code`.
- With the default (blocks combined into one), nothing changes in behaviour. `separateBlocks` with C still produces one program.

Direct mode with C and several blocks: the model writes C per block, which cannot
be stitched together reliably. **Direct mode for C will require a single block
(the default) and reject `separateBlocks`**, with a clear error.

### 3.4 Public API (backward compatible)

- `TranslateOptions.target?: TargetId` (default `"python"`). Later: `targets?: TargetId[]` to emit several languages from one AST (one LLM call).
- Result: add `code` and `target`. Keep `pythonCode` as a **deprecated alias that is set only when target = python**, so every current test and consumer keeps working.
- CLI: `--target python|c`. Add a neutral bin `nlpc` and keep `nlp2py` as an alias that defaults to Python.
- Server: `target` in the request body, validated against the registry. The response gets `code` and `target` (plus `pythonCode` for Python). Optional: a server-side allowlist via `SERVER_TARGETS`.
- Failure marker and `unknown` comments use `target.lineComment()`.

## 4. C target design

**Dialect:** C11, single file, `#include`s for `stdio.h`, `stdlib.h`, `string.h`, `stdbool.h` and `math.h` (and `assert.h` when used), emitted only when needed. It must compile with `cc -std=c11 -Wall -Wextra -Werror -pedantic`.

**Shape of the output:**

```c
#include <stdio.h>
/* runtime helpers actually used, e.g. nl_read_int, nl_list_int */

int add(int a, int b);          /* prototypes */

int add(int a, int b) {
    return a + b;
}

int main(void) {
    int total;                  /* hoisted declarations */
    total = 0;
    printf("%d\n", total);
    return 0;
}
```

Declaration style: hoist the *declaration* only (`int total;`) and keep the
assignment where the source line is, so the source-line ↔ code-line
correspondence that teachers rely on is kept. Option: `--c-style inline` puts the
declaration on the first assignment when it is safe (first assignment at function
top level and dominating every use).

**Construct mapping (v1):**

| AST | C | Notes |
|---|---|---|
| int / float / bool / str | `int`, `double`, `bool`, `char *` | strings use runtime helpers |
| `assign`, `augassign` | `x = …;` | augassign written out in full, as Python does today |
| `binop /` | `(double)a / b` when both are int | keeps Python's true division. Open question Q2 |
| `binop %` on float | `fmod(a, b)` | `-lm` |
| `str + str` | `nl_str_concat(a, b)` | |
| `compare` on str | `strcmp(a, b) == 0` and so on | |
| `boolop`, `not` | `&&`, `\|\|`, `!` | precedence table like codegen.ts |
| `print` | `printf` with a format chosen by type | float formatting: Q1 |
| `fstring` in print | one `printf` with a merged format | |
| `fstring` elsewhere | `nl_format(...)` (snprintf into the arena) | |
| `input` (+cast) | `nl_read_line()`, `nl_read_int()`, `nl_read_double()` | prompt printed first without a newline |
| `cast` | `(int)`, `(double)`, `nl_int_to_str`, `atoi`/`strtod` | |
| `if`/`elif`/`else`, `while`, `break`, `pass` | same, `else if`, `;` | |
| `for` range | `for (i = a; i < b; i += s)` | negative step uses `>`. Step sign must be known at compile time (literal), otherwise TARGET_UNSUPPORTED |
| `repeat` | `for (int nl_i1 = 0; nl_i1 < n; nl_i1++)` | |
| `list` of int, double or str | `NlListInt` and similar (dynamic array in the runtime) | `append`, `index` (incl. negative), `len`, `sum`, `max`, `min`, `in`, `forin` |
| `functiondef`, `return` (one value), `call` | function + prototype | types come from the semantic pass. Docstring becomes a `/* */` comment |
| `assert` | `assert(test)` | message as `&& "msg"` when it is a literal |
| `exprstmt` | call + `;` | |
| `methodcall` on str: `upper`, `lower`, `strip`, `capitalize`, `replace` | runtime helpers | others are TARGET_UNSUPPORTED |
| `try`, `raise`, `return` with ≥2 values, `unpackassign` | **TARGET_UNSUPPORTED** | comment + diagnostic; `--unsupported fallback` hands them to direct-C mode |
| `unknown` | `// unsupported: …` | |

**Runtime prelude (`src/targets/c/runtime.ts`):** a set of small, readable C
snippets with dependencies (e.g. `nl_list_int` needs `nl_alloc`). Codegen records
which helpers it used and emits only those, in dependency order, above the
prototypes. All names start with `nl_`. The identifier policy reserves that
prefix, and `NAME_COLLISION` handling extends to it. Memory comes from one arena
freed at exit, so student-facing code has no `free` noise. This is fine for
short-running CS1 programs and is documented.

**Identifiers:** C keywords (C11 plus `bool`, `true`, `false`), reserved names
(`main` and libc names used by the prelude), the `nl_` prefix. **Non-ASCII
letters (Finnish `ä`, `ö`, `å`) are transliterated** (`summa_ään` → `summa_aan`),
with NAME_COLLISION diagnostics when two names merge. `isValidNormalizedIdentifier`
in verify stays a *language-neutral* check (rename it, move it out of
`targets/python`) and must not become C-specific, because the AST should keep the
student's names.

## 5. Phases

Each phase is a separate PR. Phases 0–1 change no output.

**Phase 0: target seam, Python only (refactor, no behaviour change)**
- Add `src/targets/{types,registry}.ts`. Move `codegen.ts`, `pythonSyntax.ts`, the Python parts of `identifiers.ts` and the Python tokenizer from `direct.ts` under `targets/python/`. Re-export from the old paths so nothing breaks.
- Make the translator call `getTarget(options.target ?? "python")` everywhere it now calls Python helpers directly. Failure marker and comments go through `lineComment`.
- Add `code` and `target` to results and keep `pythonCode`.
- Rename the name normalisation used by the linter and astRecovery to `normalizeName` (neutral).
- Done when: the full test suite and golden fixtures pass unchanged, and `tests/prompts.test.ts` hashes are unchanged.

**Phase 1: semantic analysis**
- `src/semantics/` as in 3.2, with unit tests per rule and a fast-check property: every program from the existing codegen fuzz generator analyses without throwing.
- Expose the result in diagnostics only behind `includeDiagnostics` (no output change).

**Phase 2: whole-program codegen**
- `BlockOutcome` keeps statements; `assemble` drives `target.generate` (3.3). The Python target gives identical output (golden check).

**Phase 3: C target, core**
- Scalars, arithmetic, print, input, if/while/for/repeat/break, functions with prototypes, hoisted declarations, `main`, `checkSupport` → TARGET_UNSUPPORTED.
- `--target c` in CLI, library and server.

**Phase 4: C target, strings and lists**
- Runtime prelude with tree-shaking; string ops, f-strings, lists, `len/sum/max/min/in`, string methods.

**Phase 5: direct mode for C**
- `prompts/direct.c.v1.ts` (new id and hash fixture), C post-processing (fence stripping, comment stripping with a small C scanner), `tree-sitter-c` WASM syntax check (same lazy-load pattern as `pythonSyntax.ts`), and the single-block restriction.

**Phase 6: docs, packaging, CI**
- README target matrix, `nlpc` bin, Dockerfile (add only the `tree-sitter-c` wasm, no compiler at runtime). CI installs `gcc` (already on ubuntu-latest) for the tests below.

## 6. Testing strategy

- **Golden fixtures, multi-target:** the existing `tests/fixtures/golden/*.json` already store the raw AST. Add an `expected` map `{ python: "...", c: "..." }` so one fixture covers every target.
- **Compile check:** every C output in unit, golden and fuzz tests must pass `cc -std=c11 -Wall -Wextra -Werror -pedantic -fsyntax-only` (helper `tests/helpers/c.ts`, mirroring `helpers/python.ts`: skipped locally without `cc`, a hard failure in CI).
- **Differential execution (the main correctness test):** for each sample AST and each fuzz-generated *well-typed* AST, run the Python output and the compiled C output with the same stdin and compare stdout. Because both come from one AST, any difference is a codegen bug in one target. This also pins down float formatting (Q1) and division (Q2).
- **Fuzz:** extend `codegen.fuzz.test.ts` with a typed generator (from the semantic types) so the C fuzzing exercises well-typed programs. Ill-typed programs must produce TARGET_UNSUPPORTED or TYPE_CONFLICT, never invalid C.
- **Integration (LLM):** run the existing `tests/integration/cases.ts` with `target: "c"`. The AST call is identical, so only codegen is new.

## 7. Adding the next target later (checklist)

1. `src/targets/<lang>/`: identifiers, codegen, `checkSupport`, syntax check (tree-sitter grammar WASM), direct prompt and post-processing.
2. Register it in `registry.ts` and add its `TargetId`.
3. Add golden `expected.<lang>`, a run helper, and the differential test entry.
4. Typed targets (Java, C#, TS, Go) reuse `semantics/`. Dynamic ones (JS, Ruby) can ignore it, as Python does.

Expected effort per target once Phases 0–2 exist: roughly C Phase 3 + 4 size for typed
languages with a weak standard library, much less for JS, Java or C#, whose standard
libraries cover strings and lists directly.

## 8. Decisions

Q1–Q4 were settled with the recommended option. There is no C course reference yet (Q5).

- **Q1 Output:** idiomatic C. Whole numbers and text print with `%d` and `%s`, decimals with `%g` (so `10.0` prints as `10`). The differential tests normalise floats.
- **Q2 Division:** keep true division. `/` on two ints becomes `(double)a / b`, with an `INT_DIVISION` info diagnostic.
- **Q3 Unsupported constructs:** reuse `unsupportedBehavior` (`comment` | `fallback`). There is no new mode.
- **Q4 Bool printing:** `1`/`0`.
- **Q5 Course scope:** no C reference yet. C v1 covers what the AST covers, minus exceptions and tuples. When a C course reference exists, revisit `checkSupport` and consider a C-specific AST prompt.

## 9. What was built, and where it differs from the plan

- **Target seam** (`src/targets/{types,registry}.ts`, `python/`, `c/`). `src/codegen.ts` and `src/pythonSyntax.ts` were *not* moved. The Python target wraps them, which kept the diff and the import paths stable. Tree-sitter loading is shared in `src/treeSitterSyntax.ts`.
- **No separate `checkSupport` pass.** The C generator throws an internal `Unsupported` error per statement and turns it into a comment plus `TARGET_UNSUPPORTED`. Helper and include state is rolled back for that statement, so no unused helpers are emitted. `GenerateResult.unsupportedNodes` feeds `unknownNodes`.
- **Phase 2 (whole-program assembly) was replaced by a restriction.** The default already combines all blocks into one, so C is a single program. `separateBlocks` with C is rejected (library `RangeError`, HTTP 400) instead of linking per-block fragments. If per-block C is ever needed, `assemble()` is the place to add it.
- **Declarations:** the default is inline (`int total = 0;`) when the first use in the innermost enclosing block is a plain assignment. Loop-only variables use `for (int i …)`. Everything else is hoisted to the top of the function. A variable is never declared inside a loop body unless its first use there is its assignment, so values carried across iterations stay correct (`src/semantics/declarations.ts`).
- **File-scope names** (globals, functions) also avoid C library builtins such as `log` and `round`. A function whose name is also a variable is reported as unsupported.
- **Tests:** `tests/differential.test.ts` (Python vs compiled C output on the same AST), the C property test in `tests/codegen.fuzz.test.ts` (random, mostly ill-typed ASTs: the generator never throws and always emits compiling C), `tests/cCodegen.test.ts`, `tests/semantics.test.ts`, `tests/targets.test.ts`, and a live case in `tests/integration/translate.test.ts`.
- **Not verified locally:** gcc. Tests ran with Apple clang 21. CI (ubuntu, gcc) is the first gcc run.
