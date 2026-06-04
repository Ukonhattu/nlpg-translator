import { expect } from "vitest";
import type { TranslateOptions } from "../../src/index.js";

export const hasApiKey = Boolean(process.env.AALTO_API_KEY?.trim());
export const hasGatewayApiKey = Boolean(
  process.env.LLM_GATEWAY_API_KEY?.trim()
);

/** Shared options for live Azure Responses API tests (requires AALTO_API_KEY). */
export function integrationOptions(
  overrides: Partial<TranslateOptions> = {}
): TranslateOptions {
  const key = process.env.AALTO_API_KEY?.trim();
  if (!key) {
    throw new Error("AALTO_API_KEY is required for integration tests");
  }
  return {
    aaltoApiKey: key,
    endpoint: process.env.AALTO_ENDPOINT,
    model: process.env.AALTO_MODEL,
    reasoningEffort: "low",
    llmApi: "azure",
    ...overrides,
  };
}

/** Options for live k8s gateway Responses API tests (requires LLM_GATEWAY_API_KEY). */
export function gatewayIntegrationOptions(
  overrides: Partial<TranslateOptions> = {}
): TranslateOptions {
  const key = process.env.LLM_GATEWAY_API_KEY?.trim();
  if (!key) {
    throw new Error("LLM_GATEWAY_API_KEY is required for gateway integration tests");
  }
  return {
    llmApi: "gateway",
    gatewayApiKey: key,
    endpoint: process.env.LLM_GATEWAY_RESPONSES_ENDPOINT,
    model: process.env.LLM_GATEWAY_MODEL,
    reasoningEffort: "low",
    ...overrides,
  };
}

/** Python should not contain markdown fences from the model. */
export function expectCleanPython(code: string): void {
  expect(code.trim().length).toBeGreaterThan(0);
  expect(code).not.toMatch(/```/);
}

export function expectPatterns(
  code: string,
  patterns: RegExp[],
  antipatterns: RegExp[] = []
): void {
  for (const pattern of patterns) {
    expect(code).toMatch(pattern);
  }
  for (const anti of antipatterns) {
    expect(code).not.toMatch(anti);
  }
}
