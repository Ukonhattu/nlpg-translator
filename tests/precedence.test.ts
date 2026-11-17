import { spawnSync } from "node:child_process";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { Expr } from "../src/ast.js";
import { emitExpr } from "../src/codegen.js";
import { hasPython } from "./helpers/python.js";

/** Fully parenthesised reference rendering of an expression tree. */
function reference(e: Expr): string {
  switch (e.kind) {
    case "num":
      return e.value < 0 ? `(${e.value})` : String(e.value);
    case "bool":
      return e.value ? "True" : "False";
    case "binop":
    case "compare":
      return `(${reference(e.left)} ${e.op} ${reference(e.right)})`;
    case "boolop":
      return `(${e.values.map(reference).join(` ${e.op} `)})`;
    case "not":
      return `(not ${reference(e.value)})`;
    default:
      throw new Error("unsupported in this test");
  }
}

const exprArb: fc.Memo<Expr> = fc.memo((d) => {
  const leaf = fc.oneof(
    fc.integer({ min: -4, max: 6 }).map((value): Expr => ({ kind: "num", value })),
    fc.boolean().map((value): Expr => ({ kind: "bool", value }))
  );
  if (d <= 0) return leaf;
  const sub = exprArb(d - 1);
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
    fc.record({
      kind: fc.constant("boolop" as const),
      op: fc.constantFrom("and", "or" as const),
      values: fc.array(sub, { minLength: 2, maxLength: 3 }),
    }) as fc.Arbitrary<Expr>,
    sub.map((value): Expr => ({ kind: "not", value }))
  );
});

const PY_EVAL = `
import json, sys
pairs = json.load(sys.stdin)
def ev(s):
    try:
        v = eval(s, {"__builtins__": {}})
        return repr(v)
    except Exception as e:
        return type(e).__name__
print(json.dumps([[ev(a), ev(b)] for a, b in pairs]))
`;

describe.skipIf(!hasPython)("operator precedence (evaluated in Python)", () => {
  it("emitted code evaluates like the fully parenthesised reference", () => {
    fc.assert(
      fc.property(fc.array(exprArb(4), { minLength: 20, maxLength: 20 }), (exprs) => {
        const pairs = exprs.map((e) => [emitExpr(e), reference(e)]);
        const r = spawnSync("python3", ["-I", "-c", PY_EVAL], {
          input: JSON.stringify(pairs),
          encoding: "utf8",
        });
        expect(r.status, r.stderr).toBe(0);
        const results = JSON.parse(r.stdout) as string[][];
        results.forEach(([got, want], i) => {
          expect(got, `emitted ${pairs[i][0]} vs reference ${pairs[i][1]}`).toBe(want);
        });
      }),
      { numRuns: 40 }
    );
  });
});

describe("minimal parentheses", () => {
  const n = (value: number): Expr => ({ kind: "num", value });
  const v = (name: string): Expr => ({ kind: "var", name });
  const bin = (op: "+" | "-" | "*" | "/" | "%", left: Expr, right: Expr): Expr => ({
    kind: "binop", op, left, right,
  });

  it("drops redundant parentheses", () => {
    expect(emitExpr(bin("+", bin("+", v("a"), v("b")), v("c")))).toBe("a + b + c");
    expect(emitExpr(bin("+", v("a"), bin("*", v("b"), v("c"))))).toBe("a + b * c");
  });

  it("keeps required parentheses", () => {
    expect(emitExpr(bin("*", bin("+", v("a"), v("b")), v("c")))).toBe("(a + b) * c");
    expect(emitExpr(bin("-", v("a"), bin("-", v("b"), v("c"))))).toBe("a - (b - c)");
    expect(emitExpr(bin("/", v("a"), bin("*", v("b"), v("c"))))).toBe("a / (b * c)");
    expect(emitExpr(bin("*", v("a"), bin("%", v("b"), v("c"))))).toBe("a * (b % c)");
  });

  it("wraps negative numbers where Python needs it", () => {
    expect(emitExpr(bin("-", v("a"), n(-5)))).toBe("a - (-5)");
    expect(emitExpr({ kind: "index", target: n(-5), index: n(0) })).toBe("(-5)[0]");
    expect(
      emitExpr({ kind: "methodcall", target: n(5), method: "bit_length", args: [] })
    ).toBe("(5).bit_length()");
  });

  it("never chains comparisons implicitly", () => {
    const cmp = (l: Expr, r: Expr): Expr => ({ kind: "compare", op: "<", left: l, right: r });
    expect(emitExpr(cmp(cmp(v("a"), v("b")), v("c")))).toBe("(a < b) < c");
  });
});
