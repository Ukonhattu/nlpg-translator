import { spawnSync } from "node:child_process";
import { expect } from "vitest";

function probe(): boolean {
  const r = spawnSync("python3", ["--version"], { encoding: "utf8" });
  return r.status === 0;
}

/** True when python3 is available. In CI (CI=true) a missing python is a hard failure. */
export const hasPython = probe();

if (!hasPython && process.env.CI) {
  throw new Error("python3 is required in CI but was not found on PATH");
}

if (!hasPython) {
  console.warn("[tests] python3 not found: Python parse checks are skipped");
}

export type PythonRun = { stdout: string; stderr: string; code: number };

export function runPython(code: string, stdin?: string): PythonRun {
  const r = spawnSync("python3", ["-I", "-c", code], {
    input: stdin ?? "",
    encoding: "utf8",
    timeout: 10_000,
  });
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", code: r.status ?? -1 };
}

/** Assert that `code` parses as Python (syntax only, nothing is executed). */
export function assertParses(code: string): void {
  if (!hasPython) return;
  const r = spawnSync(
    "python3",
    ["-I", "-c", "import ast,sys; ast.parse(sys.stdin.read())"],
    { input: code, encoding: "utf8", timeout: 10_000 }
  );
  expect(r.status, `Python failed to parse:\n${code}\n${r.stderr}`).toBe(0);
}
