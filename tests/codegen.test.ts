import { describe, expect, it } from "vitest";
import type { Stmt } from "../src/ast.js";
import { generatePython } from "../src/codegen.js";

function stmt(s: Omit<Stmt, "source"> & { source?: string }): Stmt {
  return { source: "", ...s } as Stmt;
}

describe("generatePython", () => {
  it("emits assign, augassign, and print", () => {
    const code = generatePython([
      stmt({
        kind: "assign",
        target: "score",
        value: { kind: "num", value: 0 },
      }),
      stmt({
        kind: "augassign",
        target: "score",
        op: "+",
        value: { kind: "num", value: 10 },
      }),
      stmt({
        kind: "print",
        value: { kind: "str", value: "done" },
      }),
    ]);

    expect(code).toBe(
      'score = 0\nscore = score + 10\nprint("done")'
    );
  });

  it("emits if/elif/else", () => {
    const code = generatePython([
      stmt({
        kind: "if",
        test: {
          kind: "compare",
          op: ">",
          left: { kind: "var", name: "score" },
          right: { kind: "num", value: 20 },
        },
        body: [
          stmt({
            kind: "print",
            value: { kind: "str", value: "High" },
          }),
        ],
        elifs: [
          {
            test: {
              kind: "compare",
              op: ">",
              left: { kind: "var", name: "score" },
              right: { kind: "num", value: 10 },
            },
            body: [
              stmt({
                kind: "print",
                value: { kind: "str", value: "Mid" },
              }),
            ],
          },
        ],
        orelse: [
          stmt({
            kind: "print",
            value: { kind: "str", value: "Low" },
          }),
        ],
      }),
    ]);

    expect(code).toContain("if score > 20:");
    expect(code).toContain("elif score > 10:");
    expect(code).toContain("else:");
  });

  it("emits subscript assign and f-strings", () => {
    const code = generatePython([
      stmt({
        kind: "assign",
        targetExpr: {
          kind: "index",
          target: { kind: "var", name: "items" },
          index: { kind: "num", value: 0 },
        },
        value: { kind: "num", value: 1 },
      }),
      stmt({
        kind: "print",
        value: {
          kind: "fstring",
          parts: [
            { kind: "lit", value: "x=" },
            { kind: "expr", value: { kind: "var", name: "x" } },
          ],
        },
      }),
    ]);

    expect(code).toContain("items[0] = 1");
    expect(code).toContain('print(f"x={x}")');
  });

  it("emits empty block bodies as pass", () => {
    const code = generatePython([
      stmt({
        kind: "while",
        test: { kind: "bool", value: false },
        body: [],
      }),
    ]);

    expect(code).toBe("while False:\n    pass");
  });
});
