/**
 * Number words (English and Finnish) so that grounding can accept a literal such
 * as `20` when the instruction says "twenty" / "kaksikymmentä".
 *
 * Covers 0-20, the tens, "hundred" and "thousand" (and Finnish compound words
 * such as "kaksikymmentäviisi" or "kolmesataa"). Text is expected to be
 * lowercased NFC; extraction is deliberately lenient (every individual number
 * word contributes its own value, and runs like "twenty five" also contribute
 * the combined value), because it only decides whether a literal is *plausibly*
 * present on the source line.
 */

const EN_UNITS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
  fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
  nineteen: 19, twenty: 20,
};
const EN_TENS: Record<string, number> = {
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70,
  eighty: 80, ninety: 90,
};

// Finnish morphemes (nominative, genitive and partitive forms).
const FI_UNIT_FORMS: Array<[number, string[]]> = [
  [0, ["nolla", "nollan", "nollaa"]],
  [1, ["yksi", "yhden", "yhtä"]],
  [2, ["kaksi", "kahden", "kahta"]],
  [3, ["kolme", "kolmen", "kolmea"]],
  [4, ["neljä", "neljän", "neljää"]],
  [5, ["viisi", "viiden", "viittä"]],
  [6, ["kuusi", "kuuden", "kuutta"]],
  [7, ["seitsemän", "seitsemää"]],
  [8, ["kahdeksan", "kahdeksaa"]],
  [9, ["yhdeksän", "yhdeksää"]],
];

type FiMorpheme = { text: string; type: "unit" | "teen" | "ten" | "hundred" | "thousand"; value: number };

const FI_MORPHEMES: FiMorpheme[] = [
  ...FI_UNIT_FORMS.flatMap(([value, forms]) =>
    forms.map((text): FiMorpheme => ({ text, type: "unit", value }))
  ),
  { text: "toista", type: "teen" as const, value: 10 },
  { text: "kymmentä", type: "ten" as const, value: 10 },
  { text: "kymmenen", type: "ten" as const, value: 10 },
  { text: "sataa", type: "hundred" as const, value: 100 },
  { text: "sadan", type: "hundred" as const, value: 100 },
  { text: "sata", type: "hundred" as const, value: 100 },
  { text: "tuhatta", type: "thousand" as const, value: 1000 },
  { text: "tuhannen", type: "thousand" as const, value: 1000 },
  { text: "tuhat", type: "thousand" as const, value: 1000 },
].sort((a, b) => b.text.length - a.text.length);

function parseFinnishWord(word: string): number | null {
  const parts: FiMorpheme[] = [];
  let rest = word;
  while (rest.length > 0) {
    const m = FI_MORPHEMES.find((x) => rest.startsWith(x.text));
    if (!m) return null;
    parts.push(m);
    rest = rest.slice(m.text.length);
  }
  if (parts.length === 0) return null;

  let total = 0;
  let chunk = 0;
  let pending: number | null = null;
  for (const p of parts) {
    switch (p.type) {
      case "unit":
        pending = p.value;
        break;
      case "teen":
        chunk += (pending ?? 0) + 10;
        pending = null;
        break;
      case "ten":
        chunk += (pending ?? 1) * 10;
        pending = null;
        break;
      case "hundred":
        chunk += (pending ?? 1) * 100;
        pending = null;
        break;
      case "thousand":
        total += ((chunk + (pending ?? 0)) || 1) * 1000;
        chunk = 0;
        pending = null;
        break;
    }
  }
  return total + chunk + (pending ?? 0);
}

function englishWordValue(word: string): number | null {
  if (word in EN_UNITS) return EN_UNITS[word];
  if (word in EN_TENS) return EN_TENS[word];
  if (word === "hundred") return 100;
  if (word === "thousand") return 1000;
  return null;
}

/** Combine a run of English number words ("two thousand five hundred and ten"). */
function combineEnglishRun(words: string[]): number | null {
  let total = 0;
  let current = 0;
  let any = false;
  for (const w of words) {
    if (w === "and") continue;
    const v = englishWordValue(w);
    if (v === null) return null;
    any = true;
    if (w === "hundred") current = (current || 1) * 100;
    else if (w === "thousand") {
      total += (current || 1) * 1000;
      current = 0;
    } else current += v;
  }
  return any ? total + current : null;
}

/** All numeric values that number words in `text` (lowercased NFC) could denote. */
export function numberWordValues(text: string): Set<number> {
  const values = new Set<number>();
  const tokens = [...text.matchAll(/\p{L}+/gu)];

  // Finnish and single English words.
  for (const t of tokens) {
    const word = t[0];
    const en = englishWordValue(word);
    if (en !== null) values.add(en);
    const fi = parseFinnishWord(word);
    if (fi !== null) values.add(fi);
  }

  // Runs of English number words separated only by spaces/hyphens ("twenty-five").
  let run: string[] = [];
  let prevEnd = -1;
  const flush = () => {
    if (run.length > 1) {
      const v = combineEnglishRun(run);
      if (v !== null) values.add(v);
    }
    run = [];
  };
  for (const t of tokens) {
    const word = t[0];
    const start = t.index ?? 0;
    const gapOk = prevEnd < 0 || /^[\s-]+$/u.test(text.slice(prevEnd, start));
    const isNum = englishWordValue(word) !== null || (word === "and" && run.length > 0);
    if (isNum && gapOk) run.push(word);
    else {
      flush();
      if (englishWordValue(word) !== null) run.push(word);
    }
    prevEnd = start + word.length;
  }
  flush();
  return values;
}
