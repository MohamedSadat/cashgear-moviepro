// Word error rate for the caption tests: the words a transcript gets wrong
// (substituted, left out or added) per word of the reference. Both sides are
// normalised first, so that punctuation, case, how a number is written and
// Arabic letter variants are not counted as mistakes; a reader would not
// correct them.

const ones = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
  'thirteen',
  'fourteen',
  'fifteen',
  'sixteen',
  'seventeen',
  'eighteen',
  'nineteen',
];
const tens = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const scales: Record<string, number> = { hundred: 100, thousand: 1e3, million: 1e6, billion: 1e9 };
/** Ordinals that are not a cardinal plus "th". "Second" is left alone: it is also a noun. */
const irregular: Record<string, string> = {
  first: 'one',
  third: 'three',
  fifth: 'five',
  eighth: 'eight',
  ninth: 'nine',
  twelfth: 'twelve',
};

/** A number word's value and whether it was an ordinal, or null. */
function numberWord(word: string): { value: number; scale: boolean; ordinal: boolean } | null {
  let base = word;
  let ordinal = false;
  if (irregular[word]) {
    base = irregular[word];
    ordinal = true;
  } else if (word.endsWith('ieth')) {
    base = word.slice(0, -4) + 'y';
    ordinal = true;
  } else if (word.endsWith('th') && word !== 'th') {
    base = word.slice(0, -2);
    ordinal = true;
  }
  const one = ones.indexOf(base);
  if (one >= 0) return { value: one, scale: false, ordinal };
  const ten = tens.indexOf(base);
  if (ten >= 2) return { value: ten * 10, scale: false, ordinal };
  if (scales[base]) return { value: scales[base], scale: true, ordinal };
  return null;
}

/** Spelled-out numbers as digits ("nineteen sixty three" is 1963), ordinals as "21th". */
function digits(words: string[]): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < words.length) {
    if (!numberWord(words[i])) {
      out.push(words[i].replace(/^(\d+)(st|nd|rd|th)$/, '$1th'));
      i++;
      continue;
    }
    // One run of number words, split into numbers where a value cannot extend the last.
    const numbers: { value: number; ordinal: boolean }[] = [];
    let total = 0;
    let current = 0;
    let started = false;
    let ordinal = false;
    const flush = () => {
      if (started) numbers.push({ value: total + current, ordinal });
      total = 0;
      current = 0;
      started = false;
      ordinal = false;
    };
    for (; i < words.length; i++) {
      // "One hundred and five" is one number.
      if (words[i] === 'and' && total + current >= 100 && current % 100 === 0)
        if (numberWord(words[i + 1] ?? '')) continue;
      const word = numberWord(words[i]);
      if (!word || ordinal) break;
      const { value } = word;
      if (word.scale) {
        if (value === 100) current = (current || 1) * 100;
        else {
          total += (current || 1) * value;
          current = 0;
        }
      } else {
        const fits =
          value < 10
            ? current % 10 === 0 && (current % 100 === 0 || current % 100 >= 20)
            : current % 100 === 0;
        if (started && !fits) flush();
        current += value;
      }
      started = true;
      ordinal = word.ordinal;
    }
    flush();
    // Two numbers of two digits in a row are a year.
    for (let k = 0; k < numbers.length; k++) {
      const [a, b] = [numbers[k], numbers[k + 1]];
      if (b && a.value >= 10 && a.value < 100 && !a.ordinal && b.value < 100) {
        out.push(`${a.value * 100 + b.value}${b.ordinal ? 'th' : ''}`);
        k++;
      } else out.push(`${a.value}${a.ordinal ? 'th' : ''}`);
    }
  }
  return out;
}

/** English words, lower case, without punctuation and with numbers as digits. */
export function normalizeEnglish(text: string): string[] {
  const plain = text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/%/g, ' percent ')
    .replace(/&/g, ' and ')
    .replace(/(\d),(?=\d{3}\b)/g, '$1')
    .replace(/[-‐-―]/g, ' ')
    .replace(/[^\p{L}\p{N}'\s]/gu, ' ')
    .replace(/(^|\s)'+|'+(?=\s|$)/g, ' ');
  return digits(plain.split(/\s+/).filter(Boolean));
}

/**
 * Arabic words without diacritics, tatweel or punctuation, with the alef forms
 * as bare alef, alef maqsura as ya, ta marbuta as ha and Arabic-Indic digits as
 * Western ones, as Arabic speech recognition is usually scored.
 */
export function normalizeArabic(text: string): string[] {
  return text
    .normalize('NFKC')
    .replace(/[ً-ٰٟۖ-ۭـ]/g, '')
    .replace(/[إأآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

export interface WordErrors {
  /** Errors per reference word. */
  wer: number;
  substitutions: number;
  deletions: number;
  insertions: number;
  /** Reference words. */
  words: number;
}

/** The fewest substitutions, deletions and insertions that turn `reference` into `hypothesis`. */
export function wordErrors(reference: string[], hypothesis: string[]): WordErrors {
  const n = reference.length;
  const m = hypothesis.length;
  // Each cell: [cost, substitutions, deletions, insertions].
  let row: number[][] = Array.from({ length: m + 1 }, (_, j) => [j, 0, 0, j]);
  for (let i = 1; i <= n; i++) {
    const next: number[][] = [[i, 0, i, 0]];
    for (let j = 1; j <= m; j++) {
      const same = reference[i - 1] === hypothesis[j - 1];
      const diagonal = row[j - 1];
      const up = row[j];
      const left = next[j - 1];
      const options = [
        [diagonal[0] + (same ? 0 : 1), diagonal[1] + (same ? 0 : 1), diagonal[2], diagonal[3]],
        [up[0] + 1, up[1], up[2] + 1, up[3]],
        [left[0] + 1, left[1], left[2], left[3] + 1],
      ];
      next.push(options.reduce((best, option) => (option[0] < best[0] ? option : best)));
    }
    row = next;
  }
  const [cost, substitutions, deletions, insertions] = row[m];
  return { wer: n ? cost / n : 0, substitutions, deletions, insertions, words: n };
}
