/** Target selection through the library, direct mode and the HTTP server. */
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { translateProgram } from "../src/index.js";
import { createApp } from "../src/server.js";
import { getTarget, listTargets } from "../src/targets/registry.js";
import { countCOutputCalls, postProcessDirectC, stripCComments } from "../src/targets/c/direct.js";
import { getPrompt } from "../src/prompts/index.js";
import { assertCompiles } from "./helpers/c.js";

const mockFetch = vi.fn();
const opts = { aaltoApiKey: "k", endpoint: "https://x.example/r", model: "m" };
const respondText = (text: string) => ({
  ok: true,
  json: async () => ({ output: [{ type: "message", content: [{ type: "output_text", text }] }] }),
});
const astResponse = (statements: object[]) => respondText(JSON.stringify({ statements }));

const SOURCE = "Let the total be 0.\nAdd 5 to the total.\nPrint the total.";
const AST = [
  { kind: "assign", target: "total", value: { kind: "num", value: 0 }, line: 1, evidence: "Let the total be 0" },
  { kind: "augassign", target: "total", op: "+", value: { kind: "num", value: 5 }, line: 2, evidence: "Add 5 to the total" },
  { kind: "print", value: { kind: "var", name: "total" }, line: 3, evidence: "Print the total", outputCue: "Print" },
];

beforeEach(() => {
  mockFetch.mockReset();
  vi.stubGlobal("fetch", (...a: unknown[]) => mockFetch(...a));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const sentBody = (call = 0) => JSON.parse(mockFetch.mock.calls[call][1].body);

describe("target registry", () => {
  it("lists python and c, defaults to python, rejects unknown ids", () => {
    expect(listTargets().map((t) => t.id)).toEqual(["python", "c"]);
    expect(getTarget().id).toBe("python");
    expect(() => getTarget("cobol" as never)).toThrow(RangeError);
  });
});

describe("translateProgram with target", () => {
  it("python (default) keeps pythonCode as an alias of code", async () => {
    mockFetch.mockResolvedValue(astResponse(AST));
    const r = await translateProgram([{ id: "b", text: SOURCE }], { ...opts, astMode: true });
    expect(r.target).toBe("python");
    expect(r.code).toBe("total = 0\ntotal = total + 5\nprint(total)");
    expect(r.pythonCode).toBe(r.code);
    expect(r.blocks?.[0].pythonCode).toBe(r.code);
  });

  it("c in AST mode: same model call, C output, no pythonCode", async () => {
    mockFetch.mockResolvedValue(astResponse(AST));
    const r = await translateProgram([{ id: "b", text: SOURCE }], { ...opts, astMode: true, target: "c" });
    expect(sentBody().input[0].content).toBe(getPrompt("ast.v2").text);
    expect(r.target).toBe("c");
    expect(r.status).toBe("ok");
    expect(r.pythonCode).toBeUndefined();
    expect(r.blocks?.[0].code).toBe(r.code);
    expect(r.code).toContain("int total = 0;\n    total = total + 5;\n    printf(\"%d\\n\", total);");
    assertCompiles(r.code);
  });

  it("c: constructs C cannot express make the block partial", async () => {
    mockFetch.mockResolvedValue(
      astResponse([
        { kind: "raise", excType: "ValueError", line: 1, evidence: "Raise a ValueError" },
      ])
    );
    const r = await translateProgram([{ id: "b", text: "Raise a ValueError." }], {
      ...opts,
      astMode: true,
      target: "c",
      includeDiagnostics: true,
    });
    expect(r.status).toBe("partial");
    expect(r.blocks?.[0].unknownNodes).toBe(1);
    expect(r.diagnosticsDetailed?.map((d) => d.code)).toContain("TARGET_UNSUPPORTED");
    expect(r.code).toContain("// unsupported in C: Raise a ValueError.");
  });

  it("c with unsupportedBehavior=fallback asks the model for C directly", async () => {
    mockFetch
      .mockResolvedValueOnce(
        astResponse([{ kind: "raise", excType: "ValueError", line: 1, evidence: "Raise a ValueError" }])
      )
      .mockResolvedValueOnce(respondText('```c\n#include <stdlib.h>\nint main(void) { exit(1); }\n```'));
    const r = await translateProgram([{ id: "b", text: "Raise a ValueError." }], {
      ...opts,
      astMode: true,
      target: "c",
      unsupportedBehavior: "fallback",
    });
    expect(sentBody(1).input[0].content).toBe(getPrompt("direct.c.v1").text);
    expect(sentBody(1).input[1].content).toContain("into C.");
    expect(r.code).toBe("#include <stdlib.h>\nint main(void) { exit(1); }");
  });

  it("c in direct mode uses the C prompt, strips comments and syntax-checks", async () => {
    mockFetch.mockResolvedValue(respondText("int main(void) {\n  // hi\n  int x = ;\n}"));
    const r = await translateProgram([{ id: "b", text: "Let x be 1." }], {
      ...opts,
      target: "c",
      includeDiagnostics: true,
    });
    expect(sentBody().input[0].content).toBe(getPrompt("direct.c.v1").text);
    expect(r.code).not.toContain("// hi");
    expect(r.status).toBe("partial");
    expect(r.diagnosticsDetailed?.map((d) => d.code)).toContain("DIRECT_SYNTAX_ERROR");
  });

  it("marks failed blocks with the target's comment syntax", async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500, text: async () => "boom" });
    const r = await translateProgram([{ id: "b", text: "Print 1." }], { ...opts, target: "c" });
    expect(r.code).toBe("// [block b: translation failed]");
  });

  it("rejects separateBlocks for c and unknown targets", async () => {
    await expect(
      translateProgram([{ id: "b", text: "x" }], { ...opts, target: "c", separateBlocks: true })
    ).rejects.toThrow(/separateBlocks is not supported/);
    await expect(
      translateProgram([{ id: "b", text: "x" }], { ...opts, target: "cobol" as never })
    ).rejects.toThrow(RangeError);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("records the target in trace records", async () => {
    mockFetch.mockResolvedValue(astResponse(AST));
    const records: Array<{ target?: string }> = [];
    await translateProgram([{ id: "b", text: SOURCE }], {
      ...opts,
      astMode: true,
      target: "c",
      trace: (r) => records.push(r),
    });
    expect(records.map((r) => r.target)).toEqual(["c", "c"]);
  });
});

describe("direct-mode C post-processing", () => {
  it("strips line and block comments but not comment-like text in literals", () => {
    const src = [
      '#include <stdio.h>',
      "/* header",
      "   comment */",
      "int main(void) {",
      '    printf("// not a comment /* nor this */\\n"); // real comment',
      "    char c = '\"'; /* x */ int y = 1;",
      "    return 0;",
      "}",
    ].join("\n");
    expect(stripCComments(src)).toBe(
      [
        "#include <stdio.h>",
        "int main(void) {",
        '    printf("// not a comment /* nor this */\\n");',
        "    char c = '\"';   int y = 1;",
        "    return 0;",
        "}",
      ].join("\n")
    );
  });

  it("counts output calls outside literals and comments", () => {
    expect(countCOutputCalls('printf("x"); puts("printf(") ; // printf(\nputchar(1); fprintf(stderr, "")')).toBe(3);
  });

  it("reports requested vs emitted output", () => {
    const r = postProcessDirectC('```c\nint main(void){printf("a");printf("b");}\n```', "Print a.");
    expect(r.code).toBe('int main(void){printf("a");printf("b");}');
    expect(r.requestedOutputLines).toBe(1);
    expect(r.emittedPrints).toBe(2);
  });

  it("checks C syntax with tree-sitter", async () => {
    const check = getTarget("c").direct.checkSyntax;
    expect(await check("int main(void) { return 0; }")).toEqual([]);
    const problems = await check("int main(void) {\n  int x = ;\n}");
    expect(problems?.[0]?.line).toBe(2);
  });
});

const baseEnv = {
  AALTO_API_KEY: "az-key",
  AALTO_ENDPOINT: "https://azure.internal/responses",
  AALTO_MODEL: "env-model",
} as NodeJS.ProcessEnv;

describe("server: target", () => {
  beforeEach(() => vi.spyOn(console, "error").mockImplementation(() => {}));

  it("validates target and returns code + target", async () => {
    mockFetch.mockResolvedValue(astResponse([AST[0]]));
    const app = createApp(baseEnv);
    const blocks = [{ id: "b1", text: "Let the total be 0." }];
    const bad = await request(app).post("/translate").send({ blocks, target: "cobol" });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/target must be one of python, c/);
    const sep = await request(app).post("/translate").send({ blocks, target: "c", separateBlocks: true });
    expect(sep.status).toBe(400);
    expect(mockFetch).not.toHaveBeenCalled();

    const ok = await request(app).post("/translate").send({ blocks, target: "c", astMode: true });
    expect(ok.status).toBe(200);
    expect(ok.body.target).toBe("c");
    expect(ok.body.code).toContain("int main(void)");
    expect(ok.body.pythonCode).toBeUndefined();
  });
});
