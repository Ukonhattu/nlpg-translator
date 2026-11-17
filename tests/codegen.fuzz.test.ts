/**
 * Property test (FIX_PLAN Phase 0.2): generatePython must always emit parseable
 * Python for any structurally valid AST. Expected to fail until Phase 2 lands;
 * then change `it.fails` to `it`.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { Expr, Stmt } from "../src/ast.js";
import { generatePython } from "../src/codegen.js";
import { hasPython, assertParses } from "./helpers/python.js";

const idents = fc.constantFrom(
  "x", "total", "class", "def", "list", "sum", "määrä", "myList", "MyList", "x2", "my var"
);
const nastyStrings = fc.oneof(
  fc.string({ maxLength: 8 }),
  fc.constantFrom('a"b', "a'b", "a\\b", "{x}", "}{", "a\nb", "a\tb", '"""')
);

const expr: fc.Memo<Expr> = fc.memo((d) => {
  const leaf = fc.oneof(
    fc.integer({ min: -50, max: 50 }).map((value): Expr => ({ kind: "num", value })),
    nastyStrings.map((value): Expr => ({ kind: "str", value })),
    fc.boolean().map((value): Expr => ({ kind: "bool", value })),
    idents.map((name): Expr => ({ kind: "var", name }))
  );
  if (d <= 0) return leaf;
  const sub = expr(d - 1);
  return fc.oneof(
    leaf,
    fc.record({
      kind: fc.constant("binop" as const),
      op: fc.constantFrom("+", "-", "*", "/", "%" as const),
      left: sub,
      right: sub,
    }) as fc.Arbitrary<Expr>,
    fc.record({
      kind: fc.constant("compare" as const),
      op: fc.constantFrom(">", "<", ">=", "<=", "==", "!=" as const),
      left: sub,
      right: sub,
    }) as fc.Arbitrary<Expr>,
    sub.map((value): Expr => ({ kind: "not", value })),
    fc.record({ kind: fc.constant("index" as const), target: sub, index: sub }),
    fc.record({
      kind: fc.constant("fstring" as const),
      parts: fc.array(
        fc.oneof(
          nastyStrings.map((value) => ({ kind: "lit" as const, value })),
          sub.map((value) => ({ kind: "expr" as const, value }))
        ),
        { maxLength: 3 }
      ),
    }) as fc.Arbitrary<Expr>,
    fc.record({
      kind: fc.constant("call" as const),
      func: idents,
      args: fc.array(sub, { maxLength: 2 }),
    }) as fc.Arbitrary<Expr>,
    fc.record({
      kind: fc.constant("methodcall" as const),
      target: sub,
      method: fc.constantFrom("upper", "strip", "replace"),
      args: fc.array(sub, { maxLength: 2 }),
    }) as fc.Arbitrary<Expr>
  );
});

const stmt: fc.Memo<Stmt> = fc.memo((d) => {
  const e = expr(3);
  const simple = fc.oneof(
    fc.record({ kind: fc.constant("assign" as const), target: idents, value: e, source: fc.constant("") }) as fc.Arbitrary<Stmt>,
    fc.record({ kind: fc.constant("print" as const), value: e, source: fc.constant("") }) as fc.Arbitrary<Stmt>,
    fc.record({ kind: fc.constant("augassign" as const), target: idents, op: fc.constantFrom("+", "-"), value: e, source: fc.constant("") }) as fc.Arbitrary<Stmt>
  );
  if (d <= 0) return simple;
  const body = fc.array(stmt(d - 1), { maxLength: 2 });
  return fc.oneof(
    simple,
    fc.record({ kind: fc.constant("if" as const), test: e, body, orelse: body, source: fc.constant("") }) as fc.Arbitrary<Stmt>,
    fc.record({ kind: fc.constant("while" as const), test: e, body, source: fc.constant("") }) as fc.Arbitrary<Stmt>,
    fc.record({ kind: fc.constant("forin" as const), loopVar: idents, iterable: e, body, source: fc.constant("") }) as fc.Arbitrary<Stmt>,
    fc.record({
      kind: fc.constant("functiondef" as const),
      name: idents,
      params: fc.array(idents, { maxLength: 2 }),
      body,
      source: fc.constant(""),
    }) as fc.Arbitrary<Stmt>
  );
});

const maybeFails = hasPython ? it.fails : it.skip;

describe("codegen property test", () => {
  maybeFails("generatePython always emits parseable Python", () => {
    fc.assert(
      fc.property(fc.array(stmt(3), { minLength: 1, maxLength: 4 }), (stmts) => {
        const code = generatePython(stmts);
        assertParses(code);
        expect(code.length).toBeGreaterThan(0);
      }),
      { numRuns: 50 }
    );
  });
});
