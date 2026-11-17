import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  countPrintCalls,
  postProcessDirect,
  scanPython,
  simplifyDeadTernaries,
  stripCodeFences,
  stripPythonComments,
} from "../src/direct.js";
import { translateProgram } from "../src/index.js";
import { checkPythonSyntax } from "../src/pythonSyntax.js";
import { DIRECT_PROMPT_V1 } from "../src/prompts/direct.v1.js";
import { DIRECT_PROMPT_V2 } from "../src/prompts/direct.v2.js";
import { hasPython } from "./helpers/python.js";

describe("string-aware comment stripping (§7.1)", () => {
  it.each([
    ['x = 1  # one', "x = 1"],
    ['s = "a # not a comment"  # real', 's = "a # not a comment"'],
    ["s = 'it\\'s # fine'  # c", "s = 'it\\'s # fine'"],
    ['s = "a\\"#b"', 's = "a\\"#b"'],
    ['s = r"\\"#"', 's = r"\\"#"'],
    ['s = f"{x} # y"  # c', 's = f"{x} # y"'],
    ['s = b"#"', 's = b"#"'],
    ["# only a comment\nx = 1", "x = 1"],
    ["x = 1\n\n\ny = 2", "x = 1\ny = 2"],
    ["  # indented comment\n  x = 1", "  x = 1"],
  ])("%j", (input, expected) => {
    expect(stripPythonComments(input)).toBe(expected);
  });

  it("keeps comment-like text and blank lines inside triple-quoted strings", () => {
    const src = 'doc = """first # keep\n\n\nsecond"""  # drop\nx = 1';
    expect(stripPythonComments(src)).toBe('doc = """first # keep\n\n\nsecond"""\nx = 1');
    const single = "s = '''a\n  # b\n\n'''\ny = 2";
    expect(stripPythonComments(single)).toBe(single);
  });

  it("an unterminated single-quoted string does not swallow the rest", () => {
    expect(stripPythonComments("s = 'oops\nx = 1 # c")).toBe("s = 'oops\nx = 1");
  });

  it("a backslash-continued single-quoted string spans lines", () => {
    const src = "s = 'a \\\n# b'\nx = 1";
    expect(stripPythonComments(src)).toBe(src);
  });

  it.skipIf(!hasPython)("the stripped code has exactly the same Python AST", () => {
    const cases = [
      'x = 1  # c\n\n\ny = "# s"  # d',
      'doc = """a # b\n\n\nc"""  # drop\nprint(doc)',
      "t = '''x\n# y\n\n'''\n",
      's = "a\\"#b"  # c',
      "if True:\n    # c\n    print(1)  # d\n\n    print(2)",
      's = r"\\"#" # c',
    ];
    const script = `
import ast, json, sys
pairs = json.load(sys.stdin)
print(json.dumps([ast.dump(ast.parse(a)) == ast.dump(ast.parse(b)) for a, b in pairs]))
`;
    const pairs = cases.map((c) => [c, stripPythonComments(c)]);
    const r = spawnSync("python3", ["-I", "-c", script], { input: JSON.stringify(pairs), encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual(cases.map(() => true));
  });
});

describe("scanPython and print counting", () => {
  it("marks lines that start inside a string", () => {
    const lines = scanPython('a = """x\ny\n"""\nb = 1');
    expect(lines.map((l) => l.startsInString)).toEqual([false, true, true, false]);
  });

  it("counts real print calls only", () => {
    const code = ['print(1)', 'x = "print(2)"  # print(3)', 'if x: print(4)', 'obj.print(5)', 'sprint(6)', 'print (7)'].join("\n");
    expect(countPrintCalls(code)).toBe(3);
  });
});

describe("post-processing defaults (§7.1, §7.3)", () => {
  it("strips fences and comments, rewrites nothing else", () => {
    const raw = "```python\nx = 1  # c\nprint(\"a if False else b\")\n```";
    expect(postProcessDirect(raw, "Print a").code).toBe('x = 1\nprint("a if False else b")');
  });

  it('"none" removes only code fences', () => {
    const raw = "```python\nx = 1  # keep\n\nprint(x)\n```";
    expect(postProcessDirect(raw, "Print x", "none").code).toBe("x = 1  # keep\n\nprint(x)");
  });

  it("deadTernaries is opt-in", () => {
    const raw = "x = int(input()) if False else int(input())";
    expect(postProcessDirect(raw, "Read x").code).toBe(raw);
    expect(postProcessDirect(raw, "Read x", { deadTernaries: true }).code).toBe("x = int(input())");
    expect(simplifyDeadTernaries(raw)).toBe("x = int(input())");
  });

  it("stripCodeFences trims fence lines", () => {
    expect(stripCodeFences("```py\na\n```")).toBe("a");
  });

  it("reports requested vs emitted prints", () => {
    const p = postProcessDirect("print(1)\nprint(2)", "Print a.\nLet b be 2.");
    expect(p).toMatchObject({ requestedOutputLines: 1, emittedPrints: 2 });
  });
});

describe("pythonSyntax (tree-sitter WASM)", () => {
  it("accepts valid code", async () => {
    expect(await checkPythonSyntax("x = 1\nif x:\n    print(x)\n")).toEqual([]);
  });

  it("reports the line of a syntax error", async () => {
    const problems = await checkPythonSyntax("x = 1\nif x\n    print(x)\n");
    expect(problems).not.toBeNull();
    expect(problems!.length).toBeGreaterThan(0);
    expect(problems![0].line).toBeGreaterThanOrEqual(2);
  });

  it("limits the number of reported problems", async () => {
    const bad = Array.from({ length: 20 }, (_v, i) => `x${i} = (`).join("\n");
    expect((await checkPythonSyntax(bad, 3))!.length).toBeLessThanOrEqual(3);
  });
});

// --- translateProgram in direct mode ------------------------------------------

const mockFetch = vi.fn();
const opts = { aaltoApiKey: "k", endpoint: "https://d.example/r", model: "m" };
const reply = (text: string) => ({
  ok: true,
  json: async () => ({ output: [{ type: "message", content: [{ type: "output_text", text }] }] }),
});
const bodyOf = (i = 0) => JSON.parse((mockFetch.mock.calls[i][1] as RequestInit).body as string);

beforeEach(() => {
  mockFetch.mockReset();
  vi.stubGlobal("fetch", (...a: unknown[]) => mockFetch(...a));
});
afterEach(() => vi.unstubAllGlobals());

describe("direct mode via translateProgram", () => {
  it("DIRECT_EXTRA_PRINTS warns instead of deleting lines, even with strictOutputFidelity", async () => {
    mockFetch.mockResolvedValue(reply("score = 1\nprint(score)\nprint(\"done\")"));
    const r = await translateProgram([{ id: "b", text: "Let score be 1.\nPrint the score." }], {
      ...opts, strictOutputFidelity: true, includeDiagnostics: true,
    });
    expect(r.pythonCode).toBe('score = 1\nprint(score)\nprint("done")');
    expect(r.diagnosticsDetailed).toEqual([
      expect.objectContaining({ blockId: "b", severity: "warning", code: "DIRECT_EXTRA_PRINTS" }),
    ]);
    expect(r.status).toBe("ok");
  });

  it("no warning when the prints match the request", async () => {
    mockFetch.mockResolvedValue(reply("score = 1\nprint(score)"));
    const r = await translateProgram([{ id: "b", text: "Let score be 1.\nPrint the score." }], { ...opts, includeDiagnostics: true });
    expect(r.diagnostics).toBeUndefined();
  });

  it("a syntax error makes the block partial and leaves the code unchanged", async () => {
    mockFetch.mockResolvedValue(reply("x = 1\nif x\n    print(x)"));
    const r = await translateProgram([{ id: "b", text: "Let x be 1. If x, print x." }], { ...opts, includeDiagnostics: true });
    expect(r.pythonCode).toBe("x = 1\nif x\n    print(x)");
    expect(r.status).toBe("partial");
    const d = r.diagnosticsDetailed!.find((x) => x.code === "DIRECT_SYNTAX_ERROR");
    expect(d).toMatchObject({ severity: "error", blockId: "b" });
    expect(d!.line).toBeGreaterThanOrEqual(2);
  });

  it("directParseCheck: false skips the parser", async () => {
    mockFetch.mockResolvedValue(reply("if x\n  print("));
    const r = await translateProgram([{ id: "b", text: "x" }], { ...opts, directParseCheck: false });
    expect(r.status).toBe("ok");
  });

  it('directPostProcess "none" keeps comments (baseline mode)', async () => {
    mockFetch.mockResolvedValue(reply("```python\nx = 1  # note\n```"));
    const r = await translateProgram([{ id: "b", text: "Let x be 1." }], { ...opts, directPostProcess: "none" });
    expect(r.pythonCode).toBe("x = 1  # note");
  });

  it("v2 prompt by default, v1 on request", async () => {
    mockFetch.mockResolvedValue(reply("x = 1"));
    await translateProgram([{ id: "b", text: "Let x be 1." }], opts);
    expect(bodyOf(0).input[0].content).toBe(DIRECT_PROMPT_V2.text);
    await translateProgram([{ id: "b", text: "Let x be 1." }], { ...opts, promptVersion: "v1" });
    expect(bodyOf(1).input[0].content).toBe(DIRECT_PROMPT_V1.text);
  });

  it("v2 drops the no-functions restriction and lists the AST course constructs", () => {
    expect(DIRECT_PROMPT_V1.text).toMatch(/global variables rather than defining functions/);
    expect(DIRECT_PROMPT_V2.text).not.toMatch(/rather than defining functions/);
    for (const construct of ["def/return/call", "try/except", "f-strings", "tuple unpack return"]) {
      expect(DIRECT_PROMPT_V2.text).toContain(construct);
    }
    expect(DIRECT_PROMPT_V1.id).toBe("direct.v1");
    expect(DIRECT_PROMPT_V2.id).toBe("direct.v2");
  });

  it("defaults reasoning effort to low (D5), overridable", async () => {
    mockFetch.mockResolvedValue(reply("x = 1"));
    await translateProgram([{ id: "b", text: "Let x be 1." }], opts);
    expect(bodyOf(0).reasoning).toEqual({ effort: "low" });
    await translateProgram([{ id: "b", text: "Let x be 1." }], { ...opts, reasoningEffort: "high" });
    expect(bodyOf(1).reasoning).toEqual({ effort: "high" });
  });
});
