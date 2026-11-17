import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PACKAGE_VERSION, translateProgram, type TraceRecord } from "../src/index.js";
import { getPrompt, sha256Hex } from "../src/prompts/index.js";

const mockFetch = vi.fn();
const SECRET = "super-secret-key-123";
const opts = {
  aaltoApiKey: SECRET,
  endpoint: "https://llm.example.org/v1/responses?api-version=2025&token=abc",
  model: "test-model",
};
const source = "Let the score be 10.\nPrint the score.";
const blocks = [{ id: "b1", text: source }];

const reply = (text: string, extra: object = {}) => ({
  ok: true,
  json: async () => ({
    status: "completed",
    usage: { input_tokens: 11, output_tokens: 7 },
    output: [{ type: "message", content: [{ type: "output_text", text }] }],
    ...extra,
  }),
});
const astText = JSON.stringify({
  statements: [
    { kind: "assign", target: "score", value: { kind: "num", value: 10 }, line: 1, evidence: "Let the score be 10" },
    { kind: "print", value: { kind: "var", name: "score" }, line: 2, evidence: "Print the score", outputCue: "Print" },
  ],
});

function collect() {
  const records: TraceRecord[] = [];
  return { records, trace: (r: TraceRecord) => records.push(r) };
}

beforeEach(() => {
  mockFetch.mockReset();
  vi.stubGlobal("fetch", (...a: unknown[]) => mockFetch(...a));
});
afterEach(() => vi.unstubAllGlobals());

describe("trace hook (§9.1)", () => {
  it("emits one llm_call and one block_result record in direct mode", async () => {
    mockFetch.mockResolvedValue(reply("score = 10\nprint(score)"));
    const { records, trace } = collect();
    await translateProgram(blocks, { ...opts, trace });
    expect(records.map((r) => r.event)).toEqual(["llm_call", "block_result"]);

    const [call, result] = records;
    const prompt = getPrompt("direct.v2");
    expect(call).toMatchObject({
      packageVersion: PACKAGE_VERSION,
      blockId: "b1",
      mode: "direct",
      promptId: "direct.v2",
      promptSha256: prompt.sha256,
      llmApi: "azure",
      endpointHost: "llm.example.org",
      model: "test-model",
      reasoningEffort: "low",
      inputSha256: sha256Hex(source),
      responseStatus: "completed",
      usage: { input_tokens: 11, output_tokens: 7 },
    });
    expect(call.durationMs).toBeGreaterThanOrEqual(0);
    expect(new Date(call.ts).toISOString()).toBe(call.ts);
    expect(result).toMatchObject({ status: "ok", mode: "direct", promptId: "direct.v2" });
    expect(call.requestId).toBeTruthy();
    expect(result.requestId).toBe(call.requestId);
  });

  it("never contains API keys or the full endpoint URL", async () => {
    mockFetch.mockResolvedValue(reply("score = 10"));
    const { records, trace } = collect();
    await translateProgram(blocks, { ...opts, trace, traceIncludeInput: true });
    const dump = JSON.stringify(records);
    expect(dump).not.toContain(SECRET);
    expect(dump).not.toContain("api-version");
    expect(dump).not.toContain("token=abc");
    expect(dump).not.toContain("/v1/responses");
  });

  it("omits student-derived text by default (D8)", async () => {
    mockFetch.mockResolvedValue(reply("score = 10\nprint(score)\nprint(1)"));
    const { records, trace } = collect();
    await translateProgram(blocks, { ...opts, trace });
    const dump = JSON.stringify(records);
    expect(dump).not.toContain("Let the score");
    expect(dump).not.toContain("score = 10");
    for (const r of records) {
      expect(r).not.toHaveProperty("inputText");
      expect(r).not.toHaveProperty("rawOutputText");
      expect(r).not.toHaveProperty("finalCode");
    }
    const result = records.find((r) => r.event === "block_result")!;
    // diagnostics keep code/line/severity but lose their (source-quoting) messages
    expect(result.diagnostics![0]).toMatchObject({ code: "DIRECT_EXTRA_PRINTS", severity: "warning" });
    expect(result.diagnostics![0]).not.toHaveProperty("message");
  });

  it("traceIncludeInput adds input, raw output, final code and messages", async () => {
    mockFetch.mockResolvedValue(reply("score = 10\nprint(score)\nprint(1)"));
    const { records, trace } = collect();
    await translateProgram(blocks, { ...opts, trace, traceIncludeInput: true });
    const [call, result] = records;
    expect(call).toMatchObject({ inputText: source, rawOutputText: "score = 10\nprint(score)\nprint(1)" });
    expect(result).toMatchObject({ inputText: source, finalCode: "score = 10\nprint(score)\nprint(1)" });
    expect(result.diagnostics![0].message).toMatch(/print\(\)/);
  });

  it("AST mode: per-sample llm_call records with sampleIndex, schema version and structured output", async () => {
    mockFetch.mockResolvedValue(reply(astText));
    const { records, trace } = collect();
    await translateProgram(blocks, { ...opts, astMode: true, samples: 3, trace });
    const calls = records.filter((r) => r.event === "llm_call");
    expect(calls.map((r) => r.sampleIndex).sort()).toEqual([0, 1, 2]);
    for (const c of calls) {
      expect(c).toMatchObject({ mode: "ast", promptId: "ast.v2", astSchemaVersion: 2, structuredOutput: "on" });
      expect(c.promptSha256).toBe(getPrompt("ast.v2").sha256);
    }
    const results = records.filter((r) => r.event === "block_result");
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ status: "ok", mode: "ast", astSchemaVersion: 2 });
    expect(new Set(records.map((r) => r.requestId)).size).toBe(1);
  });

  it("records the effective temperature: gateway only", async () => {
    mockFetch.mockResolvedValue(reply("x = 1"));
    const az = collect();
    await translateProgram(blocks, { ...opts, temperature: 0.5, trace: az.trace });
    expect(az.records[0].temperature).toBeUndefined();
    const gw = collect();
    await translateProgram(blocks, {
      llmApi: "gateway", gatewayApiKey: "g", endpoint: "https://gw.example/r", model: "q",
      temperature: 0.5, trace: gw.trace,
    });
    expect(gw.records[0]).toMatchObject({ llmApi: "gateway", temperature: 0.5 });
  });

  it("failed calls are traced with a reason code and no upstream body", async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 503, text: async () => "UPSTREAM-SECRET-BODY" });
    const { records, trace } = collect();
    const r = await translateProgram(blocks, { ...opts, trace });
    expect(r.status).toBe("failed");
    expect(records.map((x) => [x.event, x.error])).toEqual([
      ["llm_call", "http_error"],
      ["block_result", "http_error"],
    ]);
    expect(JSON.stringify(records)).not.toContain("UPSTREAM-SECRET-BODY");
    expect(records[1].status).toBe("failed");
  });

  it("an incomplete response keeps its provider status and usage", async () => {
    mockFetch.mockResolvedValue(reply("x", { status: "incomplete" }));
    const { records, trace } = collect();
    await translateProgram(blocks, { ...opts, trace });
    expect(records[0]).toMatchObject({ responseStatus: "incomplete", error: "incomplete_response" });
    expect(records[0].usage).toEqual({ input_tokens: 11, output_tokens: 7 });
  });

  it("a requestId you pass is used", async () => {
    mockFetch.mockResolvedValue(reply("x = 1"));
    const { records, trace } = collect();
    await translateProgram(blocks, { ...opts, trace, requestId: "req-42" });
    expect(records.every((r) => r.requestId === "req-42")).toBe(true);
  });

  it("an exception in the trace callback never breaks translation", async () => {
    mockFetch.mockResolvedValue(reply("x = 1"));
    const r = await translateProgram(blocks, {
      ...opts,
      trace: () => {
        throw new Error("boom");
      },
    });
    expect(r.pythonCode).toBe("x = 1");
  });

  it("without a trace callback nothing is computed or emitted", async () => {
    mockFetch.mockResolvedValue(reply("x = 1"));
    const r = await translateProgram(blocks, opts);
    expect(r.status).toBe("ok");
  });
});

describe("CLI --trace (§9.2)", () => {
  const cli = join(import.meta.dirname, "..", "bin", "nlp2py.mjs");
  const built = existsSync(join(import.meta.dirname, "..", "dist", "cli.js"));

  async function runCli(extraArgs: string[]) {
    const server = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({
          status: "completed",
          output: [{ type: "message", content: [{ type: "output_text", text: "x = 1" }] }],
        }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    const dir = mkdtempSync(join(tmpdir(), "nlp2py-trace-"));
    const input = join(dir, "in.nl");
    const traceFile = join(dir, "trace.jsonl");
    await import("node:fs").then((fs) => fs.writeFileSync(input, "Let x be 1.\n"));
    try {
      const child = spawn(
        process.execPath,
        [cli, input, "--endpoint", `http://127.0.0.1:${port}/v1/responses`, "--trace", traceFile, ...extraArgs],
        { env: { ...process.env, AALTO_API_KEY: SECRET }, stdio: ["ignore", "pipe", "pipe"] }
      );
      let stderr = "";
      child.stderr.on("data", (d) => (stderr += d));
      const code = await new Promise<number>((r) => child.on("close", (c) => r(c ?? -1)));
      const lines = existsSync(traceFile)
        ? readFileSync(traceFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
        : [];
      return { code, stderr, lines };
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it.skipIf(!built)("appends one JSON line per record and hides input by default", async () => {
    const { code, stderr, lines } = await runCli([]);
    expect(code, stderr).toBe(0);
    expect(lines.map((l) => l.event)).toEqual(["llm_call", "block_result"]);
    expect(lines[0].endpointHost).toMatch(/^127\.0\.0\.1:\d+$/);
    expect(JSON.stringify(lines)).not.toContain(SECRET);
    expect(JSON.stringify(lines)).not.toContain("Let x be 1");
  });

  it.skipIf(!built)("--trace-include-input adds the text", async () => {
    const { code, lines } = await runCli(["--trace-include-input"]);
    expect(code).toBe(0);
    expect(lines[0].inputText).toContain("Let x be 1");
  });
});
