/**
 * Verbs/phrases that mean "explicitly request program output" in course materials.
 * Used by direct-mode print counting and AST print-node verification.
 */
export const OUTPUT_VERBS = [
  // English
  "print",
  "show",
  "display",
  "output",
  "say",
  "tell",
  "report",
  "log",
  "announce",
  "list",
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

/** True when a source line explicitly asks for output (any supported course language). */
export function lineRequestsOutput(line: string): boolean {
  const normalized = normalizeLine(line);
  return OUTPUT_VERBS.some((verb) => {
    const escaped = verb.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`\\b${escaped}\\b`, "i").test(normalized);
  });
}

export function countRequestedPrints(sourceText: string): number {
  return sourceText.split(/\r?\n/).filter((line) => line.trim() && lineRequestsOutput(line)).length;
}
