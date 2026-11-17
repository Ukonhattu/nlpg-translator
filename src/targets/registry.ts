import { cTarget } from "./c/index.js";
import { pythonTarget } from "./python/index.js";
import { TARGET_IDS, type Target, type TargetId } from "./types.js";

const TARGETS: Record<TargetId, Target> = {
  python: pythonTarget,
  c: cTarget,
};

export function isTargetId(value: unknown): value is TargetId {
  return typeof value === "string" && (TARGET_IDS as readonly string[]).includes(value);
}

/** Resolves a target id (default "python"); throws RangeError for unknown ids. */
export function getTarget(id: TargetId | undefined = "python"): Target {
  if (!isTargetId(id)) {
    throw new RangeError(`target must be one of: ${TARGET_IDS.join(", ")}`);
  }
  return TARGETS[id];
}

export function listTargets(): Target[] {
  return TARGET_IDS.map((id) => TARGETS[id]);
}
