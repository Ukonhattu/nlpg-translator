/**
 * Runtime syntax checks with tree-sitter compiled to WASM (web-tree-sitter +
 * a grammar package's bundled .wasm; no native build). Each grammar is loaded
 * lazily on first use, so importing the library costs nothing.
 *
 * tree-sitter is error-tolerant, so the reported line is where recovery
 * happened, not necessarily where the mistake is.
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

export type SyntaxChecker = {
  /** True when the WASM parser could be loaded in this environment. */
  available(): Promise<boolean>;
  /** Problems found (empty array = parses), or `null` when the parser is unavailable. */
  check(code: string, maxProblems?: number): Promise<SyntaxProblem[] | null>;
};

let initPromise: Promise<void> | null = null;

async function loadParser(packageName: string, wasmFile: string): Promise<Parser | null> {
  try {
    const { Parser, Language } = await import("web-tree-sitter");
    initPromise ??= Parser.init();
    await initPromise;
    const require = createRequire(import.meta.url);
    const wasm = path.join(path.dirname(require.resolve(`${packageName}/package.json`)), wasmFile);
    const language = await Language.load(wasm);
    const parser = new Parser();
    parser.setLanguage(language);
    return parser as unknown as Parser;
  } catch {
    return null;
  }
}

export function createSyntaxChecker(packageName: string, wasmFile: string): SyntaxChecker {
  let parserPromise: Promise<Parser | null> | null = null;
  const parser = () => (parserPromise ??= loadParser(packageName, wasmFile));

  return {
    async available() {
      return (await parser()) !== null;
    },
    async check(code, maxProblems = 5) {
      const p = await parser();
      if (!p) return null;
      const tree = p.parse(code);
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
    },
  };
}
