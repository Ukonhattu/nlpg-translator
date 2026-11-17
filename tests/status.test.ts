import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_AST_DEPTH, verifyProgram } from "../src/ast.js";
import { translateProgram } from "../src/index.js";
import { extractResponseText, LlmResponseError } from "../src/translator.js";

const mockFetch = vi.fn();
const opts = { aaltoApiKey: "k", endpoint: "https://x.example/r", model: "m" };

const message = (...texts: string[]) => ({
  type: "message",
  content: texts.map((text) => ({ type: "output_text", text })),
});
const respond = (data: object) => ({ ok: true, json: async () => data });
const astResponse = (stmts: object[]) =>
  respond({ output: [message(JSON.stringify({ statements: stmts }))] });

beforeEach(() => {
  mockFetch.mockReset();
  vi.stubGlobal("fetch", (...a: unknown[]) => mockFetch(...a));
});
afterEach(() => vi.unstubAllGlobals());

describe("extractResponseText (§3.4)", () => {
  it("concatenates all output_text parts of all messages", () => {
    expect(
      extractResponseText({
        output: [
          { type: "reasoning", summary: [] },
          message("a = ", "1"),
          message("print(a)"),
        ],
      })
    ).toBe("a = 1\nprint(a)");
  });

  it("throws incomplete_response for status=incomplete, even with partial text", () => {
    const err = catchError(() =>
      extractResponseText({
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
        output: [message("partial")],
      })
    );
    expect(err).toBeInstanceOf(LlmResponseError);
    expect((err as LlmResponseError).reason).toBe("incomplete_response");
    expect((err as Error).message).toContain("max_output_tokens");
  });

  it("throws empty_response for no text and never dumps the JSON", () => {
    const err = catchError(() => extractResponseText({ output: [], secret: "abc123" }));
    expect((err as LlmResponseError).reason).toBe("empty_response");
    expect((err as Error).message).not.toContain("abc123");
  });

  it("reports refusals as empty_response", () => {
    const err = catchError(() =>
      extractResponseText({
        output: [{ type: "message", content: [{ type: "refusal", refusal: "no" }] }],
      })
    );
    expect((err as LlmResponseError).reason).toBe("empty_response");
    expect((err as Error).message).toMatch(/refused/);
  });
});

function catchError(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new Error("expected a throw");
}

describe("verification robustness (§3.1)", () => {
  it("skips non-object nodes with diagnostics and counts them as dropped", () => {
    const r = verifyProgram(
      { statements: [null, 5, "x", [], { kind: "break", line: 1 }] },
      "break"
    );
    expect(r.statements).toHaveLength(1);
    expect(r.droppedNodes).toBe(4);
    expect(r.diagnosticsDetailed.filter((d) => d.code === "INVALID_STEP")).toHaveLength(4);
  });

  it("treats a non-array statement list as empty", () => {
    const r = verifyProgram({ statements: "nope" }, "x");
    expect(r.statements).toEqual([]);
    expect(r.diagnosticsDetailed[0].code).toBe("INVALID_PROGRAM");
  });

  it("drops subtrees nested deeper than the limit", () => {
    let node: any = { kind: "break", line: 1 };
    for (let i = 0; i < MAX_AST_DEPTH + 5; i++) {
      node = { kind: "while", test: { kind: "bool", value: true }, body: [node], line: 1 };
    }
    const r = verifyProgram({ statements: [node] }, "while");
    expect(r.diagnosticsDetailed.some((d) => d.code === "DEPTH_LIMIT")).toBe(true);
    expect(r.droppedNodes).toBeGreaterThan(0);
  });

  it("rejects absurdly deep expressions instead of overflowing the stack", () => {
    let e: any = { kind: "num", value: 1 };
    for (let i = 0; i < 5000; i++) e = { kind: "not", value: e };
    const r = verifyProgram({ statements: [{ kind: "print", value: e, line: 1 }] }, "print");
    expect(r.statements).toEqual([]);
  });
});

describe("structured diagnostics (§3.2)", () => {
  it("always collects them, with code, severity and line", () => {
    const r = verifyProgram({ statements: [{ kind: "break", line: 9 }] }, "break");
    expect(r.diagnostics).toHaveLength(1);
    expect(r.diagnosticsDetailed[0]).toMatchObject({
      code: "LINE_OUT_OF_RANGE",
      severity: "warning",
      line: 9,
    });
  });

  it("returns them from translateProgram only when includeDiagnostics is set", async () => {
    mockFetch.mockImplementation(async () => astResponse([{ kind: "break", line: 9 }, { kind: "pass", line: 1 }]));
    const quiet = await translateProgram([{ id: "b", text: "pass" }], { ...opts, astMode: true });
    expect(quiet.diagnostics).toBeUndefined();
    expect(quiet.diagnosticsDetailed).toBeUndefined();
    const loud = await translateProgram([{ id: "b", text: "pass" }], {
      ...opts, astMode: true, includeDiagnostics: true,
    });
    expect(loud.diagnostics?.length).toBeGreaterThan(0);
    expect(loud.diagnosticsDetailed?.[0]).toMatchObject({ blockId: "b", code: "LINE_OUT_OF_RANGE" });
  });
});

describe("block status (§3.3)", () => {
  it("ok: fully translated block", async () => {
    mockFetch.mockResolvedValue(
      astResponse([{ kind: "assign", target: "a", value: { kind: "num", value: 1 }, line: 1 }])
    );
    const r = await translateProgram([{ id: "b1", text: "Let a be 1." }], { ...opts, astMode: true });
    expect(r.status).toBe("ok");
    expect(r.blocks).toEqual([
      { id: "b1", status: "ok", code: "a = 1", pythonCode: "a = 1", droppedNodes: 0, unknownNodes: 0 },
    ]);
  });

  it("partial: dropped and unknown nodes are counted", async () => {
    mockFetch.mockResolvedValue(
      astResponse([
        { kind: "assign", target: "a", value: { kind: "num", value: 1 }, line: 1 },
        { kind: "bogus", line: 1 },
        { kind: "unknown", line: 2 },
      ])
    );
    const r = await translateProgram([{ id: "b", text: "Let a be 1.\nDo magic" }], { ...opts, astMode: true });
    expect(r.status).toBe("partial");
    expect(r.blocks![0]).toMatchObject({ status: "partial", droppedNodes: 1, unknownNodes: 1 });
    expect(r.pythonCode).toContain("# unsupported: Do magic");
  });

  it.each([
    ["http_error", () => Promise.resolve({ ok: false, status: 500, text: async () => "boom-body" })],
    ["timeout", () => Promise.reject(Object.assign(new Error("t"), { name: "TimeoutError" }))],
    ["incomplete_response", () => Promise.resolve(respond({ status: "incomplete", output: [] }))],
    ["empty_response", () => Promise.resolve(respond({ output: [] }))],
    ["parse_error", () => Promise.resolve(respond({ output: [message("not json at all")] }))],
  ])("failed (%s): marker, status and no upstream body in diagnostics", async (reason, impl) => {
    mockFetch.mockImplementation(impl);
    const r = await translateProgram([{ id: "b1", text: "Let a be 1." }], {
      ...opts, astMode: true, includeDiagnostics: true,
    });
    expect(r.status).toBe("failed");
    expect(r.blocks![0]).toMatchObject({ status: "failed", failureReason: reason, pythonCode: "" });
    expect(r.pythonCode).toBe("# [block b1: translation failed]");
    expect(JSON.stringify(r.diagnosticsDetailed)).not.toContain("boom-body");
    expect(r.diagnosticsDetailed![0].severity).toBe("error");
  });

  it("zero usable statements for non-empty text is a failed block", async () => {
    mockFetch.mockResolvedValue(astResponse([{ kind: "bogus", line: 1 }]));
    const r = await translateProgram([{ id: "b", text: "Let a be 1." }], { ...opts, astMode: true });
    expect(r.blocks![0]).toMatchObject({ status: "failed", failureReason: "empty_response", droppedNodes: 1 });
  });

  it("failedBlockMarker: false leaves no marker", async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500, text: async () => "x" });
    const r = await translateProgram([{ id: "b", text: "Let a be 1." }], {
      ...opts, failedBlockMarker: false,
    });
    expect(r.pythonCode).toBe("");
    expect(r.status).toBe("failed");
  });

  it("separateBlocks: one failure does not lose the other block", async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: false, status: 503, text: async () => "down" })
      .mockResolvedValueOnce(respond({ output: [message("b = 2")] }));
    const r = await translateProgram(
      [{ id: "one", text: "Let a be 1." }, { id: "two", text: "Let b be 2." }],
      { ...opts, separateBlocks: true }
    );
    expect(r.status).toBe("failed");
    expect(r.blocks!.map((b) => b.status)).toEqual(["failed", "ok"]);
    expect(r.pythonCode).toBe("# [block one: translation failed]\n\nb = 2");
  });

  it("direct mode: multi-part text is concatenated and ok", async () => {
    mockFetch.mockResolvedValue(respond({ output: [message("x = ", "5")] }));
    const r = await translateProgram([{ id: "b", text: "Let x be 5." }], opts);
    expect(r).toMatchObject({ pythonCode: "x = 5", status: "ok" });
  });

  it("direct mode: empty text fails instead of returning a JSON dump", async () => {
    mockFetch.mockResolvedValue(respond({ output: [], leak: "zzz" }));
    const r = await translateProgram([{ id: "b", text: "Let x be 5." }], opts);
    expect(r.status).toBe("failed");
    expect(r.pythonCode).not.toContain("zzz");
  });

  it("throwOnFailure rethrows the original error only when every block failed", async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500, text: async () => "x" });
    await expect(
      translateProgram([{ id: "b", text: "t" }], { ...opts, throwOnFailure: true })
    ).rejects.toMatchObject({ name: "LlmHttpError", status: 500 });

    mockFetch
      .mockResolvedValueOnce({ ok: false, status: 500, text: async () => "x" })
      .mockResolvedValueOnce(respond({ output: [message("b = 2")] }));
    const r = await translateProgram(
      [{ id: "1", text: "t" }, { id: "2", text: "u" }],
      { ...opts, separateBlocks: true, throwOnFailure: true }
    );
    expect(r.status).toBe("failed");
  });

  it("programming errors are not swallowed as block failures", async () => {
    mockFetch.mockRejectedValue(new RangeError("bug"));
    await expect(translateProgram([{ id: "b", text: "t" }], opts)).rejects.toThrow("bug");
  });
});
