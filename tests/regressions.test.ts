/**
 * Regression tests for confirmed bugs from CODE_REVIEW.md (see FIX_PLAN.md, Phase 0.3).
 *
 * Each test is written to assert the CORRECT behaviour and is marked `it.fails`
 * while the bug is still present. When a fix lands, change its `bug(...)` to
 * `fixed(...)`; vitest reports a passing `it.fails` as an error, which is the
 * reminder to do so.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { verifyProgram } from "../src/ast.js";
import { generatePython } from "../src/codegen.js";
import { translateBlocksViaAst } from "../src/translator.js";
import { assertParses, hasPython, runPython } from "./helpers/python.js";

/** A test for a bug that is not fixed yet (expected to fail). Skipped without python3. */
const bug = hasPython ? it.fails : it.skip;
/** A bug that no longer reproduces; flip `bug` to this when the fix lands. */
export const fixed = it;

function compile(raw: unknown, source: string) {
  const { statements, diagnostics } = verifyProgram(raw, source, {
    collectDiagnostics: true,
  });
  return { code: generatePython(statements), diagnostics, statements };
}

const num = (value: number) => ({ kind: "num", value });
const str = (value: string) => ({ kind: "str", value });
const v = (name: string) => ({ kind: "var", name });

describe("regressions: codegen identifiers (§2.1, §2.2)", () => {
  bug("def/call name case is preserved consistently (§2.1)", () => {
    const { code } = compile(
      {
        statements: [
          {
            kind: "functiondef",
            name: "calculateArea",
            params: [],
            line: 1,
            body: [{ kind: "return", values: [num(7)], line: 2 }],
          },
          {
            kind: "assign",
            target: "x",
            value: { kind: "call", func: "calculateArea", args: [] },
            line: 3,
          },
          { kind: "print", value: v("x"), line: 4 },
        ],
      },
      "Define calculateArea\nReturn 7\nSet x to calculateArea\nPrint x"
    );
    const run = runPython(code);
    expect(run.stderr).not.toMatch(/NameError/);
    expect(run.stdout.trim()).toBe("7");
  });

  bug('assign target "class" yields parseable Python (§2.2)', () => {
    const { code } = compile(
      { statements: [{ kind: "assign", target: "class", value: num(1), line: 1 }] },
      "Set class to 1"
    );
    assertParses(code);
  });

  bug("määrä and mÄÄrÖ stay distinct identifiers (§2.2)", () => {
    const { code } = compile(
      {
        statements: [
          { kind: "assign", target: "määrä", value: num(1), line: 1 },
          { kind: "assign", target: "mÄÄrÖ", value: num(2), line: 2 },
          { kind: "print", value: v("määrä"), line: 3 },
          { kind: "print", value: v("mÄÄrÖ"), line: 4 },
        ],
      },
      "Aseta määrä 1\nAseta mÄÄrÖ 2\nTulosta määrä\nTulosta mÄÄrÖ"
    );
    expect(runPython(code).stdout).toBe("1\n2\n");
  });
});

describe("regressions: float literals (§2.3)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  bug("num 10.0 from raw JSON text prints as 10.0", async () => {
    const modelText =
      '{"statements":[{"kind":"print","value":{"kind":"num","value":10.0},"line":1}]}';
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          output: [
            { type: "message", content: [{ type: "output_text", text: modelText }] },
          ],
        }),
      })
    );
    const { pythonCode } = await translateBlocksViaAst(
      [{ id: "b1", text: "Print 10.0" }],
      { aaltoApiKey: "k", endpoint: "https://x.example/r", model: "m" }
    );
    expect(runPython(pythonCode).stdout.trim()).toBe("10.0");
  });
});

describe("regressions: f-strings on Python 3.10 (§2.4)", () => {
  bug("lit part containing a newline parses", () => {
    const { code } = compile(
      {
        statements: [
          {
            kind: "print",
            line: 1,
            value: {
              kind: "fstring",
              parts: [
                { kind: "lit", value: "a\nb " },
                { kind: "expr", value: v("x") },
              ],
            },
          },
        ],
      },
      "Print a, newline, b and x"
    );
    assertParses(code);
  });

  bug("expr part containing a str argument parses (no nested same quotes)", () => {
    const { code } = compile(
      {
        statements: [
          {
            kind: "print",
            line: 1,
            value: {
              kind: "fstring",
              parts: [
                {
                  kind: "expr",
                  value: {
                    kind: "methodcall",
                    target: str("a-b"),
                    method: "replace",
                    args: [str("-"), str("+")],
                  },
                },
              ],
            },
          },
        ],
      },
      "Print a-b with - replaced by +"
    );
    assertParses(code);
    // Python < 3.12 cannot reuse the enclosing quote inside an f-string
    // expression; check structurally so this also fails on newer local Pythons.
    expect(code).not.toMatch(/f"[^"\n]*\{[^}"]*"/);
  });
});

describe("regressions: malformed model output (§3.1, §3.2)", () => {
  bug("a null statement does not throw (§3.1)", () => {
    expect(() => verifyProgram({ statements: [null] }, "x")).not.toThrow();
  });

  bug("a null node inside a nested body does not throw (§3.1)", () => {
    const raw = {
      statements: [
        { kind: "while", test: { kind: "bool", value: true }, line: 1, body: [null] },
      ],
    };
    expect(() => verifyProgram(raw, "While true")).not.toThrow();
  });

  bug("statement missing `line` is reported even without collectDiagnostics (§3.2)", () => {
    const { diagnostics } = verifyProgram(
      { statements: [{ kind: "break" }] },
      "Break"
    );
    expect(diagnostics.length).toBeGreaterThan(0);
  });
});

describe("regressions: code injection through free-form fields (§1.4)", () => {
  const cases: Array<[string, unknown, string]> = [
    [
      "methodcall.method",
      {
        kind: "print",
        line: 1,
        value: {
          kind: "methodcall",
          target: str("a"),
          method: "upper(); __import__('os')",
          args: [],
        },
      },
      "Print a upper",
    ],
    [
      "try handler exc",
      {
        kind: "try",
        line: 1,
        body: [{ kind: "break", line: 2 }],
        handlers: [{ exc: "ValueError:\n    import os", body: [{ kind: "break", line: 3 }] }],
      },
      "Try\nBreak\nBreak",
    ],
    [
      "raise excType",
      { kind: "raise", line: 1, excType: "ValueError\nimport os\n", message: str("m") },
      "Raise error",
    ],
    [
      "functiondef docstring",
      {
        kind: "functiondef",
        line: 1,
        name: "f",
        params: [],
        docstring: 'x"""\nimport os\n"""',
        body: [{ kind: "pass", line: 2 }],
      },
      "Define f\npass",
    ],
  ];

  for (const [name, node, source] of cases) {
    bug(`${name}: output parses and contains no import`, () => {
      const { code } = compile({ statements: [node] }, source);
      assertParses(code);
      expect(code).not.toMatch(/import/);
    });
  }
});
