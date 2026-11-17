import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { translateProgram } from "../src/index.js";
import { resetStructuredOutputCache } from "../src/translator.js";

const mockFetch = vi.fn();
const ENDPOINT = "https://x.example/responses";
const opts = { aaltoApiKey: "k", endpoint: ENDPOINT, model: "m", astMode: true as const };
const blocks = [{ id: "b", text: "Let a be 1." }];

// Strict-mode style response: optional fields are null.
const strictJson = JSON.stringify({
  statements: [
    {
      kind: "assign",
      target: "a",
      targetExpr: null,
      value: { kind: "num", value: 1, raw: null },
      line: 1,
    },
  ],
});
const okResponse = { ok: true, json: async () => ({ output: [{ type: "message", content: [{ type: "output_text", text: strictJson }] }] }) };
const rejection = (body: string, status = 400) => ({ ok: false, status, text: async () => body });
const bodyOf = (i: number) => JSON.parse((mockFetch.mock.calls[i][1] as RequestInit).body as string);

beforeEach(() => {
  mockFetch.mockReset();
  resetStructuredOutputCache();
  vi.stubGlobal("fetch", (...a: unknown[]) => mockFetch(...a));
});
afterEach(() => vi.unstubAllGlobals());

describe("structured output (§3.3 / Phase 4)", () => {
  it("auto (default): sends the strict json_schema and normalises nulls", async () => {
    mockFetch.mockResolvedValue(okResponse);
    const r = await translateProgram(blocks, opts);
    expect(bodyOf(0).text.format).toMatchObject({ type: "json_schema", name: "nlpg_ast", strict: true });
    expect(r).toMatchObject({ pythonCode: "a = 1", status: "ok" });
  });

  it("off: never sends the schema", async () => {
    mockFetch.mockResolvedValue(okResponse);
    await translateProgram(blocks, { ...opts, structuredOutput: "off" });
    expect(bodyOf(0).text).toBeUndefined();
  });

  it("direct mode never sends a schema", async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ output: [{ type: "message", content: [{ type: "output_text", text: "a = 1" }] }] }) });
    await translateProgram(blocks, { ...opts, astMode: false });
    expect(bodyOf(0).text).toBeUndefined();
  });

  it("auto: retries once without the schema on a schema-related 400 and caches it", async () => {
    mockFetch
      .mockResolvedValueOnce(rejection("Unsupported parameter: text.format json_schema"))
      .mockResolvedValue(okResponse);
    const r = await translateProgram(blocks, { ...opts, includeDiagnostics: true });
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(bodyOf(0).text).toBeDefined();
    expect(bodyOf(1).text).toBeUndefined();
    expect(r.status).toBe("ok");
    expect(r.diagnosticsDetailed?.map((d) => d.code)).toContain("STRUCTURED_OUTPUT_UNSUPPORTED");

    // second translation: no schema, no wasted request
    await translateProgram(blocks, opts);
    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(bodyOf(2).text).toBeUndefined();
  });

  it("auto: the cache is per endpoint", async () => {
    mockFetch
      .mockResolvedValueOnce(rejection("bad schema"))
      .mockResolvedValue(okResponse);
    await translateProgram(blocks, opts);
    await translateProgram(blocks, { ...opts, endpoint: "https://other.example/responses" });
    expect(bodyOf(2).text).toBeDefined();
  });

  it("auto: a 400 unrelated to the schema is not retried", async () => {
    mockFetch.mockResolvedValue(rejection("invalid api key"));
    const r = await translateProgram(blocks, opts);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(r.blocks![0]).toMatchObject({ status: "failed", failureReason: "http_error" });
  });

  it("auto: a 500 mentioning the schema is not retried", async () => {
    mockFetch.mockResolvedValue(rejection("schema compile error", 500));
    await translateProgram(blocks, opts);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("on: never falls back", async () => {
    mockFetch.mockResolvedValue(rejection("Unsupported parameter: text.format"));
    const r = await translateProgram(blocks, { ...opts, structuredOutput: "on" });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(r.blocks![0].failureReason).toBe("http_error");
  });

  it("still accepts fenced, non-schema JSON as a fallback path", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ output: [{ type: "message", content: [{ type: "output_text", text: "```json\n" + strictJson + "\n```" }] }] }),
    });
    const r = await translateProgram(blocks, { ...opts, structuredOutput: "off" });
    expect(r.pythonCode).toBe("a = 1");
  });
});
