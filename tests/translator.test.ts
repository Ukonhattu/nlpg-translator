import { describe, expect, it } from "vitest";
import { enforceFidelity } from "../src/translator.js";

describe("enforceFidelity", () => {
  const source = "Print the score.\nPrint the total.";

  it("strips markdown fences only by default", () => {
    const raw = "```python\nprint(1)\nprint(2)\nprint(3)\n```";
    expect(enforceFidelity(raw, source)).toBe("print(1)\nprint(2)\nprint(3)");
  });

  it("removes extra prints only when strictOutputFidelity is set", () => {
    const raw = "print(1)\nprint(2)\nprint(3)";
    expect(enforceFidelity(raw, source)).toBe(raw);
    expect(
      enforceFidelity(raw, source, { strictOutputFidelity: true })
    ).toBe("print(1)\nprint(2)");
  });
});
