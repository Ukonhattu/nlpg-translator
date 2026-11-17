import Ajv from "ajv";
import { describe, expect, it } from "vitest";
import {
  AST_JSON_SCHEMA,
  astResponseFormat,
  fillOptionalNulls,
  stripNulls,
} from "../src/astSchema.js";
import { loadGolden } from "./fixtures/loadGolden.js";

const ajv = new Ajv({ strict: false, allErrors: false });
const validate = ajv.compile(AST_JSON_SCHEMA);

describe("AST JSON schema", () => {
  it.each(["combined-course-features", "lists-loops"])(
    "golden fixture %s validates (with strict-mode nulls)",
    (name) => {
      const { raw } = loadGolden(name);
      const strictShape = fillOptionalNulls(raw);
      const ok = validate(strictShape);
      expect(ok, JSON.stringify(validate.errors)).toBe(true);
      // and stripping the nulls gives back the plain fixture
      expect(stripNulls(strictShape)).toEqual(raw);
    }
  );

  it("requires optional fields to be present (strict mode shape)", () => {
    // `assign` without target/targetExpr nulls is not valid strict output
    expect(
      validate({
        statements: [{ kind: "assign", value: { kind: "num", value: 1, raw: null }, line: 1 }],
      })
    ).toBe(false);
  });

  it("rejects unknown kinds, extra properties and wrong types", () => {
    const bad = (stmt: unknown) => validate({ statements: [stmt] });
    expect(bad({ kind: "bogus", line: 1 })).toBe(false);
    expect(bad({ kind: "break", line: 1, extra: 1 })).toBe(false);
    expect(bad({ kind: "break", line: "1" })).toBe(false);
    expect(bad({ kind: "break", line: 1 })).toBe(true);
    expect(bad({ kind: "print", value: { kind: "binop", op: "**", left: { kind: "num", value: 1, raw: null }, right: { kind: "num", value: 1, raw: null } }, line: 1 })).toBe(false);
  });

  it("is a valid OpenAI strict-mode shape: every object lists all properties and forbids extras", () => {
    const problems: string[] = [];
    const walk = (node: unknown, path: string) => {
      if (Array.isArray(node)) return node.forEach((n, i) => walk(n, `${path}[${i}]`));
      if (!node || typeof node !== "object") return;
      const o = node as Record<string, any>;
      if (o.type === "object") {
        if (o.additionalProperties !== false) problems.push(`${path}: additionalProperties`);
        const keys = Object.keys(o.properties ?? {}).sort();
        const required = [...(o.required ?? [])].sort();
        if (JSON.stringify(keys) !== JSON.stringify(required)) problems.push(`${path}: required`);
      }
      for (const [k, v] of Object.entries(o)) walk(v, `${path}.${k}`);
    };
    walk(AST_JSON_SCHEMA, "$");
    expect(problems).toEqual([]);
  });

  it("builds the Responses API text.format parameter", () => {
    expect(astResponseFormat()).toMatchObject({
      format: { type: "json_schema", name: "nlpg_ast", strict: true, schema: AST_JSON_SCHEMA },
    });
  });
});

describe("stripNulls", () => {
  it("drops null properties but keeps array elements", () => {
    expect(stripNulls({ a: null, b: [null, { c: null, d: 1 }], e: 0, f: "" })).toEqual({
      b: [null, { d: 1 }],
      e: 0,
      f: "",
    });
  });
});
