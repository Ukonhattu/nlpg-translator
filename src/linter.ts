/**
 * Rule-based linter for step-by-step instructions.
 *
 * ENGLISH ONLY (Finnish instructions are not linted; see FIX_PLAN D7). The
 * linter is advisory: use `lintMode: "warn"` to surface its findings as
 * diagnostics without blocking translation, or `"block"` to refuse to translate
 * when it reports errors.
 */

import { toPythonIdentifier } from "./identifiers.js";
import type { Block, LintError } from "./index.js";

const ambiguousWords = ["big", "small", "huge", "many", "few"];

/** Whole-word (Unicode-aware) matchers: "ambiguous", "biggest", "Germany" do not match. */
const ambiguousRegexes = ambiguousWords.map(
  (w) => new RegExp(`(?<![\\p{L}\\p{N}_])${w}(?![\\p{L}\\p{N}_])`, "iu")
);

const assignmentPrefixes = [
  /^\s*make a program that/i,
  /^\s*write a program that/i,
  /^\s*create a program that/i,
];

/** Text inside double quotes is data, not instruction wording. */
function withoutQuotedText(line: string): string {
  return line.replace(/"[^"]*"/g, '""');
}

function hasAmbiguousWord(line: string): boolean {
  const text = withoutQuotedText(line);
  return ambiguousRegexes.some((re) => re.test(text));
}

// The linter matches names case-insensitively, so it lowercases the shared policy's output.
function slugToVar(name: string): string {
  return toPythonIdentifier(name, "var").toLowerCase();
}

function extractAssignedVariables(line: string): string[] {
  const vars: string[] = [];
  const letMatch = line.match(/^\s*let (?:the )?(.+?) be /i);
  if (letMatch) vars.push(slugToVar(letMatch[1]));
  const setMatch = line.match(/^\s*set (?:the )?(.+?) to /i);
  if (setMatch) vars.push(slugToVar(setMatch[1]));
  return vars;
}

/** Start of a line or of a clause ("If x is 1, print the score."). */
const CLAUSE_START = String.raw`(?:^|[.,;:]\s*)`;

/** A phrase naming an operation ("the sum of x and y") is an expression, not a variable. */
const OPERATION_WORDS =
  /(?<![\p{L}\p{N}_])(?:sum|difference|product|quotient|plus|minus|times|multiplied|divided)(?![\p{L}\p{N}_])/iu;

/** Words that show a phrase is more than a bare variable name. */
const NOT_A_PLAIN_NAME =
  /(?<![\p{L}\p{N}_])(?:of|on|in|with|for|from|by|at|to|then|if|else|is|are)(?![\p{L}\p{N}_])/iu;

function plainVariable(phrase: string): string | null {
  const trimmed = phrase.trim().replace(/[.!?]+$/, "").trim();
  if (!trimmed || trimmed.startsWith('"')) return null;
  const name = trimmed.replace(/^the\s+/i, "");
  if (!name || NOT_A_PLAIN_NAME.test(name)) return null;
  if (!/^[\p{L}_][\p{L}\p{N}_ -]*$/u.test(name)) return null;
  return slugToVar(name);
}

function extractUsedVariables(line: string): string[] {
  const vars: string[] = [];
  const push = (phrase: string) => {
    const v = plainVariable(phrase);
    if (v) vars.push(v);
  };

  // "Add 1 to the score", "Subtract 3 from the counter"
  const addMatch = line.match(new RegExp(`${CLAUSE_START}add\\s+[^\\n]+?\\s+to\\s+the\\s+(.+?)\\s*\\.?$`, "i"));
  if (addMatch) push(addMatch[1]);
  const subMatch = line.match(new RegExp(`${CLAUSE_START}subtract\\s+[^\\n]+?\\s+from\\s+the\\s+(.+?)\\s*\\.?$`, "i"));
  if (subMatch) push(subMatch[1]);

  // "Print the score." (only at the start of a line or clause); a phrase naming
  // an operation ("the sum of x and y") is not a variable and is skipped.
  const printMatch = line.match(new RegExp(`${CLAUSE_START}print\\s+(.+?)\\s*\\.?$`, "i"));
  if (printMatch && !OPERATION_WORDS.test(printMatch[1])) {
    for (const part of printMatch[1].split(/\s*,\s*|\s+and\s+/i)) push(part);
  }

  const condMatch = line.match(new RegExp(`${CLAUSE_START}if the (.+?) is `, "i"));
  if (condMatch) push(condMatch[1]);
  const whileMatch = line.match(/^\s*while the (.+?) is /i);
  if (whileMatch) push(whileMatch[1]);
  return vars;
}

const OPERAND = String.raw`(?:-?\d+(?:[.,]\d+)?|(?:the\s+)?[\p{L}_][\p{L}\p{N}_]*)`;
const COMPARISON = new RegExp(
  String.raw`(?:greater than(?: or equal to)?|less than(?: or equal to)?|more than|fewer than|equal to|at least|at most)\s+${OPERAND}`,
  "iu"
);

function isAllowedCondition(line: string): boolean {
  const lower = line.toLowerCase();

  // 1) Comparisons against a number or another variable:
  //    "score is greater than 10", "x is greater than the y"
  if (COMPARISON.test(lower)) return true;

  // 2) Equality / inequality between variables.
  // a) "X and Y are (not) the same"
  if (/\b(.+?)\s+and\s+(.+?)\s+are\s+(not\s+)?the\s+same\b/.test(lower)) {
    return true;
  }

  // b) "X is (not) equal to Y"
  if (/\b(.+?)\s+is\s+(not\s+)?equal\s+to\s+(.+?)\b/.test(lower)) {
    return true;
  }

  return false;
}

/** "Repeat 3 times:", "Repeat the following 3 times" (colon optional). */
const VALID_REPEAT = /^\s*repeat\s+(?:the\s+following\s+)?(\d+)\s+times\b/i;

export function lintProgram(blocks: Block[]): LintError[] {
  const errors: LintError[] = [];
  const globalVars = new Set<string>();

  blocks.forEach((block) => {
    const blockDefined = new Set<string>();
    const lines = block.text.split(/\r?\n/);

    lines.forEach((line, index) => {
      const lineNo = index + 1;
      if (!line.trim()) return;

      // Detect assignment-style prose like "Make a program that ..."
      if (assignmentPrefixes.some((re) => re.test(line))) {
        errors.push({
          blockId: block.id,
          code: "ASSIGNMENT_TEXT",
          message:
            "This line looks like an assignment description (e.g. 'make a program that ...'), not a step-by-step instruction. Please rewrite it as explicit steps like 'Let the score be 0.' or 'Repeat 3 times: ...'.",
          location: { line: lineNo },
        });
      }

      if (hasAmbiguousWord(line)) {
        errors.push({
          blockId: block.id,
          code: "AMBIGUOUS_LANGUAGE",
          message:
            "This line uses ambiguous language (e.g. 'big', 'small', 'many'). Please use explicit numeric conditions.",
          location: { line: lineNo },
        });
      }

      const assigned = extractAssignedVariables(line);
      assigned.forEach((v) => blockDefined.add(v));

      const used = extractUsedVariables(line);
      used.forEach((v) => {
        if (!(globalVars.has(v) || blockDefined.has(v))) {
          errors.push({
            blockId: block.id,
            code: "UNDEFINED_VARIABLE",
            message: `The variable '${v}' is used but not defined in this or previous blocks.`,
            location: { line: lineNo },
          });
        }
      });

      // Condition check for if/while lines
      if (/^\s*if /i.test(line) || /^\s*while /i.test(line)) {
        if (!isAllowedCondition(line)) {
          errors.push({
            blockId: block.id,
            code: "INVALID_CONDITION",
            message:
              "This condition is not in a supported form. Use explicit comparisons (greater than / less than / equal to / at least / at most a number or another variable) or clear equality/inequality between variables (e.g. 'A and B are the same').",
            location: { line: lineNo },
          });
        }
      }

      // Loop check: a line that starts with "Repeat" needs a concrete count.
      if (/^\s*repeat\b/i.test(line) && !VALID_REPEAT.test(line)) {
        errors.push({
          blockId: block.id,
          code: "INVALID_LOOP",
          message:
            "Repeat loops must specify a concrete integer count, e.g. 'Repeat 3 times:'.",
          location: { line: lineNo },
        });
      }
    });

    // Update global vars
    blockDefined.forEach((v) => globalVars.add(v));
  });

  return errors;
}
