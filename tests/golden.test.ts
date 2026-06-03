import { describe, expect, it } from "vitest";
import { verifyProgram } from "../src/ast.js";
import { generatePython } from "../src/codegen.js";
import { loadGolden } from "./fixtures/loadGolden.js";

const goldenNames = ["combined-course-features", "lists-loops"] as const;

describe.each(goldenNames)("golden fixture %s", (name) => {
  const fixture = loadGolden(name);

  it("verifies and codegen matches expected patterns", () => {
    const { statements, diagnostics } = verifyProgram(fixture.raw, fixture.source);
    expect(diagnostics).toEqual([]);
    expect(statements.length).toBe(fixture.raw.statements.length);

    const code = generatePython(statements);
    for (const pattern of fixture.pythonPatterns) {
      expect(code).toMatch(new RegExp(pattern, "m"));
    }
    for (const anti of fixture.pythonAntipatterns ?? []) {
      expect(code).not.toMatch(new RegExp(anti));
    }
  });
});
