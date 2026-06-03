import { describe, expect, it } from "vitest";
import {
  statementsContainUnknown,
  verifyProgram,
  type Stmt,
} from "../src/ast.js";

describe("verifyProgram", () => {
  const source = "Let the score be 0.\nPrint the score.";

  it("accepts valid nodes and attaches source text", () => {
    const { statements, diagnostics } = verifyProgram(
      {
        statements: [
          {
            kind: "assign",
            target: "score",
            value: { kind: "num", value: 0 },
            line: 1,
          },
          {
            kind: "print",
            value: { kind: "var", name: "score" },
            line: 2,
          },
        ],
      },
      source
    );

    expect(diagnostics).toEqual([]);
    expect(statements).toHaveLength(2);
    expect(statements[0].source).toBe("Let the score be 0.");
    expect(statements[1].source).toBe("Print the score.");
  });

  it("drops malformed nodes", () => {
    const { statements, diagnostics } = verifyProgram(
      {
        statements: [{ kind: "assign", value: { kind: "num", value: 1 }, line: 1 }],
      },
      source,
      { collectDiagnostics: true }
    );

    expect(statements).toHaveLength(0);
    expect(diagnostics.some((d) => d.includes("Skipped invalid"))).toBe(true);
  });

  it("keeps print without output verb by default but records diagnostic", () => {
    const text = "Let the score be 0.\nUpdate the total.";
    const { statements, diagnostics } = verifyProgram(
      {
        statements: [
          {
            kind: "assign",
            target: "score",
            value: { kind: "num", value: 0 },
            line: 1,
          },
          {
            kind: "print",
            value: { kind: "var", name: "score" },
            line: 2,
          },
        ],
      },
      text,
      { collectDiagnostics: true }
    );

    expect(statements.filter((s) => s.kind === "print")).toHaveLength(1);
    expect(diagnostics.some((d) => d.includes("print may not match"))).toBe(
      true
    );
  });

  it("drops ungrounded print when strictOutputFidelity is set", () => {
    const text = "Let the score be 0.\nMention the score.";
    const { statements, diagnostics } = verifyProgram(
      {
        statements: [
          {
            kind: "assign",
            target: "score",
            value: { kind: "num", value: 0 },
            line: 1,
          },
          {
            kind: "print",
            value: { kind: "var", name: "score" },
            line: 2,
          },
        ],
      },
      text,
      { strictOutputFidelity: true, collectDiagnostics: true }
    );

    expect(statements.some((s) => s.kind === "print")).toBe(false);
    expect(diagnostics.some((d) => d.includes("omitted print"))).toBe(true);
  });
});

describe("statementsContainUnknown", () => {
  it("finds unknown inside elif bodies", () => {
    const stmts: Stmt[] = [
      {
        kind: "if",
        test: { kind: "bool", value: true },
        body: [],
        elifs: [
          {
            test: { kind: "bool", value: false },
            body: [{ kind: "unknown", source: "do magic", note: "x" }],
          },
        ],
        orelse: [],
        source: "if",
      },
    ];

    expect(statementsContainUnknown(stmts)).toBe(true);
  });
});
