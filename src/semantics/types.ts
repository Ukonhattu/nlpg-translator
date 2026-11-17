/**
 * Static types inferred from the (dynamically typed) AST. Used by statically
 * typed targets such as C; Python ignores them.
 */

export type Type =
  | { k: "int" }
  | { k: "float" }
  | { k: "bool" }
  | { k: "str" }
  | { k: "list"; elem: Type }
  | { k: "tuple"; items: Type[] }
  /** A function that returns nothing. */
  | { k: "none" }
  /** Not (yet) known. */
  | { k: "unknown" }
  /** Used with incompatible types. */
  | { k: "conflict" };

export const INT: Type = { k: "int" };
export const FLOAT: Type = { k: "float" };
export const BOOL: Type = { k: "bool" };
export const STR: Type = { k: "str" };
export const NONE: Type = { k: "none" };
export const UNKNOWN: Type = { k: "unknown" };
export const CONFLICT: Type = { k: "conflict" };

export const listOf = (elem: Type): Type => ({ k: "list", elem });

/** Deeper list nesting is treated as a conflict, so inference always terminates. */
const MAX_TYPE_DEPTH = 4;

function depth(t: Type): number {
  if (t.k === "list") return 1 + depth(t.elem);
  if (t.k === "tuple") return 1 + Math.max(0, ...t.items.map(depth));
  return 0;
}

export function typeEquals(a: Type, b: Type): boolean {
  return typeToString(a) === typeToString(b);
}

export function isNumeric(t: Type): boolean {
  return t.k === "int" || t.k === "float" || t.k === "bool";
}

/** True when the type is fully known (no unknown/conflict anywhere inside). */
export function isConcrete(t: Type): boolean {
  switch (t.k) {
    case "unknown":
    case "conflict":
      return false;
    case "list":
      return isConcrete(t.elem);
    case "tuple":
      return t.items.every(isConcrete);
    default:
      return true;
  }
}

export function containsConflict(t: Type): boolean {
  if (t.k === "conflict") return true;
  if (t.k === "list") return containsConflict(t.elem);
  if (t.k === "tuple") return t.items.some(containsConflict);
  return false;
}

/**
 * Least upper bound of two types: unknown is the identity, int and float widen
 * to float (as when `x = 1` is later followed by `x = x / 2`), anything else
 * that differs is a conflict.
 */
export function unify(a: Type, b: Type): Type {
  if (a.k === "unknown") return b;
  if (b.k === "unknown") return a;
  if (a.k === "conflict" || b.k === "conflict") return CONFLICT;
  if (a.k === "list" && b.k === "list") {
    const t = listOf(unify(a.elem, b.elem));
    return depth(t) > MAX_TYPE_DEPTH ? CONFLICT : t;
  }
  if (a.k === "tuple" && b.k === "tuple") {
    if (a.items.length !== b.items.length) return CONFLICT;
    return { k: "tuple", items: a.items.map((t, i) => unify(t, b.items[i])) };
  }
  if (a.k === b.k) return a;
  if ((a.k === "int" && b.k === "float") || (a.k === "float" && b.k === "int")) {
    return FLOAT;
  }
  return CONFLICT;
}

export function typeToString(t: Type): string {
  switch (t.k) {
    case "list":
      return `list[${typeToString(t.elem)}]`;
    case "tuple":
      return `tuple[${t.items.map(typeToString).join(", ")}]`;
    default:
      return t.k;
  }
}
