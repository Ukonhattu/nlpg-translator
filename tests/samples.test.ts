import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { translateProgram } from "../src/index.js";

const mockFetch = vi.fn();
const source = "Let the score be 10.\nPrint the score.";
const blocks = [{ id: "b", text: source }];
const azure = { aaltoApiKey: "k", endpoint: "https://a.example/r", model: "m", astMode: true as const, includeDiagnostics: true };
const gateway = { llmApi: "gateway" as const, gatewayApiKey: "g", endpoint: "https://g.example/r", model: "q", astMode: true as const };

const program = (value: number) => ({
  statements: [
    { kind: "assign", target: "score", value: { kind: "num", value }, line: 1, evidence: "Let the score be 10" },
    { kind: "print", value: { kind: "var", name: "score" }, line: 2, evidence: "Print the score", outputCue: "Print" },
  ],
});
const reply = (obj: object) => ({
  ok: true,
  json: async () => ({ output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(obj) }] }] }),
});
const bodyOf = (i: number) => JSON.parse((mockFetch.mock.calls[i][1] as RequestInit).body as string);

beforeEach(() => {
  mockFetch.mockReset();
  vi.stubGlobal("fetch", (...a: unknown[]) => mockFetch(...a));
});
afterEach(() => vi.unstubAllGlobals());

describe("samples", () => {
  it("samples: 1 (default) behaves as before: one call, no consistency field", async () => {
    mockFetch.mockResolvedValue(reply(program(10)));
    const r = await translateProgram(blocks, azure);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(r.consistency).toBeUndefined();
    expect(r.pythonCode).toBe("score = 10\nprint(score)");
    const explicit = await translateProgram(blocks, { ...azure, samples: 1 });
    expect(explicit.pythonCode).toBe(r.pythonCode);
    expect(explicit.consistency).toBeUndefined();
  });

  it("majority selection with scripted variants, agreement and disagreeing lines", async () => {
    mockFetch
      .mockResolvedValueOnce(reply(program(10)))
      .mockResolvedValueOnce(reply(program(9)))
      .mockResolvedValueOnce(reply(program(10)));
    const r = await translateProgram(blocks, { ...azure, samples: 3 });
    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(r.pythonCode).toBe("score = 10\nprint(score)");
    expect(r.consistency).toEqual({
      samples: 3,
      agreement: 2 / 3,
      disagreeingLines: [{ blockId: "b", line: 1, variants: 2 }],
    });
    const d = r.diagnosticsDetailed!.filter((x) => x.code === "CONSISTENCY_DISAGREEMENT");
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ blockId: "b", line: 1, severity: "warning" });
  });

  it("full agreement: agreement 1, no disagreement diagnostics", async () => {
    mockFetch.mockResolvedValue(reply(program(10)));
    const r = await translateProgram(blocks, { ...azure, samples: 3 });
    expect(r.consistency).toEqual({ samples: 3, agreement: 1, disagreeingLines: [] });
    expect((r.diagnosticsDetailed ?? []).some((x) => x.code === "CONSISTENCY_DISAGREEMENT")).toBe(false);
  });

  it("a tie goes to the sample with fewer grounding warnings", async () => {
    // sample 0 invents 99 (literal not on the line) -> warnings; sample 1 is clean
    const noisy = program(99);
    mockFetch.mockResolvedValueOnce(reply(noisy)).mockResolvedValueOnce(reply(program(10)));
    const r = await translateProgram(blocks, { ...azure, samples: 2 });
    expect(r.pythonCode).toBe("score = 10\nprint(score)");
    expect(r.consistency!.agreement).toBe(0.5);
  });

  it("failed samples are ignored (and noted); all failing makes the block fail", async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: false, status: 500, text: async () => "x" })
      .mockResolvedValueOnce(reply(program(10)))
      .mockResolvedValueOnce(reply(program(10)));
    const r = await translateProgram(blocks, { ...azure, samples: 3 });
    expect(r.status).toBe("ok");
    expect(r.consistency!.agreement).toBe(2 / 3);
    expect(r.diagnosticsDetailed!.some((x) => x.code === "SAMPLE_FAILED")).toBe(true);

    mockFetch.mockReset();
    mockFetch.mockResolvedValue({ ok: false, status: 500, text: async () => "x" });
    const all = await translateProgram(blocks, { ...azure, samples: 3 });
    expect(all.status).toBe("failed");
    expect(all.blocks![0].failureReason).toBe("http_error");
  });

  it("runs at most 4 samples concurrently", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    mockFetch.mockImplementation(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 15));
      inFlight--;
      return reply(program(10));
    });
    await translateProgram(blocks, { ...azure, samples: 7 });
    expect(mockFetch).toHaveBeenCalledTimes(7);
    expect(maxInFlight).toBe(4);
  });

  it("each sample is verified independently (a bad sample cannot win by being first)", async () => {
    mockFetch
      .mockResolvedValueOnce(reply({ statements: [null, { kind: "bogus", line: 1 }] }))
      .mockResolvedValueOnce(reply(program(10)))
      .mockResolvedValueOnce(reply(program(10)));
    const r = await translateProgram(blocks, { ...azure, samples: 3 });
    expect(r.pythonCode).toBe("score = 10\nprint(score)");
    expect(r.blocks![0]).toMatchObject({ status: "ok", droppedNodes: 0 });
  });

  it("is ignored in direct mode", async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ output: [{ type: "message", content: [{ type: "output_text", text: "x = 1" }] }] }) });
    const r = await translateProgram(blocks, { ...azure, astMode: false, samples: 5 });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(r.consistency).toBeUndefined();
  });

  it.each([0, 8, 1.5, -1, NaN])("rejects samples=%s", async (samples) => {
    await expect(translateProgram(blocks, { ...azure, samples })).rejects.toThrow(RangeError);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("aggregates agreement across blocks with separateBlocks", async () => {
    mockFetch
      // block one: 2 agree, 1 differs; block two: all agree
      .mockResolvedValueOnce(reply(program(10)))
      .mockResolvedValueOnce(reply(program(10)))
      .mockResolvedValueOnce(reply(program(9)))
      .mockResolvedValue(reply(program(10)));
    const r = await translateProgram(
      [{ id: "one", text: source }, { id: "two", text: source }],
      { ...azure, samples: 3, separateBlocks: true }
    );
    expect(r.consistency!.agreement).toBeCloseTo((2 / 3 + 1) / 2);
    expect(r.consistency!.disagreeingLines).toEqual([{ blockId: "one", line: 1, variants: 2 }]);
  });
});

describe("temperature (§6.5)", () => {
  it("is never sent to azure, even when set", async () => {
    mockFetch.mockResolvedValue(reply(program(10)));
    await translateProgram(blocks, { ...azure, temperature: 0.7 });
    expect(bodyOf(0).temperature).toBeUndefined();
  });

  it("is sent to the gateway only when set", async () => {
    mockFetch.mockResolvedValue(reply(program(10)));
    await translateProgram(blocks, gateway);
    expect(bodyOf(0).temperature).toBeUndefined();
    await translateProgram(blocks, { ...gateway, temperature: 0.8 });
    expect(bodyOf(1).temperature).toBe(0.8);
  });
});
