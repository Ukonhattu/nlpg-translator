import { describe, expect, it } from "vitest";
import { numberWordValues } from "../src/numberWords.js";

const has = (text: string, n: number) => numberWordValues(text.toLowerCase()).has(n);

describe("numberWordValues", () => {
  it("English 0-20 and tens", () => {
    const words = ["zero","one","two","three","four","five","six","seven","eight","nine","ten","eleven","twelve","thirteen","fourteen","fifteen","sixteen","seventeen","eighteen","nineteen","twenty"];
    words.forEach((w, i) => expect(has(w, i), w).toBe(true));
    expect(has("thirty", 30)).toBe(true);
    expect(has("ninety", 90)).toBe(true);
  });

  it("English compounds", () => {
    expect(has("twenty-five", 25)).toBe(true);
    expect(has("twenty five", 25)).toBe(true);
    expect(has("one hundred", 100)).toBe(true);
    expect(has("one hundred and five", 105)).toBe(true);
    expect(has("two thousand five hundred", 2500)).toBe(true);
    expect(has("a thousand", 1000)).toBe(true);
  });

  it("does not merge numbers separated by punctuation", () => {
    const v = numberWordValues("a list with one, two, three");
    expect(v.has(1) && v.has(2) && v.has(3)).toBe(true);
    expect(v.has(6)).toBe(false);
    expect(v.has(12)).toBe(false);
  });

  it("Finnish nolla ... kaksikymmentä", () => {
    const words = ["nolla","yksi","kaksi","kolme","neljä","viisi","kuusi","seitsemän","kahdeksan","yhdeksän","kymmenen","yksitoista","kaksitoista","kolmetoista","neljätoista","viisitoista","kuusitoista","seitsemäntoista","kahdeksantoista","yhdeksäntoista","kaksikymmentä"];
    words.forEach((w, i) => expect(has(w, i), w).toBe(true));
  });

  it("Finnish tens, hundreds, thousands and inflections", () => {
    expect(has("kaksikymmentäviisi", 25)).toBe(true);
    expect(has("sata", 100)).toBe(true);
    expect(has("kolmesataa", 300)).toBe(true);
    expect(has("tuhat", 1000)).toBe(true);
    expect(has("kaksituhattaviisisataa", 2500)).toBe(true);
    expect(has("kolmen", 3)).toBe(true);
    expect(has("viittä", 5)).toBe(true);
    expect(has("kahdella", 2)).toBe(false); // adessive not covered; digits are expected then
  });

  it("ignores ordinary words", () => {
    expect(numberWordValues("satama ja kuusenkäpy").size).toBe(0);
    expect(numberWordValues("the score is big").size).toBe(0);
  });
});
