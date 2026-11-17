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

const codes = (text: string) => lintProgram([{ id: "b", text }]).map((e) => e.code);

describe("lintProgram: false positives from the review (§6)", () => {
  it('"This is not ambiguous." is fine; whole-word matching only', () => {
    expect(codes("This is not ambiguous.")).toEqual([]);
    expect(codes("Let the x be 1.\nPrint the x. It is the biggest, smallest, from Germany.")).not.toContain("AMBIGUOUS_LANGUAGE");
  });

  it("still flags real ambiguous words, case-insensitively, next to punctuation", () => {
    for (const w of ["big", "Small", "HUGE", "many", "few"]) {
      expect(codes(`If the score is ${w}, stop.`), w).toContain("AMBIGUOUS_LANGUAGE");
    }
    expect(codes("If the score is big.")).toContain("AMBIGUOUS_LANGUAGE");
  });

  it("ignores ambiguous words inside quoted text", () => {
    expect(codes('Print "a big surprise".')).not.toContain("AMBIGUOUS_LANGUAGE");
  });

  it('"If the x is greater than the y" is a valid condition', () => {
    const errors = codes("Let the x be 1.\nLet the y be 2.\nIf the x is greater than the y, print the x.");
    expect(errors).toEqual([]);
  });

  it("accepts variable and decimal operands and or-equal forms, still rejects vague ones", () => {
    expect(codes("Let the x be 1.\nIf the x is at least y, print the x.")).not.toContain("INVALID_CONDITION");
    expect(codes("Let the x be 1.\nIf the x is less than 2.5, print the x.")).not.toContain("INVALID_CONDITION");
    expect(codes("Let the x be 1.\nIf the x is greater than or equal to 3, print the x.")).not.toContain("INVALID_CONDITION");
    expect(codes("Let the x be 1.\nIf the x looks fine, print the x.")).toContain("INVALID_CONDITION");
  });

  it('"Print the sum of x and y" produces no errors', () => {
    expect(codes("Let the x be 1.\nLet the y be 2.\nPrint the sum of x and y.")).toEqual([]);
    expect(codes("Print the difference of a and b.")).toEqual([]);
    expect(codes("Print the product of a and b.")).toEqual([]);
  });

  it("print is only checked at the start of a line or clause", () => {
    expect(codes("Let the score be 1.\nIf the score is at least 1, print the score.")).toEqual([]);
    expect(codes("Do not print twice here.")).toEqual([]);
    expect(codes("Print the score.")).toContain("UNDEFINED_VARIABLE");
    expect(codes("If the score is at least 1, print the score.")).toContain("UNDEFINED_VARIABLE");
  });

  it("checks each name in a print list, and skips string literals", () => {
    const errors = lintProgram([{ id: "b", text: 'Let the a be 1.\nPrint the a and the b.\nPrint "hello".' }]);
    expect(errors.map((e) => e.message)).toEqual([
      expect.stringContaining("'b'"),
    ]);
  });

  it('"Let a be 1" (no "the") defines a variable', () => {
    expect(codes("Let a be 1.\nPrint the a.")).toEqual([]);
    expect(codes("Set the total to 0.\nAdd 1 to the total.\nPrint the total.")).toEqual([]);
  });

  it("add/subtract are anchored", () => {
    expect(codes("Let the total be 0.\nAdd 5 to the total.")).toEqual([]);
    expect(codes("Add 5 to the total.")).toContain("UNDEFINED_VARIABLE");
    expect(codes("We will not add anything to the cause.")).toEqual([]);
  });

  it("loops: only lines starting with Repeat, colon optional, 'the following' accepted", () => {
    expect(codes("Repeat 3 times:")).toEqual([]);
    expect(codes("Repeat 3 times")).toEqual([]);
    expect(codes("Repeat the following 3 times")).toEqual([]);
    expect(codes("  repeat the following 10 times:")).toEqual([]);
    expect(codes("Repeat until done:")).toContain("INVALID_LOOP");
    expect(codes("Repeat forever")).toContain("INVALID_LOOP");
    expect(codes("Please do not repeat yourself.")).toEqual([]);
  });
});
