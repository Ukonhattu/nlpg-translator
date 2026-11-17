import { generatePython } from "../../codegen.js";
import { postProcessDirect } from "../../direct.js";
import { DIRECT_PROMPT_V1 } from "../../prompts/direct.v1.js";
import { DIRECT_PROMPT_V2 } from "../../prompts/direct.v2.js";
import { checkPythonSyntax } from "../../pythonSyntax.js";
import type { Target } from "../types.js";

export const pythonTarget: Target = {
  id: "python",
  displayName: "Python 3.10",
  fileExtension: ".py",
  lineComment: (text) => `# ${text}`,
  generate(statements, diagnostics) {
    return { code: generatePython(statements, [], diagnostics), unsupportedNodes: 0 };
  },
  supportsSeparateBlocks: true,
  direct: {
    languageName: "Python",
    outputCallName: "print()",
    prompt: (version) => (version === "v1" ? DIRECT_PROMPT_V1 : DIRECT_PROMPT_V2),
    postProcess: postProcessDirect,
    checkSyntax: (code) => checkPythonSyntax(code),
  },
};
