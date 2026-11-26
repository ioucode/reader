import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { SourceCovers } from '../src/services/source-covers.ts';
import { fetchableImageUrl } from '../src/lib/remote-image.ts';

const image = { bytes: new Uint8Array([1, 2, 3]), mediaType: 'image/png' };
const token = (covers: SourceCovers, url: string) => new URL(covers.proxyPath(url)!, 'http://x').searchParams.get('t');

describe('SourceCovers', () => {
  test('adds an opaque proxy path only for fetchable cover URLs', () => {
    const covers = new SourceCovers('secret', async () => image);
    const entry = covers.entry({ ref: 'a', title: 't', coverUrl: 'https://example.com/c.jpg?sig=upstream-secret' });
    assert.match(entry.coverProxyUrl ?? '', /^\/api\/v1\/source-covers\?t=[\w-]+$/);
    assert.ok(!entry.coverProxyUrl!.includes('example') && !entry.coverProxyUrl!.includes('upstream-secret'), 'upstream URL is not in the link');
    assert.equal(covers.proxyPath('https://example.com/c.jpg'), covers.proxyPath('https://example.com/c.jpg'), 'stable per URL');
    for (const coverUrl of [undefined, 'ftp://example.com/c.jpg', 'https://user:pw@example.com/c.jpg', 'http://127.0.0.1/c.jpg', 'http://[::1]/c.jpg', 'data:image/png;base64,AA']) {
      assert.equal(covers.entry({ ref: 'a', title: 't', ...(coverUrl ? { coverUrl } : {}) }).coverProxyUrl, undefined, coverUrl);
    }
    // A plugin cannot choose the link the browser fetches with the user's credentials.
    const forged = covers.entry({ ref: 'a', title: 't', coverProxyUrl: 'https://evil.example/steal' } as never) as { coverProxyUrl?: string };
    assert.equal(forged.coverProxyUrl, undefined);
    const replaced = covers.entry({ ref: 'a', title: 't', coverUrl: 'https://example.com/c.jpg', coverProxyUrl: 'https://evil.example/' } as never) as { coverProxyUrl?: string };
    assert.match(replaced.coverProxyUrl ?? '', /^\/api\/v1\/source-covers\?t=/);
    const page = covers.page({ items: [{ ref: 'a', title: 't', coverUrl: 'http://example.com/x.png' }] });
    assert.ok(page.items[0]!.coverProxyUrl);
    assert.equal(fetchableImageUrl('http://10.0.0.1/x.png'), false);
  });

  test('serves only tokens it issued, and shares one fetch per URL', async () => {
    let fetches = 0; const seen: string[] = [];
    const covers = new SourceCovers('secret', async (url) => { fetches++; seen.push(url!); await new Promise(r => setTimeout(r, 10)); return image; });
    const t = token(covers, 'https://example.com/c.jpg');
    const signal = new AbortController().signal;
    const [a, b] = await Promise.all([covers.load(t, signal), covers.load(t, signal)]);
    assert.equal(a, image); assert.equal(b, image);
    assert.equal(await covers.load(t, signal), image);
    assert.equal(fetches, 1);
    assert.deepEqual(seen, ['https://example.com/c.jpg']);
    const tampered = t!.slice(0, 20) + (t![20] === 'A' ? 'B' : 'A') + t!.slice(21); // a middle char always changes the bytes
    await assert.rejects(covers.load(tampered, signal), /invalid cover link/);
    await assert.rejects(covers.load('x', signal), /invalid cover link/);
    await assert.rejects(covers.load(undefined, signal), /invalid cover link/);
    await assert.rejects(new SourceCovers('other', async () => image).load(t, signal), /invalid cover link/);
  });

  test('a failed fetch is "no image", not an error', async () => {
    const covers = new SourceCovers('secret', async () => { throw new Error('boom'); });
    assert.equal(await covers.load(token(covers, 'https://example.com/c.jpg'), new AbortController().signal), undefined);
  });

  test('a cover nobody waits for any more is not fetched; too many pending covers answer busy', async () => {
    const started: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const covers = new SourceCovers('secret', async (url, signal) => {
      started.push(url!);
      await Promise.race([gate, new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))]);
      return image;
    });
    const link = (n: number) => token(covers, `https://example.com/${n}.jpg`);
    const callers = Array.from({ length: 64 }, (_, n) => { const controller = new AbortController();
      return { controller, done: covers.load(link(n), controller.signal).catch(error => error) }; });
    await assert.rejects(covers.load(link(99), new AbortController().signal), /too many covers/);
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(started.length, 4);
    for (const caller of callers.slice(4)) caller.controller.abort();
    await Promise.all(callers.slice(4).map(caller => caller.done));
    // Cancelled waiters left the queue at once, so the bound applies to live work only.
    assert.equal((covers as unknown as { queue: unknown[] }).queue.length, 0);
    const late = new AbortController();
    const lateDone = covers.load(link(100), late.signal).catch(error => error);
    late.abort(); await lateDone;
    release();
    await Promise.all(callers.slice(0, 4).map(caller => caller.done));
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(started.length, 4, 'abandoned covers were never fetched');
    assert.equal((covers as unknown as { queue: unknown[] }).queue.length, 0, 'cancelled waiters leave the queue');
  });
});
