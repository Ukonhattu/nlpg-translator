import { DIRECT_C_PROMPT_V1 } from "../../prompts/direct.c.v1.js";
import { createSyntaxChecker } from "../../treeSitterSyntax.js";
import type { Target } from "../types.js";
import { generateC } from "./codegen.js";
import { postProcessDirectC } from "./direct.js";

const syntax = createSyntaxChecker("tree-sitter-c", "tree-sitter-c.wasm");

export const cTarget: Target = {
  id: "c",
  displayName: "C11",
  fileExtension: ".c",
  lineComment: (text) => `// ${text}`,
  generate: (statements, diagnostics) => generateC(statements, diagnostics),
  // One program has one main(); independently translated blocks cannot be joined.
  supportsSeparateBlocks: false,
  direct: {
    languageName: "C",
    outputCallName: "printf()/puts()",
    prompt: () => DIRECT_C_PROMPT_V1,
    postProcess: postProcessDirectC,
    checkSyntax: (code) => syntax.check(code),
  },
};
