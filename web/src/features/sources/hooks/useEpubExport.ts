import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { SourceEntry } from '../../../api/sources.ts';
import { useRuntime } from '../../../app/providers/runtime-context.tsx';
import { notify } from '../../../ui/notifications.ts';

/**
 * 「保存 EPUB」: starts a server-side export of one source entry and follows its
 * progress in a single loading notice. The file lands in the server's EPUB
 * archive (<书源>/<书名>.epub) and the server also puts a copy on this user's
 * shelf (replacing an earlier export of the same book).
 */
export function useEpubExport(sourceId: string) {
  const { api } = useRuntime();
  const queryClient = useQueryClient();
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
      if (job.state === 'done' && job.bookId) {
        // A re-export can replace an earlier copy: refresh every list that may show it.
        await Promise.all([queryClient.invalidateQueries({ queryKey: ['shelf'] }), queryClient.invalidateQueries({ queryKey: ['home', 'reading'] })]);
        notify(`已保存 EPUB 并加入书架：《${job.title || entry.title}》`, { kind: 'success' }, notice);
      } else if (job.state === 'done') notify(`已保存 EPUB：${job.file ?? job.title}(加入书架失败：${job.shelfError || '未知原因'})`, { kind: 'error' }, notice);
      else notify(job.error || '保存 EPUB 失败', { kind: 'error' }, notice);
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : '保存 EPUB 失败', { kind: 'error' }, notice);
    } finally {
      running.current = false; setSavingRef(null);
    }
  };
  return { save, savingRef };
}
