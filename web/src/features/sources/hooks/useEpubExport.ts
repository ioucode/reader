import { useRef, useState } from 'react';
import type { SourceEntry } from '../../../api/sources.ts';
import { useRuntime } from '../../../app/providers/runtime-context.tsx';
import { notify } from '../../../ui/notifications.ts';

/**
 * 「保存 EPUB」: starts a server-side export of one source entry and follows its
 * progress in a single loading notice. Saving never touches the shelf; the file
 * lands in the server's EPUB archive (<书源>/<书名>.epub).
 */
export function useEpubExport(sourceId: string) {
  const { api } = useRuntime();
  const [savingRef, setSavingRef] = useState<string | null>(null);
  const running = useRef(false);

  const save = async (entry: SourceEntry) => {
    if (running.current || !sourceId) return;
    running.current = true; setSavingRef(entry.ref);
    const notice = Symbol('epub-export');
    notify(`正在准备保存《${entry.title}》…`, { kind: 'loading' }, notice);
    try {
      let job = await api.startEpubExport(sourceId, entry.ref);
      while (job.state === 'running') {
        notify(job.total ? `正在保存《${job.title || entry.title}》${job.done}/${job.total} 章` : `正在准备保存《${entry.title}》…`, { kind: 'loading' }, notice);
        await new Promise(resolve => setTimeout(resolve, 1500));
        job = await api.epubExport(job.id);
      }
      if (job.state === 'done') notify(`已保存 EPUB：${job.file ?? job.title}`, { kind: 'success' }, notice);
      else notify(job.error || '保存 EPUB 失败', { kind: 'error' }, notice);
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : '保存 EPUB 失败', { kind: 'error' }, notice);
    } finally {
      running.current = false; setSavingRef(null);
    }
  };
  return { save, savingRef };
}
