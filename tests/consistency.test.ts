import { describe, expect, it } from "vitest";
import type { Stmt } from "../src/ast.js";
import {
  canonicalProgram,
  disagreeingLines,
  lineForms,
  selectConsensus,
  type SampleSummary,
} from "../src/consistency.js";

const num = (value: number, extra: object = {}) => ({ kind: "num", value, ...extra });
const assign = (target: string, value: number, line: number, extra: object = {}) =>
  ({ kind: "assign", target, value: num(value), line, source: "x", ...extra }) as unknown as Stmt;
const sample = (index: number, statements: Stmt[], g = 0, u = 0): SampleSummary => ({
  index, statements, groundingWarnings: g, unknownNodes: u,
});

describe("canonical form", () => {
  it("ignores evidence, outputCue, source, raw and note; keeps line", () => {
    const a = assign("a", 1, 1, { evidence: "Let a be 1", source: "Let a be 1." });
    const b = { ...assign("a", 1, 1, { evidence: "a be 1" }), value: num(1, { raw: "1" }) } as unknown as Stmt;
    expect(canonicalProgram([a])).toBe(canonicalProgram([b]));
    expect(canonicalProgram([assign("a", 1, 2)])).not.toBe(canonicalProgram([a]));
  });

  it("does not depend on key order", () => {
    const x = { kind: "break", line: 1 } as unknown as Stmt;
    const y = { line: 1, kind: "break" } as unknown as Stmt;
    expect(canonicalProgram([x])).toBe(canonicalProgram([y]));
  });

  it("distinguishes different values and operators", () => {
    expect(canonicalProgram([assign("a", 1, 1)])).not.toBe(canonicalProgram([assign("a", 2, 1)]));
  });
});

describe("selectConsensus", () => {
  const A = [assign("a", 1, 1)];
  const B = [assign("a", 2, 1)];

  it("picks the most frequent program", () => {
    const r = selectConsensus([sample(0, B), sample(1, A), sample(2, A)]);
    expect(r.chosen.index).toBe(1);
    expect(r.agreeing).toBe(2);
  });

  it("breaks ties by fewest grounding warnings", () => {
    const r = selectConsensus([sample(0, A, 3), sample(1, B, 1)]);
    expect(r.chosen.index).toBe(1);
  });

  it("then by fewest unknown nodes", () => {
    const r = selectConsensus([sample(0, A, 1, 2), sample(1, B, 1, 0)]);
    expect(r.chosen.index).toBe(1);
  });

  it("then by lowest sample index", () => {
    const r = selectConsensus([sample(0, A), sample(1, B)]);
    expect(r.chosen.index).toBe(0);
  });

  it("within the winning group prefers the sample with fewer warnings", () => {
    const r = selectConsensus([sample(0, A, 2), sample(1, A, 0), sample(2, B)]);
    expect(r.chosen.index).toBe(1);
    expect(r.agreeing).toBe(2);
  });

  it("a single sample agrees with itself", () => {
    expect(selectConsensus([sample(0, A)])).toMatchObject({ agreeing: 1 });
  });
});

describe("per-line comparison", () => {
  const loop = (bodyLine: number, value: number) =>
    ({
      kind: "while", line: 1, test: { kind: "bool", value: true },
      body: [assign("a", value, bodyLine)],
    }) as unknown as Stmt;

  it("builds forms per line with nesting paths", () => {
    const forms = lineForms([loop(2, 1)]);
    expect([...forms.keys()]).toEqual([1, 2]);
    expect(forms.get(2)).toContain("while@1|");
  });

  it("a nested difference flags the nested line, not the parent", () => {
    const d = disagreeingLines([sample(0, [loop(2, 1)]), sample(1, [loop(2, 5)])]);
    expect(d).toEqual([{ line: 2, variants: 2 }]);
  });

  it("the same step at a different nesting path is a disagreement", () => {
    const flat = [assign("a", 1, 2)];
    const nested = [loop(2, 1)];
    const d = disagreeingLines([sample(0, flat), sample(1, nested)]);
    expect(d.map((x) => x.line)).toContain(2);
  });

  it("a line one sample omits counts as its own variant", () => {
    const d = disagreeingLines([
      sample(0, [assign("a", 1, 1), assign("b", 2, 2)]),
      sample(1, [assign("a", 1, 1)]),
      sample(2, [assign("a", 1, 1), assign("b", 3, 2)]),
    ]);
    expect(d).toEqual([{ line: 2, variants: 3 }]);
  });

  it("reports nothing when samples agree or there is only one", () => {
    expect(disagreeingLines([sample(0, [assign("a", 1, 1)]), sample(1, [assign("a", 1, 1, { evidence: "z" })])])).toEqual([]);
    expect(disagreeingLines([sample(0, [assign("a", 1, 1)])])).toEqual([]);
  });
});
