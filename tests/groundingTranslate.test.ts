import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { translateProgram } from "../src/index.js";
import { AST_PROMPT_V2 } from "../src/prompts/ast.v2.js";

const mockFetch = vi.fn();
const opts = { aaltoApiKey: "k", endpoint: "https://g.example/r", model: "m", astMode: true as const, includeDiagnostics: true };
const source = "Let the score be 10.\nPrint the score.";
const blocks = [{ id: "b", text: source }];

const statements = [
  { kind: "assign", target: "score", value: { kind: "num", value: 10 }, line: 1, evidence: "Let the score be 10" },
  { kind: "print", value: { kind: "var", name: "score" }, line: 2, evidence: "Print the score", outputCue: "Print" },
  { kind: "assign", target: "bonus", value: { kind: "num", value: 99 }, line: 2, evidence: "Print the score" },
];

beforeEach(() => {
  mockFetch.mockReset();
  mockFetch.mockResolvedValue({
    ok: true,
    json: async () => ({ output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({ statements }) }] }] }),
  });
  vi.stubGlobal("fetch", (...a: unknown[]) => mockFetch(...a));
});
afterEach(() => vi.unstubAllGlobals());

describe("grounding option", () => {
  it("defaults to warn: diagnostics, nothing removed, status ok", async () => {
    const r = await translateProgram(blocks, opts);
    expect(r.pythonCode).toContain("bonus = 99");
    expect(r.status).toBe("ok");
    const codes = r.diagnosticsDetailed!.map((d) => d.code);
    expect(codes).toEqual(expect.arrayContaining(["GROUNDING_LITERAL", "GROUNDING_IDENTIFIER"]));
    expect(r.diagnosticsDetailed!.find((d) => d.code === "GROUNDING_LITERAL")).toMatchObject({ blockId: "b", line: 2 });
  });

  it("strict: replaces the step and marks the block partial", async () => {
    const r = await translateProgram(blocks, { ...opts, grounding: "strict" });
    expect(r.pythonCode).not.toContain("bonus");
    expect(r.pythonCode).toContain("# unsupported:");
    expect(r.status).toBe("partial");
    expect(r.blocks![0].unknownNodes).toBe(1);
  });

  it("off: no grounding diagnostics", async () => {
    const r = await translateProgram(blocks, { ...opts, grounding: "off" });
    expect(r.diagnosticsDetailed?.some((d) => d.code.startsWith("GROUNDING_")) ?? false).toBe(false);
  });
});

describe("prompt ast.v2", () => {
  it("asks for evidence and outputCue and shows English and Finnish examples", () => {
    expect(AST_PROMPT_V2.id).toBe("ast.v2");
    expect(AST_PROMPT_V2.text).toMatch(/"evidence"/);
    expect(AST_PROMPT_V2.text).toMatch(/"outputCue"/);
    expect(AST_PROMPT_V2.text).toMatch(/Let the total be 0/);
    expect(AST_PROMPT_V2.text).toMatch(/Ohjelma tulostaa summan/);
  });

  it("is what the translator sends", async () => {
    await translateProgram(blocks, opts);
    const body = JSON.parse((mockFetch.mock.calls[0][1] as RequestInit).body as string);
    expect(body.input[0].content).toBe(AST_PROMPT_V2.text);
    expect(body.text.format.schema.$defs.Stmt.anyOf[0].required).toContain("evidence");
  });
});
