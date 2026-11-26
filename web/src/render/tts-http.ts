/**
 * Read-aloud, over HTTP.
 *
 * The second of the reader's two engines, and the one that exists because the
 * first one cannot always be there: `speechSynthesis` is missing from Firefox on
 * Linux and from plenty of Android builds, and a device with no Chinese voice
 * installed will read a novel in a language the reader does not speak. Neither is
 * a bug the reader can fix, so the reader offers a way out.
 *
 * ## Where the audio comes from
 *
 * The *server* holds the engine URL, not the client. A self-hosted reader's phone
 * may be on a train, and a third-party TTS key must not be shipped in a bundle
 * that anyone can open. So the client asks its own server (`GET /api/v1/tts`),
 * the server asks whatever `TTS_URL` names, and the bytes come back.
 *
 * ## Why an `<audio>` element and not Web Audio
 *
 * Three reasons, and the first is the one that decides it:
 *
 *  1. **Immediate playback uses a media URL.** An `<audio src>` cannot carry
 *     an authorization header, so the first clip uses the route's query token.
 *     While that clip plays, a separate authenticated fetch downloads the next
 *     one as a Blob. The same element plays both kinds of source.
 *  2. **The platform's own decode path.** Media decoding happens off the main
 *     thread and out of the JS heap; a 60-minute novel is a lot of audio, and
 *     Web Audio would keep it all in the renderer process.
 *  3. **The events come for free.** `ended`, `error` and `waiting` are what make
 *     a queue advance without a timer, and `playbackRate` is a real rate change
 *     rather than a re-synthesis.
 *
 * ## The one thing this engine cannot do, and says so
 *
 * A remote sentence cannot be highlighted word by word: there is no `boundary`
 * event, and the audio's timeline has no mapping back into the DOM. Sentence
 * granularity is what the highlight gets — which the system engine also gives,
 * for the same reason it does not rely on `boundary` (see `tts.ts`). The two
 * engines therefore have the same visible behaviour and differ only in where the
 * sound comes from, which is the point.
 */

import type { TtsSnapshot, TtsState, TtsVoice } from './tts.ts';

/** What the reader's server says it can do. */
export interface HttpTtsCapabilities {
  http: boolean;
  formats: string[];
  maxLength: number;
  voices: TtsVoice[];
}

export interface HttpTtsOptions {
  requestTimeoutMs?:()=>number;
  /** Absolute URL of the server, e.g. `http://192.168.1.10:8080`. */
  baseUrl: string;
  /** Bearer token; sent as a query parameter, see the note above. */
  accessToken: () => string | null;
  /** Injectable for tests: the element factory, so no audio device is needed. */
  createAudio?: () => HTMLAudioElement;
  /** Injectable for tests. */
  setTimeout?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeout?: (handle: ReturnType<typeof setTimeout>) => void;
  onError?: (message: string) => void;
}

/**
 * How long to wait for a sentence's audio before giving up.
 *
 * A local Piper wrapper answers in a second; a remote neural service on a bad
 * mobile connection can take ten. The bound exists because a request that never
 * answers must not wedge the queue — a reader listening to a book while walking
 * would otherwise find that the "next sentence" button does nothing at all.
 */
const REQUEST_TIMEOUT_MS = 20_000;

interface PrefetchedClip {
  index: number;
  controller: AbortController;
  result: Promise<Blob | null>;
}

/** Longest single utterance this engine will ask for. Mirrors the server's cap. */
export const HTTP_TTS_MAX_LENGTH = 800;

/**
 * The HTTP engine.
 *
 * Deliberately shaped like `TtsEngine` rather than sharing a base class with it:
 * the two have different failure modes (a missing voice versus an unreachable
 * server), different pause semantics, and the system engine's queue bookkeeping
 * is driven by an utterance callback that has no counterpart here. A shared base
 * would be an `if (engine === ...)` in every method.
 */
export class HttpTtsEngine {
  private readonly options: HttpTtsOptions;
  private audio: HTMLAudioElement | null = null;
  private clip: AbortController | null = null;
  private objectUrl: string | null = null;
  private hasStarted = false;
  private prefetch: PrefetchedClip | null = null;
  private state: TtsState = 'idle';
  private error = '';
  private queue: string[] = [];
  private cursor = -1;
  private rate = 1;
  private volume = 1;
  private voiceId = '';
  /** Generation counter: bumped on stop, so a late response is ignored. */
  private generation = 0;
  private timeout: ReturnType<typeof setTimeout> | null = null;
  private readonly listeners = new Set<(snapshot: TtsSnapshot) => void>();
  private loadQueue: ((from: number) => Promise<{ chunks: Array<{ text: string }>; startIndex: number } | null>) | null = null;

  constructor(options: HttpTtsOptions) {
    this.options = options;
  }

  /**
   * Capability probe.
   *
   * Answers `null` when the server has no engine configured or cannot be reached,
   * so the caller falls back to the system engine rather than showing a picker
   * that does not work.
   */
  async probe(): Promise<HttpTtsCapabilities | null> {
    const url = this.buildUrl('/api/v1/tts/voices', {});
    if (!url) return null;
    try {
      const response = await fetch(url, { headers: this.headers(), mode: 'cors', credentials: 'omit' });
      if (!response.ok) return null;
      const body = (await response.json()) as Partial<HttpTtsCapabilities>;
      if (!body.http) return null;
      return {
        http: true,
        formats: body.formats ?? ['audio/mpeg'],
        maxLength: body.maxLength ?? HTTP_TTS_MAX_LENGTH,
        voices: body.voices ?? [],
      };
    } catch {
      // Offline is the common case here, and it is not worth an error message:
      // the system engine is still available and the reader may not even care.
      return null;
    }
  }

  get snapshot(): TtsSnapshot {
    return {
      state: this.state,
      chunk: this.queue[this.cursor] ?? '',
      index: this.cursor,
      total: this.queue.length,
      rate: this.rate,
      // Synthesised audio has no pitch control that does not go through
      // `playbackRate`, and a shimmed pitch is worse than no pitch control.
      pitch: 1,
      volume: this.volume,
      voiceId: this.voiceId,
      voices: [],
      error: this.error,
    };
  }

  get active(): boolean {
    return this.state === 'playing' || this.state === 'paused';
  }

  onState(listener: (snapshot: TtsSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Bind the sentence source.
   *
   * Kept as a setter rather than a constructor argument so the engine can be
   * built before a book is open: the settings panel needs to probe the server's
   * capabilities without a document in hand.
   */
  setQueueLoader(loader: (from: number) => Promise<{ chunks: Array<{ text: string }>; startIndex: number }>): void {
    this.loadQueue = loader;
  }

  async play(from = 0): Promise<void> {
    if (!this.loadQueue) return;
    if (this.state === 'paused') {
      this.resume();
      return;
    }
    const generation = ++this.generation;
    this.cancelPrefetch();
    this.releaseClip();
    const loaded = await this.loadQueue(from);
    if (generation !== this.generation) return;
    if (!loaded || loaded.chunks.length === 0) {
      this.state = 'idle';
      this.error = '这一章没有可朗读的文字';
      this.emit();
      return;
    }
    this.queue = loaded.chunks.map((chunk) => chunk.text);
    this.cursor = clamp(loaded.startIndex, 0, this.queue.length - 1) - 1;
    this.error = '';
    this.state = 'playing';
    this.speakNext();
  }

  pause(): void {
    if (this.state !== 'playing') return;
    this.state = 'paused';
    this.clearTimeout();
    this.audio?.pause();
    this.emit();
  }

  resume(): void {
    if (this.state !== 'paused') return;
    this.state = 'playing';
    this.emit();
    if (!this.clip) return;
    if (this.audio?.ended) this.speakNext();
    else this.playClip();
  }

  stop(): void {
    this.generation += 1;
    this.cancelPrefetch();
    this.releaseClip();
    this.queue = [];
    this.cursor = -1;
    this.state = 'idle';
    this.error = '';
    this.emit();
  }

  /** Jump to a sentence by index, continuing playback. */
  jump(index: number): void {
    if (this.queue.length === 0) return;
    this.generation += 1;
    this.cursor = clamp(index, 0, this.queue.length - 1) - 1;
    this.state = 'playing';
    this.speakNext();
  }

  next(): void {
    if (this.queue.length === 0) return;
    this.jump(this.cursor + 1);
  }

  previous(): void {
    if (this.queue.length === 0) return;
    // Same rule as the system engine: a press during playback restarts the
    // current sentence, otherwise it steps back one. The two engines agreeing on
    // this is what makes switching between them invisible in use.
    const index = this.state === 'playing' ? this.cursor : this.cursor - 1;
    this.jump(Math.max(0, index));
  }

  setRate(rate: number): void {
    this.rate = clamp(rate, 0.5, 3);
    // A rate change is a property of the audio element, not a re-synthesis:
    // `playbackRate` is applied to the audio already playing, so this is the one
    // place where the HTTP engine is *better* than the system one, which has to
    // restart the sentence.
    if (this.audio) this.audio.playbackRate = this.rate;
    this.emit();
  }

  setVolume(volume: number): void {
    this.volume = clamp(volume, 0, 1);
    if (this.audio) this.audio.volume = this.volume;
    this.emit();
  }

  setVoice(voiceId: string): void {
    if (this.voiceId === voiceId) return;
    this.voiceId = voiceId;
    const wasWaitingForClip = this.prefetch?.index === this.cursor;
    this.cancelPrefetch();
    if (wasWaitingForClip) this.loadClip();
    if (this.state === 'playing' && this.hasStarted) this.prefetchNext();
    this.emit();
  }

  dispose(): void {
    this.generation += 1;
    this.cancelPrefetch();
    this.releaseClip();
    this.audio = null;
    this.queue = [];
    this.state = 'idle';
    this.listeners.clear();
  }

  // ---- internals ----

  private speakNext(): void {
    if (this.state !== 'playing') return;
    this.releaseClip();
    const nextIndex = this.cursor + 1;
    if (this.prefetch?.index !== nextIndex) this.cancelPrefetch();
    if (this.queue[nextIndex] === undefined) {
      void this.finish();
      return;
    }

    this.cursor = nextIndex;
    const generation = this.generation;
    this.emit();
    if (generation !== this.generation || this.clip) return;

    if (this.prefetch) {
      void this.playPrefetched(this.prefetch, generation);
    } else {
      this.loadClip();
    }
  }

  private async playPrefetched(prefetch: PrefetchedClip, generation: number): Promise<void> {
    const blob = await prefetch.result;
    if (this.prefetch !== prefetch || this.generation !== generation) return;
    this.prefetch = null;
    this.loadClip(blob);
  }

  private loadClip(blob: Blob | null = null): void {
    const source = blob ? URL.createObjectURL(blob) : this.sentenceUrl(this.cursor, true);
    if (!source) {
      this.fail('HTTP 朗读未配置');
      return;
    }
    if (blob) this.objectUrl = source;

    const audio = this.audio ??= this.createAudio();
    const clip = this.clip = new AbortController();
    const signal = clip.signal;
    audio.addEventListener('ended', () => this.speakNext(), { once: true, signal });
    audio.addEventListener('error', () => this.fail('朗读音频加载失败'), { once: true, signal });
    audio.addEventListener('playing', () => {
      this.clearTimeout();
      this.hasStarted = true;
      if (this.state === 'playing') this.prefetchNext();
    }, { signal });
    audio.addEventListener('waiting', () => {
      if (this.state === 'playing') this.watchForPlayback(clip);
    }, { signal });

    audio.preload = 'auto';
    audio.src = source;
    audio.playbackRate = this.rate;
    audio.volume = this.volume;
    if (this.state === 'playing') this.playClip();
  }

  private playClip(): void {
    const { audio, clip } = this;
    if (!audio || !clip) return;
    this.watchForPlayback(clip);
    void audio.play().catch((error: unknown) => {
      if (clip.signal.aborted || this.state !== 'playing') return;
      if (error instanceof DOMException && error.name === 'AbortError') return;
      this.fail('浏览器阻止了朗读播放，请再按一次播放');
    });
  }

  private watchForPlayback(clip: AbortController): void {
    if (this.timeout !== null) return;
    const schedule = this.options.setTimeout ?? setTimeout;
    this.timeout = schedule(() => {
      this.timeout = null;
      if (!clip.signal.aborted) this.speakNext();
    }, this.requestTimeout());
  }

  private prefetchNext(): void {
    if (this.prefetch) return;
    const index = this.cursor + 1;
    const url = this.sentenceUrl(index, false);
    if (!url) return;
    const controller = new AbortController();
    this.prefetch = { index, controller, result: this.fetchClip(url, controller) };
  }

  private async fetchClip(url: string, controller: AbortController): Promise<Blob | null> {
    const schedule = this.options.setTimeout ?? setTimeout;
    const timer = schedule(() => controller.abort(), this.requestTimeout());
    try {
      const response = await fetch(url, {
        headers: { ...this.headers(), accept: 'audio/*' },
        mode: 'cors',
        credentials: 'omit',
        signal: controller.signal,
      });
      if (!response.ok) return null;
      const blob = await response.blob();
      return blob.size && blob.type.startsWith('audio/') ? blob : null;
    } catch {
      return null;
    } finally {
      (this.options.clearTimeout ?? clearTimeout)(timer);
    }
  }

  private cancelPrefetch(): void {
    this.prefetch?.controller.abort();
    this.prefetch = null;
  }

  private requestTimeout(): number {
    return clamp(this.options.requestTimeoutMs?.() ?? REQUEST_TIMEOUT_MS, 1_000, 125_000);
  }

  private sentenceUrl(index: number, queryToken: boolean): string | null {
    const text = this.queue[index];
    if (text === undefined) return null;
    // The media element applies the playback rate to both kinds of source.
    return this.buildUrl('/api/v1/tts', {
      text,
      ...(this.voiceId ? { voice: this.voiceId } : {}),
    }, queryToken);
  }

  /**
   * The queue ran out. Asks the screen layer for the next chapter, exactly as the
   * system engine does, so "章节播完继续" is one implementation for both engines.
   */
  private async finish(): Promise<void> {
    const generation = ++this.generation;
    this.state = 'idle';
    this.emit();
    if (!this.loadQueue) return;
    try {
      const loaded = await this.loadQueue(this.queue.length);
      if (generation !== this.generation || !loaded || loaded.chunks.length === 0) return;
      this.queue = loaded.chunks.map((chunk) => chunk.text);
      this.cursor = clamp(loaded.startIndex, 0, this.queue.length - 1) - 1;
      this.state = 'playing';
      this.speakNext();
    } catch {
      // A chapter that will not load stops the reading; the status bar already
      // reports the connectivity problem that caused it.
    }
  }

  private fail(message: string): void {
    this.error = message;
    this.state = 'idle';
    this.cancelPrefetch();
    this.releaseClip();
    this.emit();
    this.options.onError?.(message);
  }

  /**
   * A detached, hidden audio element.
   *
   * `new Audio()` is already detached, and it is given `display: none` anyway —
   * belt and braces, for the host that hands one in. A media element is not a
   * control the reader should ever see: it has no transport the reader wants
   * (the bar has play/pause/stop, and the sentence scrubber), and a WebView that
   * *does* render one draws a black rectangle with a native player in it over the
   * book. The reader reported exactly that as "audio 需要隐藏", and the honest fix
   * is that no code path may put a visible element on screen at all.
   *
   * `aria-hidden` is the other half: a screen reader must not be told about a
   * player that is not part of the UI, or it announces a second set of controls
   * beside the bar's.
   */
  private createAudio(): HTMLAudioElement {
    const audio = this.options.createAudio ? this.options.createAudio() : new Audio();
    // Written defensively: this runs against a real media element in every
    // production host, and against a test double that models only the media API
    // the engine actually uses. A bare `audio.style.display` would make every
    // engine test depend on an element implementation that has nothing to do with
    // what is under test.
    try {
      audio.setAttribute('aria-hidden', 'true');
      audio.setAttribute('tabindex', '-1');
      if (audio.style) audio.style.display = 'none';
    } catch {
      // A double with no element API; the element is not in the document either.
    }
    return audio;
  }

  private releaseClip(): void {
    this.clearTimeout();
    this.hasStarted = false;
    if (!this.clip) return;

    this.clip.abort();
    this.clip = null;
    this.audio?.pause();
    this.audio?.removeAttribute('src');
    this.audio?.load();
    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = null;
    }
  }

  private clearTimeout(): void {
    if (this.timeout === null) return;
    (this.options.clearTimeout ?? clearTimeout)(this.timeout);
    this.timeout = null;
  }

  /**
   * Builds a URL against the server.
   *
   * The token is a query parameter and that is deliberate — see the file header.
   * It is why this engine is only ever pointed at the reader's own server: a
   * URL with a bearer token in it must not go to a third party, in logs or in a
   * `Referer` header.
   */
  private buildUrl(path: string, params: Record<string, string>, queryToken = true): string | null {
    const base = this.options.baseUrl.replace(/\/+$/, '');
    if (!base) return null;
    const query = new URLSearchParams(params);
    const token = queryToken ? this.options.accessToken() : null;
    if (token) query.set('access_token', token);
    const suffix = query.size > 0 ? `?${query.toString()}` : '';
    return `${base}${path}${suffix}`;
  }

  private headers(): Record<string, string> {
    const token = this.options.accessToken();
    return {
      accept: 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    };
  }

  private emit(): void {
    const snapshot = this.snapshot;
    for (const listener of this.listeners) listener(snapshot);
  }
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}
