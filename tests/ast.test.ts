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

  it("rejects assign with both target and targetExpr", () => {
    const { statements } = verifyProgram(
      {
        statements: [
          {
            kind: "assign",
            target: "x",
            targetExpr: { kind: "var", name: "y" },
            value: { kind: "num", value: 1 },
            line: 1,
          },
        ],
      },
      source,
      { collectDiagnostics: true }
    );
    expect(statements).toHaveLength(0);
  });

  it("rejects boolop with a single value", () => {
    const { statements } = verifyProgram(
      {
        statements: [
          {
            kind: "print",
            value: {
              kind: "boolop",
              op: "and",
              values: [{ kind: "bool", value: true }],
            },
            line: 2,
          },
        ],
      },
      source
    );
    expect(statements).toHaveLength(0);
  });

  it("rejects empty f-string parts", () => {
    const { statements } = verifyProgram(
      {
        statements: [
          {
            kind: "print",
            value: { kind: "fstring", parts: [] },
            line: 2,
          },
        ],
      },
      source
    );
    expect(statements).toHaveLength(0);
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

  it("verifies nested try handler bodies", () => {
    const text = "Try something.\nOn error, print msg.";
    const { statements, diagnostics } = verifyProgram(
      {
        statements: [
          {
            kind: "try",
            body: [],
            handlers: [
              {
                exc: "ValueError",
                body: [
                  {
                    kind: "print",
                    value: { kind: "str", value: "msg" },
                    line: 2,
                  },
                ],
              },
            ],
            line: 1,
          },
        ],
      },
      text
    );
    expect(diagnostics).toEqual([]);
    expect(statements).toHaveLength(1);
    const tryStmt = statements[0];
    expect(tryStmt.kind).toBe("try");
    if (tryStmt.kind === "try") {
      expect(tryStmt.handlers[0].body[0].source).toBe("On error, print msg.");
    }
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

  it("accepts pass placeholder on a pass source line", () => {
    const source = "If x is greater than 0:\n  pass\nElse:\n  Set y to 1.";
    const { statements, diagnostics } = verifyProgram(
      {
        statements: [
          {
            kind: "if",
            test: {
              kind: "compare",
              op: ">",
              left: { kind: "var", name: "x" },
              right: { kind: "num", value: 0 },
            },
            body: [{ kind: "pass", line: 2 }],
            orelse: [
              {
                kind: "assign",
                target: "y",
                value: { kind: "num", value: 1 },
                line: 4,
              },
            ],
            line: 1,
          },
        ],
      },
      source
    );

    expect(diagnostics).toEqual([]);
    expect(statements).toHaveLength(1);
    const ifStmt = statements[0];
    expect(ifStmt.kind).toBe("if");
    if (ifStmt.kind === "if") {
      expect(ifStmt.body).toHaveLength(1);
      expect(ifStmt.body[0].kind).toBe("pass");
      expect(ifStmt.body[0].source.trim()).toBe("pass");
    }
  });

  it("drops pass when source line is not pass", () => {
    const { statements, diagnostics } = verifyProgram(
      {
        statements: [{ kind: "pass", line: 1 }],
      },
      "Let x be 1.",
      { collectDiagnostics: true }
    );

    expect(statements).toHaveLength(0);
    expect(diagnostics.some((d) => d.includes("pass placeholder"))).toBe(true);
  });

  it("finds unknown inside functiondef and try handler bodies", () => {
    const stmts: Stmt[] = [
      {
        kind: "functiondef",
        name: "f",
        params: [],
        body: [{ kind: "unknown", source: "magic", note: "" }],
        source: "",
      },
      {
        kind: "try",
        body: [],
        handlers: [
          {
            body: [{ kind: "unknown", source: "other", note: "" }],
          },
        ],
        source: "",
      },
    ];
    expect(statementsContainUnknown(stmts)).toBe(true);
  });
});
