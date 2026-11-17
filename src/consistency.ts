/**
 * Multi-sample consistency (AST mode, `samples > 1`).
 *
 * Each sample is a fully verified (and grounded) program. Programs are compared
 * through a canonical form that ignores the model's justification text
 * (`evidence`, `outputCue`), the resolved `source` line, the literal spelling
 * (`raw`) and free-text `note`s, but keeps `line` and everything that changes
 * the generated code. The most frequent whole program wins; per-line forms are
 * compared to find the steps that can be read in more than one way.
 *
 * This reports disagreement only; presenting it to students is up to the host.
 */

import type { Stmt } from "./ast.js";

const STRIPPED_KEYS = new Set(["evidence", "outputCue", "source", "raw", "note"]);

/** JSON with sorted keys and the justification fields removed. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      if (STRIPPED_KEYS.has(key)) continue;
      const v = (value as Record<string, unknown>)[key];
      if (v === undefined) continue;
      out[key] = canonicalize(v);
    }
    return out;
  }
  return value;
}

export function canonicalProgram(statements: Stmt[]): string {
  return canonicalJson(statements);
}

const lineOf = (s: Stmt): number => (s as { line?: number }).line ?? 0;

/** A statement without its nested step lists (those are compared on their own lines). */
function ownForm(stmt: Stmt): string {
  const copy: Record<string, unknown> = { ...stmt };
  delete copy.body;
  delete copy.orelse;
  if (Array.isArray(copy.elifs)) {
    copy.elifs = (copy.elifs as Array<{ test: unknown }>).map((c) => ({ test: c.test }));
  }
  if (Array.isArray(copy.handlers)) {
    copy.handlers = (copy.handlers as Array<{ exc?: unknown }>).map((h) => ({ exc: h.exc }));
  }
  return canonicalJson(copy);
}

function children(stmt: Stmt): Stmt[] {
  const s = stmt as unknown as {
    body?: Stmt[];
    orelse?: Stmt[];
    elifs?: Array<{ body: Stmt[] }>;
    handlers?: Array<{ body: Stmt[] }>;
  };
  return [
    ...(s.body ?? []),
    ...(s.elifs ?? []).flatMap((c) => c.body),
    ...(s.orelse ?? []),
    ...(s.handlers ?? []).flatMap((h) => h.body),
  ];
}

/**
 * Per source line: the canonical forms of all statements citing that line (at
 * any depth), each with its nesting path, as one comparable string.
 */
export function lineForms(statements: Stmt[]): Map<number, string> {
  const parts = new Map<number, string[]>();
  const walk = (list: Stmt[], path: string[]) => {
    for (const stmt of list) {
      const line = lineOf(stmt);
      const entry = `${path.join(">")}|${ownForm(stmt)}`;
      const arr = parts.get(line);
      if (arr) arr.push(entry);
      else parts.set(line, [entry]);
      walk(children(stmt), [...path, `${stmt.kind}@${line}`]);
    }
  };
  walk(statements, []);
  const out = new Map<number, string>();
  for (const [line, arr] of parts) out.set(line, arr.sort().join("\n"));
  return out;
}

export type SampleSummary = {
  index: number;
  statements: Stmt[];
  /** Grounding warnings (not info) recorded for this sample. */
  groundingWarnings: number;
  unknownNodes: number;
};

export type Consensus = {
  chosen: SampleSummary;
  /** How many samples produced a program identical to the chosen one. */
  agreeing: number;
};

/**
 * Most frequent canonical program wins; ties go to the fewest grounding
 * warnings, then the fewest unknown nodes, then the lowest sample index.
 */
export function selectConsensus(samples: SampleSummary[]): Consensus {
  if (samples.length === 0) throw new Error("selectConsensus needs at least one sample");
  const groups = new Map<string, SampleSummary[]>();
  for (const s of samples) {
    const key = canonicalProgram(s.statements);
    const g = groups.get(key);
    if (g) g.push(s);
    else groups.set(key, [s]);
  }
  const better = (a: SampleSummary, b: SampleSummary) =>
    a.groundingWarnings - b.groundingWarnings ||
    a.unknownNodes - b.unknownNodes ||
    a.index - b.index;

  let best: SampleSummary[] | undefined;
  for (const g of groups.values()) {
    if (!best || g.length > best.length) {
      best = g;
    } else if (g.length === best.length) {
      // tie between groups: compare their best representatives
      const gRep = [...g].sort(better)[0];
      const bRep = [...best].sort(better)[0];
      if (better(gRep, bRep) < 0) best = g;
    }
  }
  const chosen = [...best!].sort(better)[0];
  return { chosen, agreeing: best!.length };
}

/** Source lines whose reading differs between samples. */
export function disagreeingLines(
  samples: SampleSummary[]
): Array<{ line: number; variants: number }> {
  if (samples.length < 2) return [];
  const forms = samples.map((s) => lineForms(s.statements));
  const lines = new Set<number>();
  forms.forEach((m) => m.forEach((_v, line) => lines.add(line)));
  const out: Array<{ line: number; variants: number }> = [];
  for (const line of [...lines].sort((a, b) => a - b)) {
    // A sample that does not cite the line at all is its own variant ("").
    const variants = new Set(forms.map((m) => m.get(line) ?? ""));
    if (variants.size > 1) out.push({ line, variants: variants.size });
  }
  return out;
}
