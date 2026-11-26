import { createHmac, timingSafeEqual } from 'node:crypto';
import { AppError, badRequest } from '../lib/errors.ts';
import { fetchableImageUrl, fetchRemoteImage, type RemoteImage } from '../lib/remote-image.ts';
import type { CatalogEntry, CatalogPage } from '../sources/types.ts';

/**
 * Source result covers, loaded through this server.
 *
 * A source entry's `coverUrl` points at the source's own site. The browser does
 * not load it directly: that would hand the user's address to every source and
 * break on hotlink protection. Instead each entry the server returns carries a
 * `coverProxyUrl` — `/api/v1/source-covers?u=<url>&s=<signature>` — and the
 * proxy only fetches URLs carrying a signature this server issued, so it is not
 * an open proxy: it can only reach images some source already returned, and
 * still only public http(s) addresses (see lib/remote-image.ts).
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
const PROXY_PATH = '/api/v1/source-covers';

interface Pending { promise: Promise<RemoteImage | undefined>; waiters: number; controller: AbortController }

export class SourceCovers {
  private readonly key: Buffer;
  private readonly cache = new Map<string, { image?: RemoteImage; at: number }>();
  private cacheBytes = 0;
  private active = 0;
  private readonly queue: Array<() => void> = [];
  private readonly pending = new Map<string, Pending>();

  constructor(secret: string, private readonly fetcher: typeof fetchRemoteImage = fetchRemoteImage) {
    this.key = createHmac('sha256', 'reader/source-covers/v1').update(secret).digest();
  }

  /** The browser-facing path for a cover, or undefined when the URL is not something the proxy would fetch. */
  proxyPath(url: string | undefined): string | undefined {
    if (!fetchableImageUrl(url)) return undefined;
    try {
      // Sign the normalized form: it is what gets encoded, sent back and fetched.
      const href = new URL(url).href;
      if (!fetchableImageUrl(href)) return undefined;
      return `${PROXY_PATH}?u=${encodeURIComponent(href)}&s=${this.sign(href)}`;
    } catch { return undefined; } // e.g. a lone surrogate encodeURIComponent refuses
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
  async load(url: unknown, signature: unknown, signal: AbortSignal): Promise<RemoteImage | undefined> {
    if (typeof url !== 'string' || typeof signature !== 'string' || !this.verify(url, signature)) {
      throw new AppError(403, 'COVER_SIGNATURE', 'invalid cover link');
    }
    if (!fetchableImageUrl(url)) throw badRequest('invalid cover link', 'COVER_URL');
    const cached = this.cache.get(url);
    if (cached && (cached.image || Date.now() - cached.at < CACHE_FAILURE_MS)) {
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
    await this.slot();
    try {
      if (signal.aborted) return undefined; // nobody is waiting any more; do not fetch or cache
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

  private slot(): Promise<void> {
    if (this.active < MAX_CONCURRENT) { this.active++; return Promise.resolve(); }
    return new Promise((resolve) => this.queue.push(() => { this.active++; resolve(); }));
  }

  private release(): void {
    this.active--;
    this.queue.shift()?.();
  }

  private sign(url: string): string {
    return createHmac('sha256', this.key).update(url).digest('base64url').slice(0, 32);
  }

  private verify(url: string, signature: string): boolean {
    const expected = Buffer.from(this.sign(url));
    const given = Buffer.from(signature);
    return given.length === expected.length && timingSafeEqual(given, expected);
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
