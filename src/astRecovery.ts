import type { Expr, Stmt } from "./ast.js";

const LOOP_STMT_KINDS = new Set(["forin", "for", "while", "repeat"]);

function slugToVar(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_");
}

function varExpr(name: string): Expr {
  return { kind: "var", name: slugToVar(name) };
}

function loopHasEmptyBody(stmt: Stmt): boolean {
  if (!LOOP_STMT_KINDS.has(stmt.kind)) return false;
  const body = (stmt as { body: Stmt[] }).body;
  return !Array.isArray(body) || body.length === 0;
}

/**
 * Deterministic fallback when the model emits "unknown" for common course phrases
 * (including Finnish for-in headers).
 */
export function tryRecoverUnknownFromSource(source: string): Stmt | null {
  const line = source.trim();

  const forInEnglish = line.match(
    /^for each\s+([a-zA-Z_]\w*)\s+in\s+(?:the\s+)?([a-zA-Z_]\w*)\s*:?\s*\.?$/i
  );
  if (forInEnglish) {
    return {
      kind: "forin",
      loopVar: slugToVar(forInEnglish[1]),
      iterable: varExpr(forInEnglish[2]),
      body: [],
      source: "",
    };
  }

  const forInFinnish = line.match(
    /^jokaiselle\s+([a-zA-Z_]\w*)-arvolle\s+listassa\s+([a-zA-Z_]\w*)\s*\.?$/i
  );
  if (forInFinnish) {
    return {
      kind: "forin",
      loopVar: slugToVar(forInFinnish[1]),
      iterable: varExpr(forInFinnish[2]),
      body: [],
      source: "",
    };
  }

  const listAssign = line.match(
    /^let\s+(?:the\s+)?([a-zA-Z_]\w*)\s+be\s+a\s+list\s+with\s+(.+)\s*\.?$/i
  );
  if (listAssign) {
    const items = listAssign[2]
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part): Expr => {
        const num = Number(part);
        if (Number.isFinite(num)) return { kind: "num", value: num };
        return { kind: "str", value: part };
      });
    return {
      kind: "assign",
      target: slugToVar(listAssign[1]),
      value: { kind: "list", items },
      source: "",
    };
  }

  return null;
}

/**
 * When the model flattens loop bodies, a `pass` on the next line belongs inside the loop.
 */
export function promoteOrphanPassIntoLoopBodies(statements: Stmt[]): Stmt[] {
  const out: Stmt[] = [];

  for (let i = 0; i < statements.length; i++) {
    const stmt = statements[i];
    const next = statements[i + 1];

    if (loopHasEmptyBody(stmt) && next?.kind === "pass") {
      switch (stmt.kind) {
        case "forin":
          out.push({ ...stmt, body: [next] });
          break;
        case "for":
          out.push({ ...stmt, body: [next] });
          break;
        case "while":
          out.push({ ...stmt, body: [next] });
          break;
        case "repeat":
          out.push({ ...stmt, body: [next] });
          break;
      }
      i++;
      continue;
    }

    out.push(stmt);
  }

  return out;
}
