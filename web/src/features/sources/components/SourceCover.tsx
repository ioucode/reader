import { useRuntime } from '../../../app/providers/runtime-context.tsx';
import { useCover } from '../../shelf/pages/ShelfPage.tsx';
import { coverTint } from '../../../ui/cover-tint.ts';

/**
 * A source result's cover, loaded through the server's signed cover proxy
 * (`coverProxyUrl`), never straight from the source's site. Entries without a
 * cover draw nothing, so cover-less sources keep their compact rows; a cover
 * that fails to load keeps its slot as a tinted placeholder so the row does
 * not jump.
 */
export function SourceCover({ url, title, large = false }: { url: string | undefined; title: string; large?: boolean }) {
  const { api } = useRuntime();
  const src = useCover(api, url);
  if (!url) return null;
  return <div className={'source-cover' + (large ? ' is-large' : '')} aria-hidden="true">
    {src ? <img src={src} alt="" loading="lazy" /> : <div className="placeholder" style={coverTint(title)} />}
  </div>;
}
