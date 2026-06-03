import { readFileSync } from "node:fs";
import { join } from "node:path";

export type GoldenFixture = {
  description?: string;
  source: string;
  raw: { statements: unknown[] };
  pythonPatterns: string[];
  pythonAntipatterns?: string[];
};

const goldenDir = join(import.meta.dirname, "golden");

export function loadGolden(name: string): GoldenFixture {
  const path = join(goldenDir, `${name}.json`);
  return JSON.parse(readFileSync(path, "utf8")) as GoldenFixture;
}
