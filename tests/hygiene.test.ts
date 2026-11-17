import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { promoteOrphanPassIntoLoopBodies } from "../src/astRecovery.js";
import type { Stmt } from "../src/ast.js";

const root = join(import.meta.dirname, "..");
const read = (f: string) => readFileSync(join(root, f), "utf8");

describe("promoteOrphanPassIntoLoopBodies", () => {
  const pass = { kind: "pass", source: "pass" } as Stmt;
  const test = { kind: "bool", value: true } as const;
  const loops: Stmt[] = [
    { kind: "forin", loopVar: "x", iterable: { kind: "var", name: "xs" }, body: [], source: "" },
    { kind: "for", loopVar: "i", start: { kind: "num", value: 0 }, stop: { kind: "num", value: 3 }, body: [], source: "" },
    { kind: "while", test, body: [], source: "" },
    { kind: "repeat", count: { kind: "num", value: 2 }, body: [], source: "" },
  ];

  it.each(loops.map((l) => [l.kind, l] as const))("moves a following pass into an empty %s body", (_k, loop) => {
    const out = promoteOrphanPassIntoLoopBodies([loop, pass]);
    expect(out).toHaveLength(1);
    expect((out[0] as { body: Stmt[] }).body).toEqual([pass]);
  });

  it("leaves loops that already have a body, and non-loops, alone", () => {
    const full = { ...loops[2], body: [pass] } as Stmt;
    expect(promoteOrphanPassIntoLoopBodies([full, pass])).toEqual([full, pass]);
    expect(promoteOrphanPassIntoLoopBodies([pass, pass])).toEqual([pass, pass]);
  });
});

describe("repository hygiene (§10)", () => {
  it(".gitignore ignores .claude/ and env files", () => {
    const g = read(".gitignore").split("\n");
    expect(g).toContain(".claude/");
    expect(g).toContain(".env.*");
    expect(g).toContain("dist/");
  });

  it(".dockerignore keeps secrets and local state out of the image", () => {
    const d = read(".dockerignore").split("\n");
    for (const entry of ["node_modules", "dist", ".git", ".claude", ".env*", "tests", "examples"]) {
      expect(d).toContain(entry);
    }
  });

  it("Dockerfile is multi-stage on node:22-alpine, runs as non-root with a healthcheck", () => {
    const f = read("Dockerfile");
    expect(f.match(/^FROM node:22-alpine/gm)).toHaveLength(2);
    expect(f).toMatch(/FROM node:22-alpine AS build/);
    expect(f).toMatch(/npm ci --omit=dev/);
    expect(f).toMatch(/COPY --from=build \/app\/dist/);
    expect(f).toMatch(/^USER node$/m);
    expect(f).toMatch(/HOST=0\.0\.0\.0/);
    expect(f).toMatch(/HEALTHCHECK[\s\S]*\/healthz/);
  });

  it("nothing under dist/, .claude/ or .env* is tracked", () => {
    let tracked: string[];
    try {
      tracked = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" }).split("\n").filter(Boolean);
    } catch {
      return; // not a git checkout (e.g. a source tarball)
    }
    expect(tracked.filter((f) => /^(dist|\.claude)\//.test(f) || /(^|\/)\.env(\.|$)/.test(f) && !f.endsWith(".example"))).toEqual([]);
  });
});
