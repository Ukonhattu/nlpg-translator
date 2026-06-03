import { describe, expect, it } from "vitest";
import { lineRequestsOutput } from "../src/outputVerbs.js";

describe("lineRequestsOutput", () => {
  it("matches explicit print/show verbs", () => {
    expect(lineRequestsOutput("Print the score.")).toBe(true);
    expect(lineRequestsOutput("Näytä tulos.")).toBe(true);
    expect(lineRequestsOutput("Tulosta tervehdys.")).toBe(true);
    expect(lineRequestsOutput("Nayta tulos.")).toBe(true);
  });

  it("does not treat list vocabulary as output", () => {
    expect(lineRequestsOutput("Create a list of scores.")).toBe(false);
    expect(lineRequestsOutput("Append 5 to the list.")).toBe(false);
  });
});
