import type { TranslateOptions } from "../../src/index.js";

export type IntegrationCase = {
  name: string;
  text: string;
  options?: Partial<TranslateOptions>;
  patterns: RegExp[];
  antipatterns?: RegExp[];
};

/** Focused live-API scenarios (loose patterns — model + codegen may vary slightly). */
export const integrationCases: IntegrationCase[] = [
  {
    name: "lists, for-in, and append",
    text: [
      "Let the total be 0.",
      "Let the numbers be a list with 1, 2, and 3.",
      "For each number in the numbers:",
      "  Add the number to the total.",
      "Print the total.",
    ].join("\n"),
    options: { astMode: true },
    patterns: [/\[\s*1\s*,\s*2\s*,\s*3\s*\]/, /for \w+ in \w+:/, /total/, /print\s*\(/],
  },
  {
    name: "if / elif / else chain",
    text: [
      "Let the score be 15.",
      "If the score is greater than 20, print \"High\".",
      "Otherwise, if the score is greater than 10, print \"Mid\".",
      "Otherwise, print \"Low\".",
    ].join("\n"),
    options: { astMode: true },
    patterns: [/if score/, /elif/, /else:/, /print\s*\(/],
  },
  {
    name: "while loop with break",
    text: [
      "Let the count be 0.",
      "While the count is less than 10:",
      "  Add 1 to the count.",
      "  If the count is equal to 5, break.",
    ].join("\n"),
    options: { astMode: true },
    patterns: [/while count/, /break/],
  },
  {
    name: "numeric for with range step",
    text: [
      "For each i from 0 to 10 with step 2:",
      "  Print i.",
    ].join("\n"),
    options: { astMode: true },
    patterns: [/for \w+ in range\(\s*0\s*,\s*10\s*,\s*2\s*\)/, /print\s*\(/],
  },
  {
    name: "function definition and call",
    text: [
      "Define a function double that takes x.",
      "Return x times 2.",
      "Let the result be double applied to 5.",
      "Print the result.",
    ].join("\n"),
    options: { astMode: true },
    patterns: [/def double\s*\(/, /return/, /double\s*\(/, /print\s*\(/],
  },
  {
    name: "f-string output",
    text: [
      "Let the name be \"Ada\".",
      "Print a message with name in braces like an f-string.",
    ].join("\n"),
    options: { astMode: true },
    patterns: [/print\s*\(\s*f["']/],
  },
  {
    name: "membership (in)",
    text: [
      "Let the numbers be a list with 2, 4, 6.",
      "If 2 is in the numbers, print \"yes\".",
    ].join("\n"),
    options: { astMode: true },
    patterns: [/2 in numbers/, /print\s*\(/],
  },
  {
    name: "try / except",
    text: [
      "Let the total be 0.",
      "Try to divide 1 by the total.",
      "If a ZeroDivisionError happens, print \"error\".",
    ].join("\n"),
    options: { astMode: true },
    patterns: [/try:/, /except/, /print\s*\(/],
  },
  {
    name: "input with integer cast",
    text: [
      "Let the age be input as an integer with prompt \"Age:\".",
      "Print the age.",
    ].join("\n"),
    options: { astMode: true },
    patterns: [/int\s*\(\s*input/, /print\s*\(/],
  },
  {
    name: "unsupported construct becomes comment",
    text: "Import the os module.",
    options: { astMode: true, unsupportedBehavior: "comment" },
    patterns: [/# unsupported:/i],
    antipatterns: [/^import os/m],
  },
  {
    name: "complex multi-feature program (AST)",
    text: [
      "Let the total be 0.",
      "Let the numbers be a list with 1, 2, 3.",
      "For each number in the numbers:",
      "  Add the number to the total.",
      "Define a function increment that takes value.",
      "Return value plus 1.",
      "Let the total be increment applied to the total.",
      "If the total is greater than 5, print \"big\".",
      "Otherwise, print \"small\".",
    ].join("\n"),
    options: { astMode: true },
    patterns: [
      /for \w+ in/,
      /def increment/,
      /if total/,
      /else:/,
      /print\s*\(/,
    ],
  },
  {
    name: "lint blocks invalid condition before API",
    text: "If the score is big, print the score.",
    options: { astMode: true, enableLint: true },
    patterns: [],
  },
];
