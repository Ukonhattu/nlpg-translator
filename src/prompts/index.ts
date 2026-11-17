/**
 * Prompt registry. Every prompt has a stable `id` and a SHA-256 of its text.
 * Editing a prompt's text WITHOUT giving it a new id is a bug: runs recorded
 * under that id would no longer be reproducible. tests/prompts.test.ts compares
 * the hashes below against tests/fixtures/prompt-hashes.json and fails on drift.
 */

import { createHash } from "node:crypto";
import { AST_PROMPT_V2 } from "./ast.v2.js";
import { DIRECT_PROMPT_V1 } from "./direct.v1.js";
import { DIRECT_PROMPT_V2 } from "./direct.v2.js";

export type PromptInfo = { id: string; text: string; sha256: string };

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function register(p: { id: string; text: string }): PromptInfo {
  return { id: p.id, text: p.text, sha256: sha256Hex(p.text) };
}

export const PROMPTS: readonly PromptInfo[] = [
  register(AST_PROMPT_V2),
  register(DIRECT_PROMPT_V1),
  register(DIRECT_PROMPT_V2),
];

export function getPrompt(id: string): PromptInfo {
  const found = PROMPTS.find((p) => p.id === id);
  if (!found) throw new Error(`Unknown prompt id: ${id}`);
  return found;
}
