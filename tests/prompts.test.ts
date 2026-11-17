import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getPrompt, PROMPTS, sha256Hex } from "../src/prompts/index.js";
import { PACKAGE_VERSION } from "../src/version.js";

const fixturePath = join(import.meta.dirname, "fixtures", "prompt-hashes.json");
const expected = JSON.parse(readFileSync(fixturePath, "utf8")) as Record<string, string>;

describe("prompt registry (§9.3)", () => {
  it("has unique ids", () => {
    const ids = PROMPTS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(expect.arrayContaining(["ast.v2", "direct.v1", "direct.v2"]));
  });

  it("computes SHA-256 of the prompt text", () => {
    for (const p of PROMPTS) {
      expect(p.sha256).toBe(createHash("sha256").update(p.text, "utf8").digest("hex"));
      expect(p.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(getPrompt("ast.v2").sha256).toBe(sha256Hex(getPrompt("ast.v2").text));
    expect(() => getPrompt("nope")).toThrow(/Unknown prompt id/);
  });

  it.each(PROMPTS.map((p) => [p.id, p] as const))(
    "%s: text matches the recorded hash (changing a prompt requires a NEW id)",
    (id, p) => {
      expect(
        expected[id],
        `No recorded hash for prompt id "${id}". Add it to tests/fixtures/prompt-hashes.json: ${p.sha256}`
      ).toBeDefined();
      expect(
        p.sha256,
        `The text of prompt "${id}" changed. Do not edit a released prompt: create a new id (e.g. ${id.replace(/\d+$/, (n) => String(Number(n) + 1))}) and record its hash in tests/fixtures/prompt-hashes.json.`
      ).toBe(expected[id]);
    }
  );

  it("the fixture has no stale ids", () => {
    expect(Object.keys(expected).sort()).toEqual(PROMPTS.map((p) => p.id).sort());
  });
});

describe("package version (§9.1)", () => {
  it("src/version.ts matches package.json", () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8"));
    expect(PACKAGE_VERSION).toBe(pkg.version);
  });
});
