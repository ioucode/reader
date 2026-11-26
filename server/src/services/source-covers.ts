import { createCipheriv, createDecipheriv, createHmac } from 'node:crypto';
import { AppError, badRequest } from '../lib/errors.ts';
import { fetchableImageUrl, fetchRemoteImage, type RemoteImage } from '../lib/remote-image.ts';
import type { CatalogEntry, CatalogPage } from '../sources/types.ts';

/**
 * Source result covers, loaded through this server.
 *
 * A source entry's `coverUrl` points at the source's own site. The browser does
 * not load it directly: that would hand the user's address to every source and
 * break on hotlink protection. Instead each entry the server returns carries a
 * `coverProxyUrl` — `/api/v1/source-covers?t=<token>`, where the token is the
 * upstream URL sealed with AES-GCM under a server key. The proxy only fetches
 * URLs inside a token this server issued, so it is not an open proxy: it can
 * only reach images some source already returned, and still only public http(s)
 * addresses (see lib/remote-image.ts). Sealing (not just signing) keeps upstream
 * URLs — which may carry the source's own signed query tokens — out of request
 * logs.
 *
 * Fetches are capped at a few at a time (a result page of 50 must not become 50
 * simultaneous requests to one site) and recent images are kept in a small
 * in-memory cache.
 */

const MAX_CONCURRENT = 4;
/** Distinct covers waiting or in flight; beyond this the proxy answers 503 instead of queueing. */
const MAX_PENDING = 64;
const CACHE_BYTES = 32 * 1024 * 1024;
const CACHE_FAILURE_MS = 10 * 60 * 1000;
/** A source may replace the image behind a cover URL; refetch after this. */
const CACHE_SUCCESS_MS = 6 * 60 * 60 * 1000;
const PROXY_PATH = '/api/v1/source-covers';

interface Pending { promise: Promise<RemoteImage | undefined>; waiters: number; controller: AbortController }

export class SourceCovers {
  private readonly key: Buffer;
  private readonly ivKey: Buffer;
  private readonly cache = new Map<string, { image?: RemoteImage; at: number }>();
  private cacheBytes = 0;
  private active = 0;
  private readonly queue: Array<{ start: () => void; signal: AbortSignal }> = [];
  private readonly pending = new Map<string, Pending>();

  constructor(secret: string, private readonly fetcher: typeof fetchRemoteImage = fetchRemoteImage) {
    this.key = createHmac('sha256', 'reader/source-covers/v1').update(secret).digest();
    this.ivKey = createHmac('sha256', 'reader/source-covers/v1/iv').update(secret).digest();
  }

  /** The browser-facing path for a cover, or undefined when the URL is not something the proxy would fetch. */
  proxyPath(url: string | undefined): string | undefined {
    if (!fetchableImageUrl(url)) return undefined;
    try {
      // Sign the normalized form: it is what gets encoded, sent back and fetched.
      const href = new URL(url).href;
      if (!fetchableImageUrl(href)) return undefined;
      return `${PROXY_PATH}?t=${this.seal(href)}`;
    } catch { return undefined; }
  }

  /**
   * The entry as the browser gets it. `coverProxyUrl` is always the server's own
   * value: a plugin-supplied one is dropped, since the client fetches it with the
   * user's credentials.
   */
  entry<T extends CatalogEntry>(entry: T): T & { coverProxyUrl?: string } {
    const { coverProxyUrl: _plugin, ...rest } = entry as T & { coverProxyUrl?: unknown };
    const path = this.proxyPath(entry.coverUrl);
    return (path ? { ...rest, coverProxyUrl: path } : rest) as T & { coverProxyUrl?: string };
  }

  page<T extends CatalogPage>(page: T): T {
    return { ...page, items: page.items.map((item) => this.entry(item)) } as T;
  }

  /** Verified fetch; undefined means "no image" (the route answers 404). */
  async load(token: unknown, signal: AbortSignal): Promise<RemoteImage | undefined> {
    const url = typeof token === 'string' ? this.open(token) : undefined;
    if (!url) throw new AppError(403, 'COVER_SIGNATURE', 'invalid cover link');
    if (!fetchableImageUrl(url)) throw badRequest('invalid cover link', 'COVER_URL');
    const cached = this.cache.get(url);
    if (cached && Date.now() - cached.at < (cached.image ? CACHE_SUCCESS_MS : CACHE_FAILURE_MS)) {
      this.cache.delete(url); this.cache.set(url, cached); // LRU touch
      return cached.image;
    }
    // Concurrent requests for one cover share one upstream fetch; it is abandoned
    // (dequeued or aborted) once no request is waiting for it any more.
    let shared = this.pending.get(url);
    if (!shared) {
      if (this.pending.size >= MAX_PENDING) throw new AppError(503, 'COVER_BUSY', 'too many covers loading');
      const controller = new AbortController();
      const entry: Pending = { waiters: 0, controller, promise: Promise.resolve(undefined) };
      entry.promise = this.fetch(url, controller.signal).finally(() => { if (this.pending.get(url) === entry) this.pending.delete(url); });
      this.pending.set(url, entry);
      shared = entry;
    }
    const current = shared;
    current.waiters++;
    try { return await abortable(current.promise, signal); }
    finally {
      if (--current.waiters === 0 && this.pending.get(url) === current) {
        current.controller.abort();
        this.pending.delete(url);
      }
    }
  }

  private async fetch(url: string, signal: AbortSignal): Promise<RemoteImage | undefined> {
    if (!await this.slot(signal)) return undefined; // abandoned while queued: never fetched, never cached
    try {
      if (signal.aborted) return undefined;
      const image = await this.fetcher(url, AbortSignal.any([signal, AbortSignal.timeout(20_000)])).catch(() => undefined);
      if (!signal.aborted) this.remember(url, image);
      return image;
    } finally { this.release(); }
  }

  private remember(url: string, image: RemoteImage | undefined): void {
    const old = this.cache.get(url);
    if (old?.image) this.cacheBytes -= old.image.bytes.byteLength;
    this.cache.delete(url);
    this.cache.set(url, { image, at: Date.now() });
    if (image) this.cacheBytes += image.bytes.byteLength;
    while ((this.cacheBytes > CACHE_BYTES || this.cache.size > 2000) && this.cache.size) {
      const [oldest, value] = this.cache.entries().next().value!;
      this.cache.delete(oldest);
      if (value.image) this.cacheBytes -= value.image.bytes.byteLength;
    }
  }

  /** Resolves true holding a fetch slot, or false (without one) if `signal` aborts while queued. */
  private slot(signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return Promise.resolve(false);
    if (this.active < MAX_CONCURRENT) { this.active++; return Promise.resolve(true); }
    return new Promise((resolve) => {
      const waiter = {
        signal,
        start: () => { signal.removeEventListener('abort', onAbort); this.active++; resolve(true); },
      };
      const onAbort = () => {
        const index = this.queue.indexOf(waiter);
        if (index >= 0) this.queue.splice(index, 1);
        resolve(false);
      };
      signal.addEventListener('abort', onAbort, { once: true });
      this.queue.push(waiter);
    });
  }

  private release(): void {
    this.active--;
    this.queue.shift()?.start();
  }

  private seal(url: string): string {
    // Deterministic per URL (SIV-style): one cover keeps one link, so browser caching works;
    // equal tokens reveal only that two links are the same cover.
    const iv = createHmac('sha256', this.ivKey).update(url).digest().subarray(0, 12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const body = Buffer.concat([cipher.update(url, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, body, cipher.getAuthTag()]).toString('base64url');
  }

  /** The sealed URL, or undefined for anything this server did not issue (GCM authenticates it). */
  private open(token: string): string | undefined {
    if (token.length > 4096) return undefined;
    const raw = Buffer.from(token, 'base64url');
    if (raw.length < 12 + 16 + 1) return undefined;
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.key, raw.subarray(0, 12));
      decipher.setAuthTag(raw.subarray(raw.length - 16));
      return Buffer.concat([decipher.update(raw.subarray(12, raw.length - 16)), decipher.final()]).toString('utf8');
    } catch { return undefined; }
  }
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}
