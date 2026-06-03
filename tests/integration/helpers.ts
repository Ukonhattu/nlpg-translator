import { expect } from "vitest";
import type { TranslateOptions } from "../../src/index.js";

export const hasApiKey = Boolean(process.env.AALTO_API_KEY?.trim());

/** Shared options for live API tests (requires AALTO_API_KEY). */
export function integrationOptions(
  overrides: Partial<TranslateOptions> = {}
): TranslateOptions {
  const key = process.env.AALTO_API_KEY?.trim();
  if (!key) {
    throw new Error("AALTO_API_KEY is required for integration tests");
  }
  return {
    aaltoApiKey: key,
    aaltoEndpoint: process.env.AALTO_ENDPOINT,
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
