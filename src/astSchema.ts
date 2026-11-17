/**
 * JSON Schema for the AST the model must produce (OpenAI structured outputs,
 * `strict: true`). Strict mode requires every property to be listed in
 * `required` and `additionalProperties: false`, so optional fields are modelled
 * as "T or null". Use `stripNulls` to turn a model response back into the plain
 * AST shape (`undefined` for absent optionals) before verification.
 *
 * The schema is generated from one spec table so the schema, `stripNulls` and
 * the test helper `fillOptionalNulls` cannot drift apart. It constrains SHAPE
 * only; semantic checks (identifiers, lines, grounding) still happen in
 * verifyProgram.
 */

export type JsonSchema = Record<string, unknown>;

type Field = { schema: JsonSchema; optional?: boolean };

const ref = (name: "Expr" | "Stmt"): JsonSchema => ({ $ref: `#/$defs/${name}` });
const str: JsonSchema = { type: "string" };
const int: JsonSchema = { type: "integer" };
const arrayOf = (items: JsonSchema): JsonSchema => ({ type: "array", items });
const oneOf = (...values: string[]): JsonSchema => ({ type: "string", enum: values });
const opt = (schema: JsonSchema): Field => ({ schema, optional: true });
const req = (schema: JsonSchema): Field => ({ schema });

/** Schema version history: 1 = original; 2 = statements carry `evidence` (+ `outputCue` on print). */
export type AstSchemaVersion = 1 | 2;

const EXPR = ref("Expr");
const STMT = ref("Stmt");
const STMTS = arrayOf(STMT);
const EXPRS = arrayOf(EXPR);

const LINE = req(int);

/** Kinds -> field specs (without `kind`). */
const EXPR_SPEC: Record<string, Record<string, Field>> = {
  num: { value: req({ type: "number" }), raw: opt(str) },
  str: { value: req(str) },
  bool: { value: req({ type: "boolean" }) },
  var: { name: req(str) },
  binop: { op: req(oneOf("+", "-", "*", "/", "%")), left: req(EXPR), right: req(EXPR) },
  compare: {
    op: req(oneOf(">", "<", ">=", "<=", "==", "!=")),
    left: req(EXPR),
    right: req(EXPR),
  },
  boolop: { op: req(oneOf("and", "or")), values: req(EXPRS) },
  not: { value: req(EXPR) },
  index: { target: req(EXPR), index: req(EXPR) },
  input: { prompt: opt(EXPR), cast: opt(oneOf("int", "float")) },
  cast: { type: req(oneOf("int", "float", "str")), value: req(EXPR) },
  list: { items: req(EXPRS) },
  call: { func: req(str), args: req(EXPRS) },
  methodcall: { target: req(EXPR), method: req(str), args: req(EXPRS) },
  fstring: { parts: req(arrayOf({ $ref: "#/$defs/FStringPart" })) },
  contains: { left: req(EXPR), right: req(EXPR) },
};

const STMT_SPEC_V1: Record<string, Record<string, Field>> = {
  assign: { target: opt(str), targetExpr: opt(EXPR), value: req(EXPR), line: LINE },
  augassign: { target: req(str), op: req(oneOf("+", "-", "*", "/")), value: req(EXPR), line: LINE },
  unpackassign: { targets: req(arrayOf(str)), value: req(EXPR), line: LINE },
  print: { value: req(EXPR), line: LINE },
  if: {
    test: req(EXPR),
    body: req(STMTS),
    elifs: opt(arrayOf({ $ref: "#/$defs/ElifClause" })),
    orelse: req(STMTS),
    line: LINE,
  },
  while: { test: req(EXPR), body: req(STMTS), line: LINE },
  repeat: { count: req(EXPR), body: req(STMTS), line: LINE },
  for: {
    loopVar: req(str),
    start: req(EXPR),
    stop: req(EXPR),
    step: opt(EXPR),
    body: req(STMTS),
    line: LINE,
  },
  forin: { loopVar: req(str), iterable: req(EXPR), body: req(STMTS), line: LINE },
  break: { line: LINE },
  pass: { line: LINE },
  append: { target: req(str), value: req(EXPR), line: LINE },
  functiondef: {
    name: req(str),
    params: req(arrayOf(str)),
    body: req(STMTS),
    docstring: opt(str),
    line: LINE,
  },
  return: { values: req(EXPRS), line: LINE },
  assert: { test: req(EXPR), message: opt(EXPR), line: LINE },
  raise: { excType: req(str), message: opt(EXPR), line: LINE },
  try: { body: req(STMTS), handlers: req(arrayOf({ $ref: "#/$defs/ExceptHandler" })), line: LINE },
  exprstmt: { expr: req(EXPR), line: LINE },
  unknown: { note: opt(str), line: LINE },
};

function stmtSpec(version: AstSchemaVersion): Record<string, Record<string, Field>> {
  if (version < 2) return STMT_SPEC_V1;
  const out: Record<string, Record<string, Field>> = {};
  for (const [kind, fields] of Object.entries(STMT_SPEC_V1)) {
    out[kind] = { ...fields, evidence: req(str) };
    if (kind === "print") out[kind].outputCue = req(str);
  }
  return out;
}

const STMT_SPEC = stmtSpec(2);

/** Auxiliary object shapes (not discriminated by `kind` at the top level). */
const AUX_SPEC: Record<string, Record<string, Field>> = {
  ElifClause: { test: req(EXPR), body: req(STMTS) },
  ExceptHandler: { exc: opt(str), body: req(STMTS) },
};

const FSTRING_PART_SPEC: Record<string, Record<string, Field>> = {
  lit: { value: req(str) },
  expr: { value: req(EXPR) },
};

function nullable(schema: JsonSchema): JsonSchema {
  return { anyOf: [schema, { type: "null" }] };
}

function objectSchema(kind: string | undefined, fields: Record<string, Field>): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  if (kind !== undefined) properties.kind = { type: "string", enum: [kind] };
  for (const [name, f] of Object.entries(fields)) {
    properties[name] = f.optional ? nullable(f.schema) : f.schema;
  }
  return {
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  };
}

function union(spec: Record<string, Record<string, Field>>): JsonSchema {
  return { anyOf: Object.entries(spec).map(([kind, fields]) => objectSchema(kind, fields)) };
}

export const AST_SCHEMA_NAME = "nlpg_ast";

export function buildAstSchema(version: AstSchemaVersion = 2): JsonSchema {
  return {
    type: "object",
    properties: { statements: arrayOf(STMT) },
    required: ["statements"],
    additionalProperties: false,
    $defs: {
      Expr: union(EXPR_SPEC),
      Stmt: union(stmtSpec(version)),
      FStringPart: union(FSTRING_PART_SPEC),
      ElifClause: objectSchema(undefined, AUX_SPEC.ElifClause),
      ExceptHandler: objectSchema(undefined, AUX_SPEC.ExceptHandler),
    },
  };
}

/** The current (v2) schema. */
export const AST_JSON_SCHEMA: JsonSchema = buildAstSchema(2);

/** The `text.format` request parameter for the Responses API. */
export function astResponseFormat(): Record<string, unknown> {
  return {
    format: {
      type: "json_schema",
      name: AST_SCHEMA_NAME,
      strict: true,
      schema: AST_JSON_SCHEMA,
    },
  };
}

/**
 * Removes `null`-valued object properties (strict-mode placeholders for absent
 * optional fields) so downstream code sees `undefined`. Array elements are left
 * untouched: a `null` element is invalid and is reported by verification.
 */
export function stripNulls<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((v) => stripNulls(v)) as unknown as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (v === null) continue;
      out[k] = stripNulls(v);
    }
    return out as T;
  }
  return value;
}

const ALL_SPECS = [EXPR_SPEC, STMT_SPEC, FSTRING_PART_SPEC];

/**
 * Inverse of `stripNulls` for tests: adds `null` for every optional field a node
 * omits, producing what a strict-mode model response looks like.
 */
export function fillOptionalNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(fillOptionalNulls);
  if (!value || typeof value !== "object") return value;
  const node = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) out[k] = fillOptionalNulls(v);

  let fields: Record<string, Field> | undefined;
  if (typeof node.kind === "string") {
    // Statement kinds win over expression kinds that share a name (`str`, `not`...
    // never collide with statements today, but check the statement table first
    // only when `line` is present).
    const tables = "line" in node ? [STMT_SPEC, ...ALL_SPECS] : [EXPR_SPEC, FSTRING_PART_SPEC, STMT_SPEC];
    for (const t of tables) {
      if (t[node.kind]) {
        fields = t[node.kind];
        break;
      }
    }
  } else if ("test" in node && "body" in node) {
    fields = AUX_SPEC.ElifClause;
  } else if ("body" in node && !("kind" in node)) {
    fields = AUX_SPEC.ExceptHandler;
  }
  if (fields) {
    for (const [name, f] of Object.entries(fields)) {
      if (f.optional && !(name in out)) out[name] = null;
    }
  }
  return out;
}
