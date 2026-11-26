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
});
