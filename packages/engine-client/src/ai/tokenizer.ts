// Whisper's tokenizer, for reading what the model writes: GPT-2's byte-level
// BPE (each token is a run of bytes, spelt in printable stand-ins for bytes),
// plus the special tokens. Grouping tokens into words follows OpenAI's
// `split_tokens_on_spaces`.

/** GPT-2's stand-in characters: each byte as a printable character. */
function byteDecoder(): Map<string, number> {
  const bytes: number[] = [];
  for (let b = 33; b <= 126; b++) bytes.push(b);
  for (let b = 161; b <= 172; b++) bytes.push(b);
  for (let b = 174; b <= 255; b++) bytes.push(b);
  const chars = [...bytes];
  let extra = 0;
  for (let b = 0; b < 256; b++)
    if (!bytes.includes(b)) {
      bytes.push(b);
      chars.push(256 + extra++);
    }
  return new Map(bytes.map((byte, i) => [String.fromCharCode(chars[i]), byte]));
}

/** Marks that stick to the word after them, and those that stick to the word before. */
const leading = `"'“¿([{-«`;
const trailing = `"'.。,，!！?？:：”)]}、»،؛؟…`;
const punctuation = new Set('!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~');

export class Tokenizer {
  /** The first special token: everything from here on is not text. */
  readonly endOfText: number;
  private readonly bytes: (Uint8Array | null)[];
  private readonly names = new Map<number, string>();
  private readonly utf8 = new TextDecoder('utf-8', { fatal: false });

  constructor(vocab: Record<string, number>, added: Record<string, number>) {
    const decoder = byteDecoder();
    const size = Math.max(...Object.values(vocab), ...Object.values(added)) + 1;
    this.bytes = new Array<Uint8Array | null>(size).fill(null);
    for (const [token, id] of Object.entries(vocab))
      this.bytes[id] = Uint8Array.from([...token].map((char) => decoder.get(char) ?? 63));
    for (const [token, id] of Object.entries(added)) this.names.set(id, token);
    this.endOfText = added['<|endoftext|>'] ?? 50257;
  }

  /** The id of special token `name` (`<|en|>`, `<|notimestamps|>`…). */
  special(name: string): number {
    for (const [id, token] of this.names) if (token === name) return id;
    throw new Error(`The tokenizer has no ${name}`);
  }

  /** The text of tokens, leaving out special ones. Broken UTF-8 reads as U+FFFD. */
  decode(ids: number[]): string {
    const parts: Uint8Array[] = [];
    for (const id of ids) {
      const bytes = id < this.endOfText ? this.bytes[id] : null;
      if (bytes) parts.push(bytes);
    }
    const all = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
    let at = 0;
    for (const part of parts) {
      all.set(part, at);
      at += part.length;
    }
    return this.utf8.decode(all);
  }

  /**
   * Text tokens grouped into words: a word starts at a token that begins with a
   * space, at punctuation and at special tokens. A token that only completes
   * a character split across tokens joins the run it completes.
   */
  words(ids: number[]): { text: string; tokens: number[] }[] {
    // Runs of tokens that decode to whole characters.
    const full = this.decode(ids.filter((id) => id < this.endOfText));
    const pieces: { text: string; tokens: number[] }[] = [];
    let current: number[] = [];
    let offset = 0;
    for (const id of ids) {
      current.push(id);
      const text = id >= this.endOfText ? (this.names.get(id) ?? '') : this.decode(current);
      const broken = text.indexOf('�');
      if (id >= this.endOfText || broken < 0 || full[offset + broken] === '�') {
        pieces.push({ text, tokens: current });
        if (id < this.endOfText) offset += text.length;
        current = [];
      }
    }
    const words: { text: string; tokens: number[] }[] = [];
    for (const piece of pieces) {
      const special = piece.tokens[0] >= this.endOfText;
      const spaced = piece.text.startsWith(' ');
      const mark = punctuation.has(piece.text.trim());
      if (special || spaced || mark || !words.length)
        words.push({ ...piece, tokens: [...piece.tokens] });
      else {
        const last = words[words.length - 1];
        last.text += piece.text;
        last.tokens.push(...piece.tokens);
      }
    }
    return words;
  }
}

/**
 * Joins punctuation to the words it belongs with, as OpenAI's
 * `merge_punctuations` does: opening marks to the word after them, closing
 * marks to the word before. Each word keeps its own times.
 */
export function mergePunctuation<T extends { text: string }>(words: T[]): T[] {
  const list = words.map((word) => ({ ...word }));
  for (let i = list.length - 2, j = list.length - 1; i >= 0; i--) {
    const [previous, following] = [list[i], list[j]];
    const mark = previous.text.trim();
    if (previous.text.startsWith(' ') && mark && leading.includes(mark)) {
      following.text = previous.text + following.text;
      previous.text = '';
    } else j = i;
  }
  for (let i = 0, j = 1; j < list.length; j++) {
    const [previous, following] = [list[i], list[j]];
    const closing = following.text && [...following.text].every((char) => trailing.includes(char));
    if (!previous.text.endsWith(' ') && closing) {
      previous.text += following.text;
      following.text = '';
    } else i = j;
  }
  return list.filter((word) => word.text);
}
