import { describe, expect, it } from "vitest";
import { lintProgram } from "../src/linter.js";

describe("lintProgram", () => {
  it("reports undefined variables", () => {
    const errors = lintProgram([
      {
        id: "b1",
        text: "Print the score.",
      },
    ]);

    expect(errors.some((e) => e.code === "UNDEFINED_VARIABLE")).toBe(true);
  });

  it("accepts a minimal valid program", () => {
    const errors = lintProgram([
      {
        id: "b1",
        text: "Let the score be 0.\nPrint the score.",
      },
    ]);

    expect(errors).toEqual([]);
  });

  it("flags ambiguous language", () => {
    const errors = lintProgram([
      {
        id: "b1",
        text: "If the score is big, print the score.",
      },
    ]);

    expect(errors.some((e) => e.code === "AMBIGUOUS_LANGUAGE")).toBe(true);
  });
});
