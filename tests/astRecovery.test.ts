import { describe, expect, it } from "vitest";
import { statementsContainUnknown, verifyProgram } from "../src/ast.js";
import { generatePython } from "../src/codegen.js";
import {
  promoteOrphanPassIntoLoopBodies,
  tryRecoverUnknownFromSource,
} from "../src/astRecovery.js";

describe("tryRecoverUnknownFromSource", () => {
  it("recovers Finnish for-in headers", () => {
    const stmt = tryRecoverUnknownFromSource(
      "Jokaiselle number-arvolle listassa numbers."
    );
    expect(stmt).toMatchObject({
      kind: "forin",
      loopVar: "number",
      iterable: { kind: "var", name: "numbers" },
    });
  });

  it("recovers English for-in headers", () => {
    const stmt = tryRecoverUnknownFromSource("For each number in the numbers:");
    expect(stmt).toMatchObject({
      kind: "forin",
      loopVar: "number",
    });
  });
});

describe("promoteOrphanPassIntoLoopBodies", () => {
  it("nests a following pass into an empty loop body", () => {
    const promoted = promoteOrphanPassIntoLoopBodies([
      {
        kind: "forin",
        loopVar: "number",
        iterable: { kind: "var", name: "numbers" },
        body: [],
        source: "For each number in the numbers:",
      },
      { kind: "pass", source: "pass" },
    ]);

    expect(promoted).toHaveLength(1);
    expect(promoted[0].kind).toBe("forin");
    if (promoted[0].kind === "forin") {
      expect(promoted[0].body).toHaveLength(1);
      expect(promoted[0].body[0].kind).toBe("pass");
    }
  });
});

describe("verifyProgram out-of-order list usage", () => {
  it("recovers for-in before list assignment and preserves user order", () => {
    const source = [
      "For each number in the numbers:",
      "  pass",
      "Let the numbers be a list with 1, 2, 3.",
    ].join("\n");

    const { statements, diagnostics } = verifyProgram(
      {
        statements: [
          { kind: "unknown", line: 1 },
          { kind: "pass", line: 2 },
          {
            kind: "assign",
            target: "numbers",
            value: {
              kind: "list",
              items: [
                { kind: "num", value: 1 },
                { kind: "num", value: 2 },
                { kind: "num", value: 3 },
              ],
            },
            line: 3,
          },
        ],
      },
      source
    );

    expect(diagnostics).toEqual([]);
    expect(statementsContainUnknown(statements)).toBe(false);

    const code = generatePython(statements);
    expect(code).toBe(
      "for number in numbers:\n    pass\nnumbers = [1, 2, 3]"
    );
  });
});
