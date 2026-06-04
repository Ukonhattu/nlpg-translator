import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { translateProgram } from "../../src/index.js";
import {
  expectCleanPython,
  expectPatterns,
  gatewayIntegrationOptions,
  hasApiKey,
  hasGatewayApiKey,
  integrationOptions,
} from "./helpers.js";

const describeIntegration = hasApiKey ? describe : describe.skip;
const describeGatewayIntegration = hasGatewayApiKey ? describe : describe.skip;

const examplesDir = join(import.meta.dirname, "../../examples");

describeIntegration("translateProgram (live Aalto API)", () => {
  it("AST mode translates examples/example.nl", async () => {
    const text = readFileSync(join(examplesDir, "example.nl"), "utf8");
    const result = await translateProgram(
      [{ id: "example", text }],
      integrationOptions({ astMode: true })
    );

    expect(result.errors).toEqual([]);
    expectCleanPython(result.pythonCode);
    expectPatterns(result.pythonCode, [
      /score\s*=\s*0/,
      /range\s*\(\s*3\s*\)/,
      /print\s*\(/,
      />\s*20/,
    ]);
  });

  it("AST mode translates examples/integration/complex.nl", async () => {
    const text = readFileSync(
      join(examplesDir, "integration/complex.nl"),
      "utf8"
    );
    const result = await translateProgram(
      [{ id: "complex", text }],
      integrationOptions({ astMode: true })
    );

    expect(result.errors).toEqual([]);
    expectCleanPython(result.pythonCode);
    expectPatterns(result.pythonCode, [
      /for \w+ in/,
      /def increment/,
      /if total/,
      /else:/,
      /print\s*\(/,
    ]);
  });

  it("direct mode translates a minimal program", async () => {
    const result = await translateProgram(
      [
        {
          id: "minimal",
          text: "Let the score be 0.\nPrint the score.",
        },
      ],
      integrationOptions()
    );

    expect(result.errors).toEqual([]);
    expectCleanPython(result.pythonCode);
    expectPatterns(result.pythonCode, [/score\s*=\s*0/, /print\s*\(/]);
  });

  it("AST mode handles Finnish output verb (tulosta)", async () => {
    const result = await translateProgram(
      [
        {
          id: "fi",
          text: "Let the score be 5.\nTulosta score.",
        },
      ],
      integrationOptions({ astMode: true })
    );

    expect(result.errors).toEqual([]);
    expectCleanPython(result.pythonCode);
    expect(result.pythonCode).toMatch(/print\s*\(/);
  });
});

describeGatewayIntegration("translateProgram (live k8s gateway responses API)", () => {
  it("AST mode translates a minimal program via gateway responses", async () => {
    const result = await translateProgram(
      [
        {
          id: "minimal",
          text: "Let the score be 0.\nPrint the score.",
        },
      ],
      gatewayIntegrationOptions({ astMode: true })
    );

    expect(result.errors).toEqual([]);
    expectCleanPython(result.pythonCode);
    expectPatterns(result.pythonCode, [/score\s*=\s*0/, /print\s*\(/]);
  });
});
