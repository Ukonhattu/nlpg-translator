/**
 * Unambiguous verbs that mean "explicitly request program output" in course materials.
 * Used only when strictOutputFidelity is enabled (AST print drop / direct print strip).
 */
export const OUTPUT_VERBS = [
  // English
  "print",
  "show",
  "display",
  "output",
  // Finnish
  "tulosta",
  "näytä",
  "nayta",
  "kirjoita",
  "tulostetaan",
  "näytetään",
  "naytetaan",
];

function normalizeLine(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

const OUTPUT_VERB_SET = new Set(
  OUTPUT_VERBS.map((verb) => verb.toLowerCase())
);

/** Split a normalized line into words (Unicode letters/digits; not ASCII-only \\b). */
function wordsInLine(normalized: string): string[] {
  return normalized.split(/[^\p{L}\p{N}_]+/u).filter(Boolean);
}

/** True when a source line explicitly asks for output (any supported course language). */
export function lineRequestsOutput(line: string): boolean {
  const tokens = wordsInLine(normalizeLine(line));
  return tokens.some((token) => OUTPUT_VERB_SET.has(token));
}

export function countRequestedPrints(sourceText: string): number {
  return sourceText.split(/\r?\n/).filter((line) => line.trim() && lineRequestsOutput(line)).length;
}
