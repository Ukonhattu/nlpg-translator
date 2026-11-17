/**
 * Runtime syntax check for generated Python, using tree-sitter compiled to WASM
 * (web-tree-sitter + the grammar's bundled .wasm; no native build). Loaded
 * lazily on first use, so importing the library costs nothing.
 *
 * Caveats: tree-sitter targets current Python grammar, so it accepts some
 * newer syntax (e.g. PEP 701 f-strings) that Python 3.10 rejects, and it is
 * error-tolerant, so the reported line is where recovery happened.
 */

import { createRequire } from "node:module";
import path from "node:path";

export type SyntaxProblem = { line: number; message: string };

type Parser = {
  parse(source: string): { rootNode: TreeNode; delete?: () => void } | null;
};
type TreeNode = {
  type: string;
  isMissing: boolean;
  hasError: boolean;
  startPosition: { row: number };
  children: TreeNode[];
};

let parserPromise: Promise<Parser | null> | null = null;

async function loadParser(): Promise<Parser | null> {
  try {
    const { Parser, Language } = await import("web-tree-sitter");
    await Parser.init();
    const require = createRequire(import.meta.url);
    const wasm = path.join(
      path.dirname(require.resolve("tree-sitter-python/package.json")),
      "tree-sitter-python.wasm"
    );
    const language = await Language.load(wasm);
    const parser = new Parser();
    parser.setLanguage(language);
    return parser as unknown as Parser;
  } catch {
    return null;
  }
}

/** True when the WASM parser could be loaded in this environment. */
export async function syntaxCheckAvailable(): Promise<boolean> {
  parserPromise ??= loadParser();
  return (await parserPromise) !== null;
}

/**
 * Returns the syntax problems found in `code` (empty array = parses), or
 * `null` when the parser is unavailable.
 */
export async function checkPythonSyntax(
  code: string,
  maxProblems = 5
): Promise<SyntaxProblem[] | null> {
  parserPromise ??= loadParser();
  const parser = await parserPromise;
  if (!parser) return null;

  const tree = parser.parse(code);
  if (!tree) return null;
  const problems: SyntaxProblem[] = [];
  const seen = new Set<number>();
  const visit = (node: TreeNode) => {
    if (problems.length >= maxProblems) return;
    if (node.type === "ERROR" || node.isMissing) {
      const line = node.startPosition.row + 1;
      if (!seen.has(line)) {
        seen.add(line);
        problems.push({
          line,
          message: node.isMissing
            ? `Syntax error near line ${line}: missing ${node.type}.`
            : `Syntax error near line ${line}.`,
        });
      }
    }
    if (node.hasError || node.type === "ERROR") {
      for (const child of node.children) visit(child);
    }
  };
  visit(tree.rootNode);
  tree.delete?.();
  return problems;
}
