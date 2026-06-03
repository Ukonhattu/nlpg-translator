import { describe, expect, it } from "vitest";
import { translateProgram } from "../../src/index.js";
import { integrationCases } from "./cases.js";
import {
  expectCleanPython,
  expectPatterns,
  hasApiKey,
  integrationOptions,
} from "./helpers.js";

const describeIntegration = hasApiKey ? describe.sequential : describe.skip;

describeIntegration("translateProgram edge cases (live API)", () => {
  it.each(integrationCases)("$name", async (testCase) => {
    if (testCase.name === "lint blocks invalid condition before API") {
      const result = await translateProgram(
        [{ id: "lint", text: testCase.text }],
        integrationOptions(testCase.options)
      );
      expect(result.pythonCode).toBe("");
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors.some((e) => e.code === "AMBIGUOUS_LANGUAGE")).toBe(
        true
      );
      return;
    }

    const result = await translateProgram(
      [{ id: testCase.name, text: testCase.text }],
      integrationOptions(testCase.options)
    );

    expect(result.errors).toEqual([]);
    expectCleanPython(result.pythonCode);
    expectPatterns(
      result.pythonCode,
      testCase.patterns,
      testCase.antipatterns ?? []
    );
  });
});
