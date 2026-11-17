import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";

const CC = process.env.CC ?? "cc";

function probe(): boolean {
  const r = spawnSync(CC, ["--version"], { encoding: "utf8" });
  return r.status === 0;
}

/** True when a C compiler is available. In CI (CI=true) a missing compiler is a hard failure. */
export const hasCC = probe();

if (!hasCC && process.env.CI) {
  throw new Error(`a C compiler (${CC}) is required in CI but was not found on PATH`);
}

if (!hasCC) {
  console.warn(`[tests] C compiler '${CC}' not found: C compile checks are skipped`);
}

/** Flags every fully supported generated program must compile cleanly with. */
export const STRICT_FLAGS = ["-std=c11", "-Wall", "-Wextra", "-pedantic", "-Werror"];

/**
 * Programs with `unsupported` statements may leave variables that are never
 * used; they must still compile without errors.
 */
export const LENIENT_FLAGS = [
  "-std=c11",
  "-Wall",
  "-Wextra",
  "-pedantic",
  "-Werror",
  "-Wno-unused-variable",
  "-Wno-unused-parameter",
  "-Wno-unused-but-set-variable",
  "-Wno-uninitialized",
  "-Wno-sometimes-uninitialized",
  "-Wno-unknown-warning-option",
];

export type CCompile = { ok: boolean; stderr: string };

function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "nlpg-c-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Syntax and type check only (fast; nothing is linked or run). */
export function checkC(code: string, flags = STRICT_FLAGS): CCompile {
  const r = spawnSync(CC, [...flags, "-fsyntax-only", "-x", "c", "-"], {
    input: code,
    encoding: "utf8",
    timeout: 20_000,
  });
  return { ok: r.status === 0, stderr: r.stderr ?? "" };
}

export function assertCompiles(code: string, flags = STRICT_FLAGS): void {
  if (!hasCC) return;
  const r = checkC(code, flags);
  expect(r.ok, `C failed to compile:\n${code}\n${r.stderr}`).toBe(true);
}

export type CRun = { stdout: string; stderr: string; code: number; compileError?: string };

/** Compiles (strict flags) and runs a program with the given stdin. */
export function runC(code: string, stdin = "", flags = STRICT_FLAGS): CRun {
  return withTempDir((dir) => {
    const src = join(dir, "prog.c");
    const exe = join(dir, "prog");
    writeFileSync(src, code);
    const c = spawnSync(CC, [...flags, "-o", exe, src, "-lm"], { encoding: "utf8", timeout: 30_000 });
    if (c.status !== 0) return { stdout: "", stderr: "", code: -1, compileError: c.stderr };
    const r = spawnSync(exe, [], { input: stdin, encoding: "utf8", timeout: 10_000 });
    return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", code: r.status ?? -1 };
  });
}
