import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { translateProgram } from "../src/index.js";

const mockFetch = vi.fn();
const opts = { aaltoApiKey: "k", endpoint: "https://l.example/r", model: "m" };
const bad = [{ id: "b1", text: "Print the score." }]; // UNDEFINED_VARIABLE
const reply = {
  ok: true,
  json: async () => ({ output: [{ type: "message", content: [{ type: "output_text", text: "print(score)" }] }] }),
};

beforeEach(() => {
  mockFetch.mockReset();
  mockFetch.mockResolvedValue(reply);
  vi.stubGlobal("fetch", (...a: unknown[]) => mockFetch(...a));
});
afterEach(() => vi.unstubAllGlobals());

describe("lintMode", () => {
  it("off is the default: no linting, no extra diagnostics", async () => {
    const r = await translateProgram(bad, opts);
    expect(r.errors).toEqual([]);
    expect(r.diagnostics).toBeUndefined();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("block refuses to translate and returns errors", async () => {
    const r = await translateProgram(bad, { ...opts, lintMode: "block" });
    expect(r.pythonCode).toBe("");
    expect(r.errors[0]).toMatchObject({ code: "UNDEFINED_VARIABLE", blockId: "b1" });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("enableLint: true still means block (backward compatible)", async () => {
    const r = await translateProgram(bad, { ...opts, enableLint: true });
    expect(r.errors).toHaveLength(1);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("an explicit lintMode wins over enableLint", async () => {
    const r = await translateProgram(bad, { ...opts, enableLint: true, lintMode: "off" });
    expect(r.errors).toEqual([]);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("warn translates, keeps errors empty and reports findings as diagnostics", async () => {
    const r = await translateProgram(bad, { ...opts, lintMode: "warn" });
    expect(r.errors).toEqual([]);
    expect(r.pythonCode).toBe("print(score)");
    expect(mockFetch).toHaveBeenCalledTimes(1);
    // returned even without includeDiagnostics: they are for the instruction author
    expect(r.diagnosticsDetailed).toEqual([
      expect.objectContaining({ blockId: "b1", line: 1, severity: "warning", code: "LINT_UNDEFINED_VARIABLE" }),
    ]);
    expect(r.diagnostics).toHaveLength(1);
  });

  it("warn with clean instructions adds nothing", async () => {
    const r = await translateProgram([{ id: "b", text: "Let the score be 0.\nPrint the score." }], { ...opts, lintMode: "warn" });
    expect(r.diagnostics).toBeUndefined();
  });

  it("warn plus includeDiagnostics lists lint findings first", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ output: [{ type: "message", content: [{ type: "output_text", text: "print(1)\nprint(2)" }] }] }),
    });
    const r = await translateProgram(bad, { ...opts, lintMode: "warn", includeDiagnostics: true });
    expect(r.diagnosticsDetailed!.map((d) => d.code)).toEqual(["LINT_UNDEFINED_VARIABLE", "DIRECT_EXTRA_PRINTS"]);
  });
});
