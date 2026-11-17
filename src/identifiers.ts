/**
 * Single identifier policy for generated Python.
 *
 * - trim, turn whitespace/hyphen runs into `_`
 * - KEEP case (so `calculateArea` defined and called stays `calculateArea`)
 * - keep Unicode letters/digits (Python 3 identifiers), drop everything else
 * - prefix `_` when the result cannot start an identifier
 * - suffix `_` for Python keywords (3.10 `keyword.kwlist`)
 * - empty result -> `value`
 *
 * Soft keywords (`match`, `case`, `_`) are legal identifiers and are left alone.
 */

export type IdentifierRole = "var" | "func" | "param" | "attr" | "exception";

/** Python 3.10 `keyword.kwlist`. */
export const PYTHON_KEYWORDS: ReadonlySet<string> = new Set([
  "False", "None", "True", "and", "as", "assert", "async", "await", "break",
  "class", "continue", "def", "del", "elif", "else", "except", "finally",
  "for", "from", "global", "if", "import", "in", "is", "lambda", "nonlocal",
  "not", "or", "pass", "raise", "return", "try", "while", "with", "yield",
]);

/** Builtins the course uses; binding one of these shadows it (reported, not renamed). */
export const SHADOWABLE_BUILTINS: ReadonlySet<string> = new Set([
  "list", "sum", "max", "min", "len", "input", "print", "str", "int", "float",
]);

const ID_START = /[\p{L}\p{Nl}_]/u;
const ID_CHAR_STRIP = /[^\p{L}\p{Nl}\p{Nd}\p{Mn}\p{Mc}\p{Pc}_]/gu;
const VALID_IDENTIFIER = /^[\p{L}\p{Nl}_][\p{L}\p{Nl}\p{Nd}\p{Mn}\p{Mc}\p{Pc}_]*$/u;

/**
 * Trim and turn runs of spaces/tabs into `_`. Used before validity checks;
 * embedded line breaks are deliberately NOT normalised, so multi-line "names"
 * stay invalid.
 */
export function normalizeIdentifierText(name: string): string {
  return name.trim().replace(/[ \t]+/gu, "_");
}

/** True for a legal, non-keyword Python identifier (no normalisation applied). */
export function isValidPythonIdentifier(name: string): boolean {
  return VALID_IDENTIFIER.test(name) && !PYTHON_KEYWORDS.has(name);
}

/** Validity check after whitespace normalisation only (used at verify time). */
export function isValidNormalizedIdentifier(name: unknown): name is string {
  return (
    typeof name === "string" && isValidPythonIdentifier(normalizeIdentifierText(name))
  );
}

export function toPythonIdentifier(name: string, _role: IdentifierRole = "var"): string {
  let id = name
    .normalize("NFC")
    .trim()
    .replace(/[\s-]+/gu, "_")
    .replace(ID_CHAR_STRIP, "");
  if (!id) return "value";
  if (!ID_START.test(String.fromCodePoint(id.codePointAt(0)!))) {
    id = `_${id}`;
  }
  if (PYTHON_KEYWORDS.has(id)) id = `${id}_`;
  return id;
}
