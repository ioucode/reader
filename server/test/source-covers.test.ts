import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { SourceCovers } from '../src/services/source-covers.ts';
import { fetchableImageUrl } from '../src/lib/remote-image.ts';

const image = { bytes: new Uint8Array([1, 2, 3]), mediaType: 'image/png' };

describe('SourceCovers', () => {
  test('adds a signed proxy path only for fetchable cover URLs', () => {
    const covers = new SourceCovers('secret', async () => image);
    const entry = covers.entry({ ref: 'a', title: 't', coverUrl: 'https://example.com/c.jpg' });
    assert.match(entry.coverProxyUrl ?? '', /^\/api\/v1\/source-covers\?u=https%3A%2F%2Fexample\.com%2Fc\.jpg&s=[\w-]{32}$/);
    for (const coverUrl of [undefined, 'ftp://example.com/c.jpg', 'https://user:pw@example.com/c.jpg', 'http://127.0.0.1/c.jpg', 'http://[::1]/c.jpg', 'data:image/png;base64,AA']) {
      assert.equal(covers.entry({ ref: 'a', title: 't', ...(coverUrl ? { coverUrl } : {}) }).coverProxyUrl, undefined, coverUrl);
    }
    // A plugin cannot choose the link the browser fetches with the user's credentials.
    const forged = covers.entry({ ref: 'a', title: 't', coverProxyUrl: 'https://evil.example/steal' } as never) as { coverProxyUrl?: string };
    assert.equal(forged.coverProxyUrl, undefined);
    const replaced = covers.entry({ ref: 'a', title: 't', coverUrl: 'https://example.com/c.jpg', coverProxyUrl: 'https://evil.example/' } as never) as { coverProxyUrl?: string };
    assert.match(replaced.coverProxyUrl ?? '', /^\/api\/v1\/source-covers\?/);
    // Malformed (lone surrogate) is skipped, not thrown.
    assert.equal(covers.proxyPath('https://example.com/\ud800.jpg')?.startsWith('/api/v1/source-covers?') ?? true, true);
    const page = covers.page({ items: [{ ref: 'a', title: 't', coverUrl: 'http://example.com/x.png' }] });
    assert.ok(page.items[0]!.coverProxyUrl);
    assert.equal(fetchableImageUrl('http://10.0.0.1/x.png'), false);
  });

  test('serves only URLs it signed, and shares one fetch per URL', async () => {
    let fetches = 0;
    const covers = new SourceCovers('secret', async () => { fetches++; await new Promise(r => setTimeout(r, 10)); return image; });
    const path = covers.proxyPath('https://example.com/c.jpg')!;
    const params = new URL(path, 'http://x').searchParams;
    const signal = new AbortController().signal;
    const [a, b] = await Promise.all([covers.load(params.get('u'), params.get('s'), signal), covers.load(params.get('u'), params.get('s'), signal)]);
    assert.equal(a, image); assert.equal(b, image);
    assert.equal(await covers.load(params.get('u'), params.get('s'), signal), image);
    assert.equal(fetches, 1);
    await assert.rejects(covers.load('https://example.com/other.jpg', params.get('s'), signal), /invalid cover link/);
    await assert.rejects(covers.load(params.get('u'), 'x', signal), /invalid cover link/);
    await assert.rejects(new SourceCovers('other', async () => image).load(params.get('u'), params.get('s'), signal), /invalid cover link/);
  });

  test('a failed fetch is "no image", not an error', async () => {
    const covers = new SourceCovers('secret', async () => { throw new Error('boom'); });
    const params = new URL(covers.proxyPath('https://example.com/c.jpg')!, 'http://x').searchParams;
    assert.equal(await covers.load(params.get('u'), params.get('s'), new AbortController().signal), undefined);
  });

  test('a cover nobody waits for any more is not fetched; too many pending covers answer busy', async () => {
    const started: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const covers = new SourceCovers('secret', async (url, signal) => {
      started.push(url);
      await Promise.race([gate, new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))]);
      return image;
    });
    const link = (n: number) => new URL(covers.proxyPath(`https://example.com/${n}.jpg`)!, 'http://x').searchParams;
    const callers = Array.from({ length: 64 }, (_, n) => { const controller = new AbortController(); const p = link(n);
      return { controller, done: covers.load(p.get('u'), p.get('s'), controller.signal).catch(error => error) }; });
    const extra = link(99);
    await assert.rejects(covers.load(extra.get('u'), extra.get('s'), new AbortController().signal), /too many covers/);
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(started.length, 4);
    for (const caller of callers.slice(4)) caller.controller.abort();
    await Promise.all(callers.slice(4).map(caller => caller.done));
    // Cancelled waiters left the queue at once, so the bound applies to live work only.
    assert.equal((covers as unknown as { queue: unknown[] }).queue.length, 0);
    const again = link(100);
    const late = new AbortController();
    const lateDone = covers.load(again.get('u'), again.get('s'), late.signal).catch(error => error);
    late.abort(); await lateDone;
    release();
    await Promise.all(callers.slice(0, 4).map(caller => caller.done));
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(started.length, 4, 'abandoned covers were never fetched');
    assert.equal((covers as unknown as { queue: unknown[] }).queue.length, 0, 'cancelled waiters leave the queue');
  });
});
