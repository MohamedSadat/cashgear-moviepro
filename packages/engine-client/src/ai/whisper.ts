import { WhisperFeatures, silences, token_times } from '../pkg/ai/cgv_ai';
import { modelInfo, readModelFile, readModelJson, type ModelId } from './models';
import { createSession, ort, type Provider } from './runtime';
import { mergePunctuation, Tokenizer } from './tokenizer';
import type { Transcript, TranscriptSegment, TranscriptWord } from './types';

// Speech to text with Whisper, the way OpenAI's `transcribe` does it: 30 s
// windows prompted with the text before them, greedy decoding under the
// timestamp rules (falling back to sampling when a window repeats itself or
// reads as unlikely), windows judged silent skipped, and word times from the
// alignment heads' cross-attention. Windows also start where speech does,
// after any pause of a second or more.

interface GenerationConfig {
  alignment_heads: [number, number][];
  lang_to_id: Record<string, number>;
  no_timestamps_token_id: number;
  suppress_tokens: number[];
  begin_suppress_tokens: number[];
  max_initial_timestamp_index: number;
  decoder_start_token_id: number;
}

interface ModelConfig {
  num_mel_bins: number;
  decoder_layers: number;
  decoder_attention_heads: number;
  d_model: number;
}

type Word = TranscriptWord;
type Segment = TranscriptSegment;

const SAMPLE_RATE = 16_000;
const HOP = 160;
/** Spectrogram frames in a window, and per second. */
const WINDOW_FRAMES = 3000;
const FRAMES_PER_SECOND = SAMPLE_RATE / HOP;
/** Spectrogram frames per encoder position, and seconds per timestamp token. */
const INPUT_STRIDE = 2;
const TIME_PRECISION = 0.02;
const TEMPERATURES = [0, 0.2, 0.4, 0.6, 0.8, 1];
const COMPRESSION_LIMIT = 2.4;
const LOGPROB_LIMIT = -1;
const NO_SPEECH_LIMIT = 0.6;
/** Tokens a window may write: half the decoder's context, as OpenAI allows. */
const MAX_TOKENS = 224;
/** Pauses at least this long are skipped, up to a little before the speech after them. */
const PAUSE_SECONDS = 1;
const PAUSE_LEAD = 0.2;
/**
 * Tokens of earlier windows a window is prompted with: the decoder's 448
 * positions hold them, the start-of-previous token, the three-token prompt
 * and the window's own tokens.
 */
const CONTEXT_TOKENS = 220;

type Cache = Record<string, ort.Tensor>;

interface Decoded {
  /** What the model wrote after the prompt, without the end token. */
  tokens: number[];
  /** Each token's probability. */
  probabilities: number[];
  averageLogprob: number;
  noSpeech: number;
  compression: number;
  temperature: number;
}

/** A repeatable random number generator (mulberry32), for sampling at a temperature. */
function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function logSoftmax(values: Float32Array): Float32Array {
  let max = -Infinity;
  for (const value of values) if (value > max) max = value;
  let sum = 0;
  for (const value of values) sum += Math.exp(value - max);
  const log = Math.log(sum) + max;
  return values.map((value) => value - log);
}

/** How much the text compresses: repeated text compresses well. */
async function compressionRatio(text: string): Promise<number> {
  const bytes = new TextEncoder().encode(text);
  if (!bytes.length) return 0;
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));
  const compressed = await new Response(stream).arrayBuffer();
  return bytes.length / compressed.byteLength;
}

export class Whisper {
  private readonly layers: number;
  private readonly heads: number;
  private readonly empty: ort.Tensor;
  private readonly startOfTranscript: number;
  private readonly startOfPrevious: number;
  private readonly transcribe: number;
  private readonly noTimestamps: number;
  private readonly noSpeech: number;
  private readonly timestampBegin: number;
  private readonly endOfText: number;
  private readonly suppressed: number[];

  private constructor(
    readonly id: ModelId,
    readonly provider: Provider,
    private readonly encoder: ort.InferenceSession,
    private readonly decoder: ort.InferenceSession,
    private readonly tokenizer: Tokenizer,
    private readonly generation: GenerationConfig,
    private readonly config: ModelConfig,
    private readonly features: WhisperFeatures,
  ) {
    this.layers = config.decoder_layers;
    this.heads = config.decoder_attention_heads;
    const size = config.d_model / this.heads;
    this.empty = new ort.Tensor('float32', new Float32Array(0), [1, this.heads, 0, size]);
    this.startOfTranscript = generation.decoder_start_token_id;
    this.transcribe = tokenizer.special('<|transcribe|>');
    this.startOfPrevious = tokenizer.special('<|startofprev|>');
    this.noTimestamps = generation.no_timestamps_token_id;
    this.timestampBegin = this.noTimestamps + 1;
    this.endOfText = tokenizer.endOfText;
    this.noSpeech = (() => {
      try {
        return tokenizer.special('<|nospeech|>');
      } catch {
        return tokenizer.special('<|nocaptions|>');
      }
    })();
    this.suppressed = generation.suppress_tokens;
  }

  /**
   * Loads an installed model on `provider`. On WebGPU it must first give the
   * model's known answer (see `knownAnswer`): some GPU drivers compute its
   * kernels wrongly, and then the load fails with a `GpuMismatch` error.
   */
  static async load(id: ModelId, provider: Provider): Promise<Whisper> {
    const model = modelInfo(id);
    const [vocab, added, generation, config] = await Promise.all([
      readModelJson<Record<string, number>>(model, 'vocab'),
      readModelJson<Record<string, number>>(model, 'tokens'),
      readModelJson<GenerationConfig>(model, 'generation'),
      readModelJson<ModelConfig>(model, 'config'),
    ]);
    const kept = [];
    for (let i = 0; i < config.decoder_layers; i++) {
      for (const part of ['decoder', 'encoder'])
        for (const kind of ['key', 'value']) kept.push(`present.${i}.${part}.${kind}`);
      kept.push(`cross_attentions.${i}`);
    }
    const encoder = await createSession(await readModelFile(model, 'encoder'), provider, [
      'last_hidden_state',
    ]);
    const decoder = await createSession(await readModelFile(model, 'decoder'), provider, kept);
    if (encoder.outputNames[0] !== 'last_hidden_state' || !decoder.outputNames.includes('logits'))
      throw new Error(`${model.name} does not have the inputs and outputs expected`);
    const whisper = new Whisper(
      id,
      provider,
      encoder,
      decoder,
      new Tokenizer(vocab, added),
      generation,
      config,
      new WhisperFeatures(config.num_mel_bins),
    );
    if (provider === 'webgpu' && model.check) {
      const found = await whisper.knownAnswer();
      const expected = model.check;
      const scale = expected.samples.reduce((sum, value) => sum + Math.abs(value), 0);
      const off = expected.samples.reduce(
        (sum, value, i) => sum + Math.abs(value - found.samples[i]),
        0,
      );
      if (off > 0.06 * scale || found.top[0] !== expected.top?.[0]) {
        await whisper.release();
        const error = new Error(
          `This GPU computes ${model.name} wrongly (off by ${((100 * off) / scale).toFixed(1)}%).`,
        );
        error.name = 'GpuMismatch';
        throw error;
      }
    }
    return whisper;
  }

  /**
   * The model's answer to a fixed input, three seconds of a 440 Hz tone: 64
   * values spread through the encoder's output, and the decoder's five likeliest
   * first tokens after an English prompt. models.json records the CPU's answer.
   */
  async knownAnswer(): Promise<{ samples: number[]; top: number[] }> {
    const tone = new Float32Array(16_000 * 3).map(
      (_, i) => 0.1 * Math.sin((2 * Math.PI * 440 * i) / 16_000),
    );
    const mel = this.features.log_mel(tone);
    const encoded = (
      await this.encoder.run({
        input_features: new ort.Tensor('float32', mel, [
          1,
          this.config.num_mel_bins,
          WINDOW_FRAMES,
        ]),
      })
    ).last_hidden_state;
    try {
      const values = (await encoded.getData()) as Float32Array;
      const stride = Math.floor(values.length / 64);
      const samples = Array.from({ length: 64 }, (_, i) => Number(values[i * stride].toFixed(5)));
      const prompt = [this.startOfTranscript, this.languageToken('en'), this.transcribe];
      const outputs = await this.step(encoded, prompt, null);
      const row = Whisper.lastRow(outputs.logits);
      Whisper.release(outputs);
      const top = [...row.keys()].sort((a, b) => row[b] - row[a]).slice(0, 5);
      return { samples, top };
    } finally {
      encoded.dispose();
    }
  }

  async release() {
    await this.encoder.release();
    await this.decoder.release();
    this.features.free();
  }

  /**
   * Transcribes 16 kHz mono sound. `language` is a code (`en`, `ar`) or null to
   * detect it from the first window. `check` throws to stop (a cancelled job).
   */
  async run(
    samples: Float32Array,
    language: string | null,
    onProgress: (fraction: number) => void,
    check: () => void,
  ): Promise<Transcript> {
    const total = Math.ceil(samples.length / HOP);
    const segments: Segment[] = [];
    const pauses = Whisper.pauses(samples);
    // What earlier windows said, as OpenAI prompts each window with it: without
    // it, turbo skipped sentences after a window opened in one speaker's
    // trailing noise. Tiny skips more with it, so models.json says which do.
    const withContext = !!modelInfo(this.id).previousText;
    let context: number[] = [];
    let language_ = language;
    let seek = 0;
    let window = 0;
    while (seek < total) {
      check();
      // A window that would start in a pause starts just before the speech after it.
      const pause = pauses.find(([from, to]) => seek >= from && seek < to);
      if (pause) {
        seek = pause[1];
        continue;
      }
      const size = Math.min(WINDOW_FRAMES, total - seek);
      const offset = seek / FRAMES_PER_SECOND;
      const mel = this.features.log_mel(samples.subarray(seek * HOP, (seek + size) * HOP));
      const encoded = (
        await this.encoder.run({
          input_features: new ort.Tensor('float32', mel, [
            1,
            this.config.num_mel_bins,
            WINDOW_FRAMES,
          ]),
        })
      ).last_hidden_state;
      try {
        language_ ??= await this.detect(encoded);
        const prompt = [this.startOfTranscript, this.languageToken(language_), this.transcribe];
        const prompted = context.length
          ? [this.startOfPrevious, ...context.slice(-CONTEXT_TOKENS), ...prompt]
          : prompt;
        const decoded = await this.decodeWithFallback(encoded, prompted, window, check);
        const silent =
          decoded.noSpeech > NO_SPEECH_LIMIT && decoded.averageLogprob <= LOGPROB_LIMIT;
        if (silent || !decoded.tokens.some((token) => token < this.endOfText)) {
          seek += size;
        } else {
          const found = await this.segments(encoded, prompt, decoded, size, check);
          // A window that needed sampling well above greedy starts the context afresh.
          context = decoded.temperature > 0.5 || !withContext ? [] : [...context, ...found.tokens];
          for (const segment of found.segments)
            segments.push({
              ...segment,
              start: segment.start + offset,
              end: segment.end + offset,
              words: segment.words.map((word) => ({
                ...word,
                start: word.start + offset,
                end: word.end + offset,
              })),
            });
          seek += found.consumed;
        }
      } finally {
        encoded.dispose();
      }
      window++;
      onProgress(Math.min(1, seek / total));
    }
    return { language: language_ ?? 'en', segments };
  }

  /**
   * Pauses in spectrogram frames, from 10 ms levels (as `cgv-dsp` measures
   * them) under a threshold picked from the recording.
   */
  private static pauses(samples: Float32Array): [number, number][] {
    const levels = new Float32Array(Math.ceil(samples.length / HOP));
    for (let i = 0; i < levels.length; i++) {
      const part = samples.subarray(i * HOP, (i + 1) * HOP);
      let sum = 0;
      for (const value of part) sum += value * value;
      levels[i] = sum > 0 ? Math.max(-120, 10 * Math.log10(sum / part.length)) : -120;
    }
    const found = silences(levels, NaN, PAUSE_SECONDS, PAUSE_LEAD);
    const pauses: [number, number][] = [];
    for (let i = 0; i + 1 < found.length; i += 2)
      pauses.push([
        Math.round(found[i] * FRAMES_PER_SECOND),
        Math.round(found[i + 1] * FRAMES_PER_SECOND),
      ]);
    return pauses;
  }

  private languageToken(language: string) {
    const token = this.generation.lang_to_id[`<|${language}|>`];
    if (token === undefined) throw new Error(`Whisper does not know the language ${language}`);
    return token;
  }

  /** Runs the decoder over `ids`, after `cache` when there is one. */
  private async step(encoded: ort.Tensor, ids: number[], cache: Cache | null) {
    const feeds: Record<string, ort.Tensor> = {
      input_ids: new ort.Tensor('int64', BigInt64Array.from(ids, BigInt), [1, ids.length]),
      encoder_hidden_states: encoded,
      use_cache_branch: new ort.Tensor('bool', Uint8Array.of(cache ? 1 : 0), [1]),
    };
    for (let i = 0; i < this.layers; i++)
      for (const part of ['decoder', 'encoder'])
        for (const kind of ['key', 'value'])
          feeds[`past_key_values.${i}.${part}.${kind}`] =
            cache?.[`present.${i}.${part}.${kind}`] ?? this.empty;
    return this.decoder.run(feeds);
  }

  /** Frees a cache's GPU buffers, except those `keep` still uses. */
  private static drop(cache: Cache | null, keep: Cache | null = null) {
    if (!cache) return;
    const kept = new Set<unknown>(Object.values(keep ?? {}));
    for (const tensor of Object.values(keep ?? {}))
      if (tensor.location === 'gpu-buffer') kept.add(tensor.gpuBuffer);
    for (const tensor of Object.values(cache)) {
      const buffer = tensor.location === 'gpu-buffer' ? tensor.gpuBuffer : null;
      if (!kept.has(tensor) && !kept.has(buffer)) tensor.dispose();
    }
  }

  /** The last row of the logits output. */
  private static lastRow(logits: ort.Tensor): Float32Array {
    const [, rows, size] = logits.dims;
    return (logits.data as Float32Array).slice((rows - 1) * size, rows * size);
  }

  /** The window's most likely language, from the first token after start-of-transcript. */
  private async detect(encoded: ort.Tensor): Promise<string> {
    const outputs = await this.step(encoded, [this.startOfTranscript], null);
    const row = Whisper.lastRow(outputs.logits);
    Whisper.release(outputs);
    let best = 'en';
    let score = -Infinity;
    for (const [name, token] of Object.entries(this.generation.lang_to_id))
      if (row[token] > score) {
        score = row[token];
        best = name.slice(2, -2);
      }
    return best;
  }

  /** Frees every output of a run. */
  private static release(outputs: Record<string, ort.Tensor>) {
    for (const tensor of Object.values(outputs)) tensor.dispose();
  }

  private async decodeWithFallback(
    encoded: ort.Tensor,
    prompt: number[],
    window: number,
    check: () => void,
  ): Promise<Decoded> {
    const tries: Decoded[] = [];
    for (const temperature of TEMPERATURES) {
      const decoded = await this.decode(encoded, prompt, temperature, window, check);
      const silent = decoded.noSpeech > NO_SPEECH_LIMIT && decoded.averageLogprob < LOGPROB_LIMIT;
      const poor =
        decoded.compression > COMPRESSION_LIMIT || decoded.averageLogprob < LOGPROB_LIMIT;
      if (silent || !poor) return decoded;
      tries.push(decoded);
    }
    // When every try is poor, OpenAI keeps the last, sampled at the highest
    // temperature: noise for a whole window when one sentence in it is hard.
    // Keep the likeliest instead, as faster-whisper does, preferring tries that
    // do not repeat themselves.
    const unrepeated = tries.filter((decoded) => decoded.compression <= COMPRESSION_LIMIT);
    return (unrepeated.length ? unrepeated : tries).reduce((best, decoded) =>
      decoded.averageLogprob > best.averageLogprob ? decoded : best,
    );
  }

  /** One pass of decoding at `temperature` (0 is greedy). */
  private async decode(
    encoded: ort.Tensor,
    prompt: number[],
    temperature: number,
    window: number,
    check: () => void,
  ): Promise<Decoded> {
    const sample = random(window * 7919 + Math.round(temperature * 10));
    const tokens: number[] = [];
    const probabilities: number[] = [];
    let sum = 0;
    let noSpeech = 0;
    let cache: Cache | null = null;
    // No speech is read where the transcript starts, after any earlier text.
    const start = prompt.indexOf(this.startOfTranscript);
    try {
      let input = prompt;
      while (tokens.length < MAX_TOKENS) {
        check();
        const outputs: Record<string, ort.Tensor> = await this.step(encoded, input, cache);
        // With a cache, the decoder's encoder keys and values come back empty:
        // those of the first step serve every step.
        const next: Cache = {};
        for (const [name, tensor] of Object.entries(outputs))
          if (cache && name.includes('.encoder.')) {
            tensor.dispose();
            next[name] = cache[name];
          } else if (name.startsWith('present.')) next[name] = tensor;
          else if (name !== 'logits') tensor.dispose();
        Whisper.drop(cache, next);
        cache = next;
        if (!tokens.length) {
          const size = outputs.logits.dims[2];
          const first = logSoftmax(
            (outputs.logits.data as Float32Array).subarray(start * size, (start + 1) * size),
          );
          noSpeech = Math.exp(first[this.noSpeech]);
        }
        const { token, logprob } = this.choose(
          Whisper.lastRow(outputs.logits),
          tokens,
          temperature,
          sample,
        );
        outputs.logits.dispose();
        sum += logprob;
        if (token === this.endOfText) break;
        tokens.push(token);
        probabilities.push(Math.exp(logprob));
        input = [token];
      }
    } finally {
      Whisper.drop(cache);
    }
    const text = this.tokenizer.decode(tokens.filter((token) => token < this.endOfText));
    return {
      tokens,
      probabilities,
      averageLogprob: sum / (tokens.length + 1),
      noSpeech,
      compression: await compressionRatio(text.trim()),
      temperature,
    };
  }

  /** The next token under the suppressions and OpenAI's timestamp rules. */
  private choose(
    row: Float32Array,
    tokens: number[],
    temperature: number,
    sample: () => number,
  ): { token: number; logprob: number } {
    const logits = row.slice();
    const begin = this.timestampBegin;
    for (const token of this.suppressed) logits[token] = -Infinity;
    if (!tokens.length)
      for (const token of this.generation.begin_suppress_tokens) logits[token] = -Infinity;
    logits[this.noTimestamps] = -Infinity;
    // Timestamps come in pairs, except right before the end.
    const last = tokens.length >= 1 && tokens[tokens.length - 1] >= begin;
    const penultimate = tokens.length < 2 || tokens[tokens.length - 2] >= begin;
    if (last) {
      if (penultimate) logits.fill(-Infinity, begin);
      else logits.fill(-Infinity, 0, this.endOfText);
    }
    // They never go back, and each segment lasts at least one step.
    const stamps = tokens.filter((token) => token >= begin);
    if (stamps.length) {
      const floor =
        last && !penultimate ? stamps[stamps.length - 1] : stamps[stamps.length - 1] + 1;
      logits.fill(-Infinity, begin, floor);
    }
    // A window starts with a timestamp, within the first second.
    if (!tokens.length) {
      logits.fill(-Infinity, 0, begin);
      logits.fill(-Infinity, begin + this.generation.max_initial_timestamp_index + 1);
    }
    let logprobs = logSoftmax(logits);
    // When a timestamp is likelier than any text, it must be a timestamp.
    let stampMass = -Infinity;
    let textBest = -Infinity;
    for (let i = 0; i < logprobs.length; i++) {
      if (i >= begin) {
        const high = Math.max(stampMass, logprobs[i]);
        if (high > -Infinity)
          stampMass = high + Math.log(Math.exp(stampMass - high) + Math.exp(logprobs[i] - high));
      } else if (logprobs[i] > textBest) textBest = logprobs[i];
    }
    if (stampMass > textBest) {
      logits.fill(-Infinity, 0, begin);
      logprobs = logSoftmax(logits);
    }
    let token = 0;
    if (temperature === 0) {
      for (let i = 1; i < logits.length; i++) if (logits[i] > logits[token]) token = i;
    } else {
      const scaled = logSoftmax(logits.map((value) => value / temperature));
      let threshold = sample();
      token = scaled.length - 1;
      for (let i = 0; i < scaled.length; i++) {
        threshold -= Math.exp(scaled[i]);
        if (threshold <= 0) {
          token = i;
          break;
        }
      }
    }
    return { token, logprob: logprobs[token] };
  }

  /**
   * The window's segments with their words, in seconds from its start, how
   * many spectrogram frames it used, and the tokens of the segments kept.
   */
  private async segments(
    encoded: ort.Tensor,
    prompt: number[],
    decoded: Decoded,
    size: number,
    check: () => void,
  ): Promise<{ segments: Segment[]; consumed: number; tokens: number[] }> {
    const { tokens } = decoded;
    const begin = this.timestampBegin;
    const isStamp = (token: number) => token >= begin;
    const time = (token: number) => (token - begin) * TIME_PRECISION;
    // Pieces between consecutive timestamps.
    const pieces: { start: number; end: number; tokens: number[] }[] = [];
    const singleEnding =
      tokens.length >= 2 &&
      !isStamp(tokens[tokens.length - 2]) &&
      isStamp(tokens[tokens.length - 1]);
    const cuts: number[] = [];
    for (let i = 1; i < tokens.length; i++)
      if (isStamp(tokens[i - 1]) && isStamp(tokens[i])) cuts.push(i);
    let consumed = size;
    if (cuts.length) {
      if (singleEnding) cuts.push(tokens.length);
      let from = 0;
      for (const cut of cuts) {
        const slice = tokens.slice(from, cut);
        pieces.push({ start: time(slice[0]), end: time(slice[slice.length - 1]), tokens: slice });
        from = cut;
      }
      if (!singleEnding) consumed = (tokens[from - 1] - begin) * INPUT_STRIDE;
    } else {
      const stamps = tokens.filter(isStamp);
      const end =
        stamps.length && stamps[stamps.length - 1] !== begin
          ? time(stamps[stamps.length - 1])
          : size / FRAMES_PER_SECOND;
      pieces.push({ start: 0, end, tokens });
    }
    // Word times for every text token of the window at once.
    const text = tokens.filter((token) => token < this.endOfText);
    const probability = new Map<number, number>();
    tokens.forEach(
      (token, i) =>
        token < this.endOfText && probability.set(probability.size, decoded.probabilities[i]),
    );
    check();
    const words = await this.align(encoded, prompt, text, probability, size);
    // Each word goes to the piece its first token is in.
    const segments: Segment[] = pieces.map((piece) => ({
      start: piece.start,
      end: piece.end,
      text: this.tokenizer.decode(piece.tokens.filter((token) => token < this.endOfText)).trim(),
      words: [],
    }));
    const counts = pieces.map(
      (piece) => piece.tokens.filter((token) => token < this.endOfText).length,
    );
    let piece = 0;
    let passed = 0;
    for (const word of words) {
      while (piece < counts.length - 1 && word.first >= passed + counts[piece])
        passed += counts[piece++];
      segments[piece].words.push(word.word);
    }
    // Segments the model puts after the sound has ended are made up.
    const limit = size / FRAMES_PER_SECOND;
    const kept = segments.filter((segment) => segment.words.length && segment.start < limit);
    for (const segment of kept) {
      segment.start = Math.min(segment.start, segment.words[0].start);
      segment.end = Math.min(
        limit,
        Math.max(segment.end, segment.words[segment.words.length - 1].end),
      );
    }
    // With word times, a window whose last segment ran on resumes after its last word.
    const lastWord = kept.at(-1)?.words.at(-1);
    if (!singleEnding && cuts.length && lastWord)
      consumed = Math.max(1, Math.min(size, Math.round(lastWord.end * FRAMES_PER_SECOND)));
    // OpenAI skips the rest of a window the model ended early, taking it for
    // silence; small models end windows mid-speech, so resume where it stopped
    // (a silent rest then reads as silence). Not for the window's last second.
    const stamps = tokens.filter(isStamp);
    const stopped = stamps.length ? (stamps[stamps.length - 1] - begin) * INPUT_STRIDE : 0;
    const early = singleEnding || !cuts.length;
    if (early && stopped >= FRAMES_PER_SECOND && size - stopped >= FRAMES_PER_SECOND)
      consumed = stopped;
    const said = pieces.flatMap((piece, i) => (kept.includes(segments[i]) ? piece.tokens : []));
    return { segments: kept, consumed, tokens: said };
  }

  /**
   * Word times from the alignment heads: the decoder reads the window's text
   * once more without timestamps, and its cross-attention says when each token
   * was heard.
   */
  private async align(
    encoded: ort.Tensor,
    prompt: number[],
    text: number[],
    probability: Map<number, number>,
    size: number,
  ): Promise<{ word: Word; first: number }[]> {
    if (!text.length) return [];
    const ids = [...prompt, this.noTimestamps, ...text, this.endOfText];
    const outputs = await this.step(encoded, ids, null);
    const rows = text.length + 1;
    const frames = Math.min(Math.floor(size / INPUT_STRIDE), 1500);
    const heads = this.generation.alignment_heads;
    const weights = new Float32Array(heads.length * rows * frames);
    try {
      const layers = new Map<number, Float32Array>();
      for (const [layer] of heads)
        if (!layers.has(layer))
          layers.set(layer, (await outputs[`cross_attentions.${layer}`].getData()) as Float32Array);
      const [, , sequence, positions] = outputs[`cross_attentions.${heads[0][0]}`].dims;
      heads.forEach(([layer, head], h) => {
        const data = layers.get(layer)!;
        for (let r = 0; r < rows; r++) {
          // Row r of the matrix is the position that predicts text token r.
          const at = (head * sequence + prompt.length + r) * positions;
          weights.set(data.subarray(at, at + frames), (h * rows + r) * frames);
        }
      });
    } finally {
      Whisper.release(outputs);
    }
    const times = token_times(weights, heads.length, rows, frames);
    const groups = this.tokenizer.words([...text, this.endOfText]);
    groups.pop();
    let boundary = 0;
    let words: { word: Word; first: number }[] = groups.map((group) => {
      const first = boundary;
      boundary += group.tokens.length;
      const chances = group.tokens.map((_, i) => probability.get(first + i) ?? 0);
      return {
        first,
        word: {
          text: group.text,
          start: times[first],
          end: times[Math.min(boundary, times.length - 1)],
          probability: chances.reduce((a, b) => a + b, 0) / Math.max(1, chances.length),
        },
      };
    });
    // Words that seem to last far longer than most are spanning a pause: trim them.
    const durations = words
      .map(({ word }) => word.end - word.start)
      .filter((duration) => duration > 0)
      .sort((a, b) => a - b);
    const median = Math.min(0.7, durations[durations.length >> 1] ?? 0.7);
    const longest = median * 2;
    words.forEach(({ word }, i) => {
      if (word.end - word.start <= longest) return;
      if (i === 0) word.start = word.end - longest;
      else word.end = word.start + longest;
    });
    const merged = mergePunctuation(words.map(({ word, first }) => ({ ...word, first })));
    // Words keep their leading space: one without follows the last directly ("100%").
    words = merged.map(({ first, ...word }) => ({ word, first }));
    return words;
  }
}
