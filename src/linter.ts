import type { Block, LintError } from "./index.js";

const ambiguousWords = ["big", "small", "huge", "many", "few"];

const assignmentPrefixes = [
  /^\s*make a program that/i,
  /^\s*write a program that/i,
  /^\s*create a program that/i,
];

function hasAmbiguousWord(line: string): boolean {
  const lower = line.toLowerCase();
  return ambiguousWords.some((w) => lower.includes(w));
}

function extractAssignedVariables(line: string): string[] {
  const vars: string[] = [];
  const letMatch = line.match(/^\s*let the (.+?) be /i);
  if (letMatch) {
    vars.push(slugToVar(letMatch[1]));
  }
  const setMatch = line.match(/^\s*set the (.+?) to /i);
  if (setMatch) {
    vars.push(slugToVar(setMatch[1]));
  }
  return vars;
}

function extractUsedVariables(line: string): string[] {
  const vars: string[] = [];
  // "Add 1 to the score", "Subtract 3 from the counter", "Print the score"
  const addMatch = line.match(/add [^\n]+ to the (.+?)\.?$/i);
  if (addMatch) vars.push(slugToVar(addMatch[1]));
  const subMatch = line.match(/subtract [^\n]+ from the (.+?)\.?$/i);
  if (subMatch) vars.push(slugToVar(subMatch[1]));
  const printMatch = line.match(/print (?:the )?(.+?)\.?$/i);
  if (printMatch && !printMatch[1].startsWith("\"")) {
    vars.push(slugToVar(printMatch[1]));
  }
  const condMatch = line.match(/if the (.+?) is /i);
  if (condMatch) vars.push(slugToVar(condMatch[1]));
  const whileMatch = line.match(/while the (.+?) is /i);
  if (whileMatch) vars.push(slugToVar(whileMatch[1]));
  return vars;
}

function slugToVar(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_");
}

function isAllowedCondition(line: string): boolean {
  const lower = line.toLowerCase();

  // 1) Numeric comparisons: "score is greater than 10", etc.
  if (/(greater than|less than|equal to|at least|at most)\s+\d+/.test(lower)) {
    return true;
  }

  // 2) Equality / inequality between variables.
  // Examples we support:
  // - if A and B are the same, ...
  // - if A and B are not the same, ...
  // - if A is equal to B, ...
  // - if A is not equal to B, ...

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
              "This condition is not in a supported form. Use explicit numeric comparisons (greater than / less than / equal to / at least / at most <number>) or clear equality/inequality between variables (e.g. 'A and B are the same').",
            location: { line: lineNo },
          });
        }
      }

      // Simple loop check: "Repeat N times:"
      const repeatMatch = line.match(/repeat (\d+) times:/i);
      if (/repeat /i.test(line) && !repeatMatch) {
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
