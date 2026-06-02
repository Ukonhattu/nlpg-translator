/**
 * Intermediate representation (AST) for the natural-language -> Python pipeline.
 *
 * The LLM's job is to *transcribe* the source instructions into this structure,
 * not to write Python. The code generator (codegen.ts) then turns the AST into
 * Python deterministically, so it can never add anything that is not in the AST.
 *
 * Every statement carries a `source` field: the exact snippet of the original
 * natural-language text it was derived from. This lets us verify, after the LLM
 * call, that each node is actually grounded in the source and drop the ones that
 * are not (hallucinations).
 */

export type Expr =
  | { kind: "num"; value: number }
  | { kind: "str"; value: string }
  | { kind: "bool"; value: boolean }
  | { kind: "var"; name: string }
  | { kind: "binop"; op: "+" | "-" | "*" | "/" | "%"; left: Expr; right: Expr }
  | {
      kind: "compare";
      op: ">" | "<" | ">=" | "<=" | "==" | "!=";
      left: Expr;
      right: Expr;
    }
  | { kind: "boolop"; op: "and" | "or"; values: Expr[] }
  | { kind: "not"; value: Expr }
  | { kind: "index"; target: Expr; index: Expr }
  | { kind: "input"; prompt?: Expr; cast?: "int" | "float" };

export type Stmt =
  | { kind: "assign"; target: string; value: Expr; source: string }
  | {
      kind: "augassign";
      target: string;
      op: "+" | "-" | "*" | "/";
      value: Expr;
      source: string;
    }
  | { kind: "print"; value: Expr; source: string }
  | {
      kind: "if";
      test: Expr;
      body: Stmt[];
      orelse: Stmt[];
      source: string;
    }
  | { kind: "while"; test: Expr; body: Stmt[]; source: string }
  | { kind: "repeat"; count: Expr; body: Stmt[]; source: string }
  | {
      kind: "for";
      loopVar: string;
      start: Expr;
      stop: Expr;
      step?: Expr;
      body: Stmt[];
      source: string;
    }
  | { kind: "unknown"; source: string; note?: string };

export type Program = { statements: Stmt[] };

const EXPR_KINDS = new Set([
  "num",
  "str",
  "bool",
  "var",
  "binop",
  "compare",
  "boolop",
  "not",
  "index",
  "input",
]);

const STMT_KINDS = new Set([
  "assign",
  "augassign",
  "print",
  "if",
  "while",
  "repeat",
  "for",
  "unknown",
]);

const COMPARE_OPS = new Set([">", "<", ">=", "<=", "==", "!="]);
const BINOPS = new Set(["+", "-", "*", "/", "%"]);
const AUG_OPS = new Set(["+", "-", "*", "/"]);

/**
 * Verbs that signal an explicit request to produce output. Used only to verify
 * the LLM's own attribution of `print` nodes; it does NOT constrain the input
 * phrasing (any source line may use any of these words).
 */
const OUTPUT_VERBS = [
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
];

export type VerifyResult = {
  statements: Stmt[];
  warnings: string[];
};

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function isExpr(node: any): node is Expr {
  if (!node || typeof node !== "object" || !EXPR_KINDS.has(node.kind)) {
    return false;
  }
  switch (node.kind) {
    case "num":
      return typeof node.value === "number" && Number.isFinite(node.value);
    case "str":
      return typeof node.value === "string";
    case "bool":
      return typeof node.value === "boolean";
    case "var":
      return typeof node.name === "string" && node.name.trim().length > 0;
    case "binop":
      return BINOPS.has(node.op) && isExpr(node.left) && isExpr(node.right);
    case "compare":
      return (
        COMPARE_OPS.has(node.op) && isExpr(node.left) && isExpr(node.right)
      );
    case "boolop":
      return (
        (node.op === "and" || node.op === "or") &&
        Array.isArray(node.values) &&
        node.values.length >= 2 &&
        node.values.every(isExpr)
      );
    case "not":
      return isExpr(node.value);
    case "index":
      return isExpr(node.target) && isExpr(node.index);
    case "input":
      return (
        (node.prompt === undefined || isExpr(node.prompt)) &&
        (node.cast === undefined ||
          node.cast === "int" ||
          node.cast === "float")
      );
    default:
      return false;
  }
}

/**
 * Validates a single statement node against the schema. Returns the typed node
 * if structurally valid, or null otherwise. Bodies are validated recursively
 * via {@link verifyStatements}; here we only check this node's own shape.
 */
function validateStmtShape(node: any): boolean {
  if (!node || typeof node !== "object" || !STMT_KINDS.has(node.kind)) {
    return false;
  }
  const hasSource =
    node.kind === "unknown"
      ? typeof node.source === "string"
      : typeof node.source === "string" && node.source.trim().length > 0;
  if (!hasSource) return false;

  switch (node.kind) {
    case "assign":
      return typeof node.target === "string" && isExpr(node.value);
    case "augassign":
      return (
        typeof node.target === "string" &&
        AUG_OPS.has(node.op) &&
        isExpr(node.value)
      );
    case "print":
      return isExpr(node.value);
    case "if":
      return (
        isExpr(node.test) &&
        Array.isArray(node.body) &&
        Array.isArray(node.orelse)
      );
    case "while":
      return isExpr(node.test) && Array.isArray(node.body);
    case "repeat":
      return isExpr(node.count) && Array.isArray(node.body);
    case "for":
      return (
        typeof node.loopVar === "string" &&
        node.loopVar.trim().length > 0 &&
        isExpr(node.start) &&
        isExpr(node.stop) &&
        (node.step === undefined || isExpr(node.step)) &&
        Array.isArray(node.body)
      );
    case "unknown":
      return true;
    default:
      return false;
  }
}

function sourceExists(citation: string, normalizedSource: string): boolean {
  const c = normalize(citation);
  if (!c) return false;
  return normalizedSource.includes(c);
}

function citationHasOutputVerb(citation: string): boolean {
  const c = normalize(citation);
  return OUTPUT_VERBS.some((v) => new RegExp(`\\b${v}\\b`).test(c));
}

/**
 * Recursively validates and fidelity-checks a list of statements against the
 * original source text. Nodes that fail validation or that are not grounded in
 * the source are dropped (per the project's "drop on no source basis" policy),
 * and a warning is recorded for each drop.
 */
export function verifyStatements(
  nodes: any[],
  sourceText: string,
  warnings: string[],
  path = "program"
): Stmt[] {
  const normalizedSource = normalize(sourceText);
  const result: Stmt[] = [];

  nodes.forEach((node, index) => {
    const where = `${path}[${index}]`;

    if (!validateStmtShape(node)) {
      warnings.push(
        `Dropped malformed node at ${where} (kind: ${
          node?.kind ?? "unknown"
        }).`
      );
      return;
    }

    // Fidelity: the cited source must actually appear in the input.
    if (node.kind !== "unknown" && !sourceExists(node.source, normalizedSource)) {
      warnings.push(
        `Dropped '${node.kind}' at ${where}: its cited source ` +
          `(${JSON.stringify(node.source)}) is not present in the input.`
      );
      return;
    }

    // Fidelity: a print must be attributed to a line that actually asks for
    // output, otherwise the model invented it.
    if (node.kind === "print" && !citationHasOutputVerb(node.source)) {
      warnings.push(
        `Dropped 'print' at ${where}: cited source ` +
          `(${JSON.stringify(node.source)}) does not request any output.`
      );
      return;
    }

    if (node.kind === "if") {
      node.body = verifyStatements(
        node.body,
        sourceText,
        warnings,
        `${where}.body`
      );
      node.orelse = verifyStatements(
        node.orelse,
        sourceText,
        warnings,
        `${where}.orelse`
      );
    } else if (
      node.kind === "while" ||
      node.kind === "repeat" ||
      node.kind === "for"
    ) {
      node.body = verifyStatements(
        node.body,
        sourceText,
        warnings,
        `${where}.body`
      );
    }

    result.push(node as Stmt);
  });

  return result;
}

/**
 * Parses, validates, and fidelity-checks a raw program object produced by the
 * LLM. Returns the surviving statements plus any warnings about dropped nodes.
 */
export function verifyProgram(raw: any, sourceText: string): VerifyResult {
  const warnings: string[] = [];
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.statements)) {
    warnings.push("Model did not return a valid program object.");
    return { statements: [], warnings };
  }
  const statements = verifyStatements(raw.statements, sourceText, warnings);
  return { statements, warnings };
}
