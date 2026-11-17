import { describe, expect, it } from "vitest";
import { verifyProgram } from "../src/ast.js";
import { generatePython } from "../src/codegen.js";
import { checkGrounding, type GroundingMode } from "../src/grounding.js";

const num = (value: number, raw?: string) => ({ kind: "num", value, ...(raw ? { raw } : {}) });
const str = (value: string) => ({ kind: "str", value });
const v = (name: string) => ({ kind: "var", name });

function run(raw: object[], source: string, mode: Exclude<GroundingMode, "off"> = "warn", max?: number) {
  const verified = verifyProgram({ statements: raw }, source);
  const g = checkGrounding(verified.statements, source, { mode, maxStatementsPerLine: max });
  return { ...g, code: generatePython(g.statements), codes: g.diagnostics.map((d) => d.code) };
}

const SRC = "Let the score be 10.\nPrint the score.";
const good = [
  { kind: "assign", target: "score", value: num(10), line: 1, evidence: "Let the score be 10" },
  { kind: "print", value: v("score"), line: 2, evidence: "Print the score", outputCue: "Print" },
];

describe("grounding: clean input", () => {
  it("produces no diagnostics for a faithful v2 AST", () => {
    expect(run(good, SRC).diagnostics).toEqual([]);
  });
});

describe("hallucinated bonus = 99 (§1.3)", () => {
  const hallucinated = [
    ...good,
    { kind: "assign", target: "bonus", value: num(99), line: 2, evidence: "Print the score" },
  ];

  it("warn mode flags LITERAL and IDENTIFIER but keeps the step", () => {
    const r = run(hallucinated, SRC);
    expect(r.codes).toContain("GROUNDING_LITERAL");
    expect(r.codes).toContain("GROUNDING_IDENTIFIER");
    expect(r.code).toContain("bonus = 99");
  });

  it("fabricated evidence is flagged too", () => {
    const r = run(
      [...good, { kind: "assign", target: "bonus", value: num(99), line: 2, evidence: "bonus = 99" }],
      SRC
    );
    expect(r.codes).toContain("GROUNDING_EVIDENCE");
  });

  it("strict mode replaces it with an unsupported comment", () => {
    const r = run(hallucinated, SRC, "strict");
    expect(r.code).not.toContain("bonus");
    expect(r.code).toContain("# unsupported: Print the score");
    expect(r.statements.at(-1)).toMatchObject({ kind: "unknown", note: "GROUNDING_LITERAL" });
  });
});

describe("GROUNDING_OUTPUT_CUE (§5 verb table)", () => {
  const print = (line: string, cue: string) =>
    run([{ kind: "print", value: v("sum"), line: 1, evidence: line, outputCue: cue }], line);

  it("accepts cues in English and Finnish, including inflections", () => {
    expect(print("The program prints the sum", "prints").codes).not.toContain("GROUNDING_OUTPUT_CUE");
    expect(print("Ohjelma tulostaa summan", "tulostaa").codes).not.toContain("GROUNDING_OUTPUT_CUE");
    expect(print("Summa näytetään ruudulla", "näytetään").codes).not.toContain("GROUNDING_OUTPUT_CUE");
  });

  it("rejects a cue that is missing from the line or a stop-word", () => {
    expect(print("Let the sum be 5", "print").codes).toContain("GROUNDING_OUTPUT_CUE");
    expect(print("The sum is shown", "the").codes).toContain("GROUNDING_OUTPUT_CUE");
    expect(print("The sum is shown", "and").codes).toContain("GROUNDING_OUTPUT_CUE");
  });

  it("strict mode drops an ungrounded print", () => {
    const r = run(
      [{ kind: "print", value: str("hi"), line: 1, evidence: "Say hi", outputCue: "print" }],
      "Say hi",
      "strict"
    );
    expect(r.code).toBe("# unsupported: Say hi");
  });
});

describe("GROUNDING_LITERAL", () => {
  it("accepts digits, raw text, number words and implied constants", () => {
    const cases: Array<[string, object]> = [
      ["Let a be twenty", num(20)],
      ["Aseta a arvoon kaksikymmentäviisi", num(25)],
      ["Let a be 2,5", num(2.5)],
      ["Let a be 10.0", num(10, "10.0")],
      ["Increase a by one", num(1)],
      ["Add one to a", num(1)],
      ["Let a be the first item", num(0)],
      ["Let a be the last item", num(-1)],
      ["Let a be negative 5", num(-5)],
    ];
    for (const [line, value] of cases) {
      const r = run([{ kind: "assign", target: "a", value, line: 1, evidence: line }], line);
      expect(r.codes, line).not.toContain("GROUNDING_LITERAL");
    }
  });

  it("flags numbers and strings not on the line", () => {
    const r1 = run([{ kind: "assign", target: "a", value: num(7), line: 1, evidence: "Let a be 5" }], "Let a be 5");
    expect(r1.codes).toContain("GROUNDING_LITERAL");
    const r2 = run(
      [{ kind: "print", value: str("Hello"), line: 1, evidence: 'Print "Bye"', outputCue: "Print" }],
      'Print "Bye"'
    );
    expect(r2.codes).toContain("GROUNDING_LITERAL");
  });

  it("checks f-string literal parts, case-insensitively", () => {
    const fs = (lit: string) => ({
      kind: "print", line: 1, evidence: 'Print "Total: " and the total', outputCue: "Print",
      value: { kind: "fstring", parts: [{ kind: "lit", value: lit }, { kind: "expr", value: v("total") }] },
    });
    const src = 'Print "Total: " and the total';
    expect(run([fs("total: ")], src).codes).not.toContain("GROUNDING_LITERAL");
    expect(run([fs("Sum is ")], src).codes).toContain("GROUNDING_LITERAL");
  });
});

describe("GROUNDING_IDENTIFIER", () => {
  it("accepts names built from words anywhere in the block (back-references)", () => {
    const src = "Let the total score be 5.\nPrint it.";
    const r = run(
      [
        { kind: "assign", target: "total_score", value: num(5), line: 1, evidence: "Let the total score be 5" },
        { kind: "print", value: v("totalScore"), line: 2, evidence: "Print it", outputCue: "Print" },
      ],
      src
    );
    expect(r.codes).not.toContain("GROUNDING_IDENTIFIER");
  });

  it("does not require builtins like len to be in the text", () => {
    const src = "Print the length of the items.";
    const r = run(
      [{ kind: "print", value: { kind: "call", func: "len", args: [v("items")] }, line: 1, evidence: "Print the length of the items", outputCue: "Print" }],
      src
    );
    expect(r.codes).not.toContain("GROUNDING_IDENTIFIER");
  });
});

describe("line coverage (§5.2 checks 5 and 6)", () => {
  it("GROUNDING_LINE_UNCITED flags lines no step cites, but not folded block openers", () => {
    const src = "Let a be 1.\nDo something odd.\nIf a is 1:\n  Print a.\nElse:\n  Print b.";
    const r = run(
      [
        { kind: "assign", target: "a", value: num(1), line: 1, evidence: "Let a be 1" },
        {
          kind: "if", line: 3, evidence: "If a is 1",
          test: { kind: "compare", op: "==", left: v("a"), right: num(1) },
          body: [{ kind: "print", value: v("a"), line: 4, evidence: "Print a", outputCue: "Print" }],
          orelse: [{ kind: "print", value: v("b"), line: 6, evidence: "Print b", outputCue: "Print" }],
        },
      ],
      src
    );
    const uncited = r.diagnostics.filter((d) => d.code === "GROUNDING_LINE_UNCITED");
    expect(uncited.map((d) => d.line)).toEqual([2]);
  });

  it("GROUNDING_LINE_MULTI flags a line cited by more than maxStatementsPerLine", () => {
    const src = "Let a be 1 and b be 2 and c be 3.";
    const mk = (t: string, n: number) => ({ kind: "assign", target: t, value: num(n), line: 1, evidence: `${t} be ${n}` });
    const raw = [mk("a", 1), mk("b", 2), mk("c", 3)];
    expect(run(raw, src).codes).toContain("GROUNDING_LINE_MULTI");
    expect(run(raw, src, "warn", 3).codes).not.toContain("GROUNDING_LINE_MULTI");
  });
});

describe("GROUNDING_NESTING", () => {
  it("flags a child whose line is before the parent or after the next sibling", () => {
    const src = "Print a.\nWhile a is 1:\n  Print b.\nPrint c.";
    const pr = (name: string, line: number, text: string) => ({ kind: "print", value: v(name), line, evidence: text, outputCue: "Print" });
    const loop = (body: object[]) => ({
      kind: "while", line: 2, evidence: "While a is 1", test: { kind: "bool", value: true }, body,
    });
    const before = run([loop([pr("a", 1, "Print a")]), pr("c", 4, "Print c")], src);
    expect(before.codes).toContain("GROUNDING_NESTING");
    const after = run([loop([pr("c", 4, "Print c")]), pr("b", 3, "Print b")], src);
    expect(after.codes).toContain("GROUNDING_NESTING");
    const fine = run([loop([pr("b", 3, "Print b")]), pr("c", 4, "Print c")], src);
    expect(fine.codes).not.toContain("GROUNDING_NESTING");
  });
});

describe("v1 compatibility (§5.4)", () => {
  it("skips evidence checks and adds one info diagnostic", () => {
    const r = run(
      [
        { kind: "assign", target: "score", value: num(10), line: 1 },
        { kind: "print", value: v("score"), line: 2 },
      ],
      SRC
    );
    expect(r.diagnostics).toHaveLength(1);
    expect(r.diagnostics[0]).toMatchObject({ code: "GROUNDING_V1_INPUT", severity: "info" });
  });

  it("still checks literals and identifiers on v1 steps", () => {
    const r = run([{ kind: "assign", target: "bonus", value: num(99), line: 1 }], "Let the score be 10.");
    expect(r.codes).toEqual(expect.arrayContaining(["GROUNDING_V1_INPUT", "GROUNDING_LITERAL", "GROUNDING_IDENTIFIER"]));
  });

  it("strict mode leaves a v1 step with grounded literals alone", () => {
    const r = run([{ kind: "assign", target: "score", value: num(10), line: 1 }], "Let the score be 10.", "strict");
    expect(r.code).toBe("score = 10");
  });
});

describe("strict mode and compound statements", () => {
  it("replacing a compound statement drops its nested steps, children diagnostics remain", () => {
    const src = "While the count is 99:\n  Print it.";
    const r = run(
      [
        {
          kind: "while", line: 1, evidence: "While the count is 99",
          test: { kind: "compare", op: "<", left: v("count"), right: num(5) },
          body: [{ kind: "print", value: v("count"), line: 2, evidence: "Print it", outputCue: "Print" }],
        },
      ],
      src,
      "strict"
    );
    expect(r.code).toBe("# unsupported: While the count is 99:");
  });
});
