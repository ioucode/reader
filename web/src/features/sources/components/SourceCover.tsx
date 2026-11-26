import { useEffect, useRef, useState } from 'react';
import { useRuntime } from '../../../app/providers/runtime-context.tsx';
import { coverTint } from '../../../ui/cover-tint.ts';

/** The only links a source cover may load: the server's own signed proxy (sent with the user's credentials). */
const PROXY_PREFIX = '/api/v1/source-covers?';

/**
 * A source result's cover, loaded through the server's cover proxy
 * (`coverProxyUrl`), never straight from the source's site.
 *
 * - Entries without a cover draw nothing, so cover-less sources keep compact rows;
 *   a cover that fails keeps its slot as a tinted placeholder so the row does not jump.
 * - Loading starts only when the row comes near the viewport (a search can return
 *   thousands of results) and is cancelled if the row scrolls away or unmounts first;
 *   a busy proxy (503) is retried a few times with backoff while the row is visible.
 * - The image is held as an object URL owned by this component and revoked on
 *   unmount, so repeated searches do not pile up blobs.
 */
export function SourceCover({ url, title, large = false }: { url: string | undefined; title: string; large?: boolean }) {
  const { api } = useRuntime();
  const link = url?.startsWith(PROXY_PREFIX) ? url : undefined;
  const box = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(false);
  const [src, setSrc] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  // Track (not just latch) visibility: a row scrolled away cancels its pending request.
  useEffect(() => {
    if (!link || src) return;
    const node = box.current;
    if (!node || typeof IntersectionObserver === 'undefined') { setNear(true); return; }
    const observer = new IntersectionObserver(entries => setNear(entries.some(entry => entry.isIntersecting)), { rootMargin: '300px' });
    observer.observe(node);
    return () => observer.disconnect();
  }, [link, src]);

  useEffect(() => { setSrc(null); setAttempt(0); }, [link]);

  useEffect(() => {
    if (!link || !near || src) return;
    const controller = new AbortController();
    let retry: ReturnType<typeof setTimeout> | undefined;
    void api.coverBytes(link, { signal: controller.signal }).then(bytes => {
      if (controller.signal.aborted) return;
      setSrc(URL.createObjectURL(new Blob([bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer])));
    }).catch((reason: unknown) => {
      // The proxy answers 503 when too many covers are loading; retry a few times while still visible.
      if (!controller.signal.aborted && (reason as { status?: number } | null)?.status === 503 && attempt < 4) {
        retry = setTimeout(() => setAttempt(value => value + 1), 1000 * 2 ** attempt);
      }
    });
    return () => { controller.abort(); if (retry) clearTimeout(retry); };
  }, [api, link, near, attempt, src]);

  // The object URL belongs to this component: released when replaced or unmounted.
  useEffect(() => () => { if (src) URL.revokeObjectURL(src); }, [src]);

  if (!link) return null;
  return <div ref={box} className={'source-cover' + (large ? ' is-large' : '')} aria-hidden="true">
    {src ? <img src={src} alt="" /> : <div className="placeholder" style={coverTint(title)} />}
  </div>;
}
