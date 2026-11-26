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
 *   thousands of results) and is cancelled if the row goes away first.
 * - The image is held as an object URL owned by this component and revoked on
 *   unmount, so repeated searches do not pile up blobs.
 */
export function SourceCover({ url, title, large = false }: { url: string | undefined; title: string; large?: boolean }) {
  const { api } = useRuntime();
  const link = url?.startsWith(PROXY_PREFIX) ? url : undefined;
  const box = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(false);
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    if (!link || near) return;
    const node = box.current;
    if (!node || typeof IntersectionObserver === 'undefined') { setNear(true); return; }
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { setNear(true); observer.disconnect(); }
    }, { rootMargin: '300px' });
    observer.observe(node);
    return () => observer.disconnect();
  }, [link, near]);

  useEffect(() => {
    setSrc(null);
    if (!link || !near) return;
    const controller = new AbortController();
    let objectUrl: string | null = null;
    void api.coverBytes(link, { signal: controller.signal }).then(bytes => {
      if (controller.signal.aborted) return;
      objectUrl = URL.createObjectURL(new Blob([bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer]));
      setSrc(objectUrl);
    }).catch(() => undefined);
    return () => { controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [api, link, near]);

  if (!link) return null;
  return <div ref={box} className={'source-cover' + (large ? ' is-large' : '')} aria-hidden="true">
    {src ? <img src={src} alt="" /> : <div className="placeholder" style={coverTint(title)} />}
  </div>;
}
