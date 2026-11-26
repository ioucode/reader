// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpTtsEngine } from '../src/render/tts-http.ts';

/**
 * The HTTP engine's queue and its failure modes.
 *
 * Two things are worth testing here and both are the reason the engine exists at
 * all: that the queue advances on the `<audio>` element's own `ended` event rather
 * than on a timer (a timer drifts and overlaps), and that a *misconfigured* server
 * is reported rather than played as silence. The second is the failure a reader
 * cannot diagnose — an `<audio>` element that loads a web page plays nothing and
 * fires no error.
 */

/**
 * A fake `<audio>` that fires nothing until the test says so.
 *
 * `play()` resolving is not the same as playback starting, and the engine must
 * not assume otherwise: the queue has to advance on `ended`.
 */
class FakeAudio extends EventTarget {
  src = '';
  volume = 1;
  preload = '';
  playbackRate = 1;
  paused = true;
  playCalls = 0;
  pauseCalls = 0;


  play(): Promise<void> {
    this.playCalls += 1;
    this.paused = false;
    return Promise.resolve();
  }

  pause(): void {
    this.pauseCalls += 1;
    this.paused = true;
  }

  removeAttribute(_name: string): void {
    this.src = '';
  }

  load(): void {
    // Releasing the source is what the engine does when it is done with an
    // element; nothing to simulate beyond accepting the call.
  }

  /** Fires a registered event, as the media element would. */
  fire(type: string): void {
    this.dispatchEvent(new Event(type));
  }
}

function makeEngine(options: {
  chunks: string[][];
  baseUrl?: string;
  token?: string | null;
  playFails?: boolean;
}): { engine: HttpTtsEngine; audios: FakeAudio[]; spoken: string[]; errors: string[] } {
  const audios: FakeAudio[] = [];
  const spoken: string[] = [];
  const errors: string[] = [];
  let round = 0;

  const engine = new HttpTtsEngine({
    baseUrl: options.baseUrl ?? 'http://nas.local:8080',
    accessToken: () => options.token ?? null,
    createAudio: () => {
      const audio = new FakeAudio();
      audios.push(audio);
      if (options.playFails) {
        audio.play = () => Promise.reject(new Error('blocked'));
      }
      return audio as unknown as HTMLAudioElement;
    },
    setTimeout: () => 0 as unknown as ReturnType<typeof setTimeout>,
    clearTimeout: () => undefined,
    onError: (message) => errors.push(message),
  });

  engine.setQueueLoader(async () => {
    const texts = options.chunks[Math.min(round, options.chunks.length - 1)] ?? [];
    round += 1;
    return { chunks: texts.map((text) => ({ text })), startIndex: 0 };
  });

  engine.onState((snapshot) => {
    if (snapshot.chunk) spoken.push(snapshot.chunk);
  });

  return { engine, audios, spoken, errors };
}

it('uses the current configured waiting limit for each sentence',async()=>{
  let timeout=65000;
  const schedule=vi.fn(()=>0 as unknown as ReturnType<typeof setTimeout>);
  const engine=new HttpTtsEngine({baseUrl:'http://nas.local',accessToken:()=>null,requestTimeoutMs:()=>timeout,
    createAudio:()=>new FakeAudio() as unknown as HTMLAudioElement,setTimeout:schedule,clearTimeout:()=>{}});
  engine.setQueueLoader(async()=>({chunks:[{text:'试听。'}],startIndex:0}));
  await engine.play(0);expect(schedule).toHaveBeenLastCalledWith(expect.any(Function),65000);
  engine.stop();timeout=35000;await engine.play(0);expect(schedule).toHaveBeenLastCalledWith(expect.any(Function),35000);engine.stop();
});

describe('HttpTtsEngine', () => {
  it('asks the server one sentence at a time, with the token in the query', async () => {
    const { engine, audios } = makeEngine({ chunks: [['第一句。', '第二句。']], token: 'tok-123' });

    await engine.play(0);
    expect(audios).toHaveLength(1);
    // The token rides in the query because an `<audio src>` cannot carry a header
    // — see the module header, and the server's `queryTokenAllowed`.
    expect(audios[0]!.src).toContain('/api/v1/tts?');
    expect(audios[0]!.src).toContain('access_token=tok-123');
    expect(audios[0]!.src).toContain(encodeURIComponent('第一句。'));
  });

  it('advances only when the audio element reports it finished', async () => {
    const { engine, audios } = makeEngine({ chunks: [['一。', '二。', '三。']] });

    await engine.play(0);
    expect(audios).toHaveLength(1);
    const audio = audios[0]!;
    expect(audio.playCalls).toBe(1);
    audio.fire('ended');
    expect(audio.src).toContain(encodeURIComponent('二。'));
    audio.fire('ended');
    expect(audio.src).toContain(encodeURIComponent('三。'));
    expect(audio.playCalls).toBe(3);
    expect(audios).toHaveLength(1);
  });

  it('resumes the same clip after a pause', async () => {
    const { engine, audios } = makeEngine({ chunks: [['一。', '二。']] });
    await engine.play(0);
    const audio = audios[0]!;
    const source = audio.src;
    engine.pause();
    expect(audio.paused).toBe(true);
    engine.resume();
    expect(audio.paused).toBe(false);
    expect(audio.src).toBe(source);
    expect(engine.snapshot.index).toBe(0);
  });

  it('stops speaking when the reader stops, and releases the element', async () => {
    const { engine, audios } = makeEngine({ chunks: [['一。', '二。']] });
    await engine.play(0);

    engine.stop();
    expect(engine.active).toBe(false);
    expect(audios[0]!.pauseCalls).toBeGreaterThan(0);
    // Releasing matters: an element left with a `src` keeps a network buffer alive,
    // and one per sentence would leak a chapter's worth of them.
    expect(audios[0]!.src).toBe('');
  });

  it('reports a blocked autoplay instead of a bar that says "playing"', async () => {
    const { engine, errors } = makeEngine({ chunks: [['一。']], playFails: true });
    await engine.play(0);
    // The rejection is asynchronous; a microtask turn is enough for the catch.
    await Promise.resolve();
    await Promise.resolve();
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain('播放');
  });

  it('applies a rate change to the audio already in flight', async () => {
    const { engine, audios } = makeEngine({ chunks: [['一。', '二。']] });
    await engine.play(0);
    engine.setRate(1.5);
    // Unlike the system engine, this one does not have to restart the sentence:
    // `playbackRate` is a property of the element. That difference is why the two
    // engines are separate implementations rather than one with a flag.
    expect(audios[0]!.playbackRate).toBe(1.5);
  });

  it('applies the rate once — on the element, never also in the synthesis request', async () => {
    const { engine, audios } = makeEngine({ chunks: [['一。', '二。']] });
    engine.setRate(1.5);
    await engine.play(0);
    expect(audios[0]!.playbackRate).toBe(1.5);
    expect(new URL(audios[0]!.src).searchParams.has('speed')).toBe(false);
  });

  it('asks for the next chapter when the queue runs out, when the reader allowed it', async () => {
    const { engine, audios } = makeEngine({ chunks: [['一。'], ['二。']] });
    await engine.play(0);
    audios[0]!.fire('ended');
    // The queue ran out, so the loader is consulted again — which is the same
    // handshake the system engine uses, and the place a chapter transition happens.
    await Promise.resolve();
    await Promise.resolve();
    expect(audios).toHaveLength(1);
    expect(audios[0]!.src).toContain(encodeURIComponent('二。'));
  });

  it('will not build a URL without a server, and says so rather than failing silently', async () => {
    const { engine, errors } = makeEngine({ chunks: [['一。']], baseUrl: '' });
    await engine.play(0);
    expect(errors.length).toBeGreaterThan(0);
    expect(engine.active).toBe(false);
  });

  it('probes the server and answers null when it has no engine', async () => {
    const engine = new HttpTtsEngine({ baseUrl: 'http://nas.local:8080', accessToken: () => null });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ http: false, formats: [], maxLength: 800, voices: [] }), { status: 200 }),
    );
    expect(await engine.probe()).toBeNull();

    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({ http: true, formats: ['audio/mpeg'], maxLength: 800, voices: [{ id: 'v1', name: '晓晓', lang: 'zh-CN' }] }),
        { status: 200 },
      ),
    );
    const capabilities = await engine.probe();
    expect(capabilities?.http).toBe(true);
    expect(capabilities?.voices).toHaveLength(1);
    fetchSpy.mockRestore();
  });
});


describe('HTTP audio prefetch', () => {
  afterEach(() => vi.unstubAllGlobals());

  function mockPrefetch() {
    let respond!: (response: Response) => void;
    const fetchAudio = vi.fn((_url: string, _init: RequestInit) => new Promise<Response>((resolve) => { respond = resolve; }));
    const createObjectURL = vi.fn(() => 'blob:test-clip');
    const revokeObjectURL = vi.fn();
    const MockURL = class extends URL {
      static override createObjectURL = createObjectURL;
      static override revokeObjectURL = revokeObjectURL;
    };
    vi.stubGlobal('fetch', fetchAudio);
    vi.stubGlobal('URL', MockURL);
    const resolveAudio = () => respond(new Response('audio', { headers: { 'content-type': 'audio/mpeg' } }));
    return { fetchAudio, respond: (response: Response) => respond(response), resolveAudio, revokeObjectURL };
  }

  it('requests only the next clip, reuses its in-flight download and releases its URL', async () => {
    const { fetchAudio, resolveAudio, revokeObjectURL } = mockPrefetch();
    const { engine, audios } = makeEngine({ chunks: [['一。', '二。', '三。']], token: 'reader-token' });
    await engine.play(0);
    const audio = audios[0]!;
    expect(fetchAudio).not.toHaveBeenCalled();

    audio.fire('playing');
    expect(fetchAudio).toHaveBeenCalledExactlyOnceWith(
      'http://nas.local:8080/api/v1/tts?text=' + encodeURIComponent('二。'),
      expect.objectContaining({ headers: { accept: 'audio/*', authorization: 'Bearer reader-token' } }),
    );
    audio.fire('ended');
    expect(audio.playCalls).toBe(1);
    expect(fetchAudio).toHaveBeenCalledTimes(1);

    resolveAudio();
    await vi.waitFor(() => expect(audio.src).toBe('blob:test-clip'));
    expect(audio.playCalls).toBe(2);
    expect(audios).toHaveLength(1);

    audio.fire('playing');
    expect(fetchAudio).toHaveBeenCalledTimes(2);
    engine.stop();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:test-clip');
    expect(engine.active).toBe(false);
  });

  it('retries with the regular playback URL if prefetch fails', async () => {
    const { respond } = mockPrefetch();
    const { engine, audios, errors } = makeEngine({ chunks: [['一。', '二。']] });
    await engine.play(0);
    const audio = audios[0]!;
    audio.fire('playing');
    respond(new Response(null, { status: 503 }));
    audio.fire('ended');

    await vi.waitFor(() => expect(audio.src).toContain(encodeURIComponent('二。')));
    expect(errors).toEqual([]);
    expect(audio.playCalls).toBe(2);
    engine.stop();
  });

  it.each(['jump', 'stop', 'voice'] as const)('discards stale prefetch on %s', async (action) => {
    const { fetchAudio, resolveAudio } = mockPrefetch();
    const { engine, audios } = makeEngine({ chunks: [['一。', '二。', '三。']] });
    engine.setVoice('old');
    await engine.play(0);
    const audio = audios[0]!;
    audio.fire('playing');
    const [, request] = fetchAudio.mock.calls[0]!;
    resolveAudio();

    if (action === 'jump') engine.jump(2);
    if (action === 'stop') engine.stop();
    if (action === 'voice') engine.setVoice('new');
    expect(request.signal?.aborted).toBe(true);
    await Promise.resolve();

    if (action === 'voice') {
      expect(fetchAudio.mock.calls[1]![0]).toContain('voice=new');
      expect(audio.src).toContain('voice=old');
    } else if (action === 'jump') {
      expect(audio.src).toContain(encodeURIComponent('三。'));
    } else {
      expect(audio.src).toBe('');
    }
    engine.stop();
  });
});
