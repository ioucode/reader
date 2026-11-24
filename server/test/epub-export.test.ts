import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import JSZip from 'jszip';
import { AppError } from '../src/lib/errors.ts';
import { EpubExportService, buildEpub, paragraphs, privateAddress, safeName } from '../src/services/epub-export.ts';
import type { SourceHost } from '../src/services/source-host.ts';

describe('epub export helpers', () => {
  test('safeName keeps Chinese titles and strips path characters', () => {
    assert.equal(safeName('淫书生'), '淫书生');
    assert.equal(safeName('../a/b:c*?'), 'a b c');
    assert.equal(safeName('   '), '未命名');
    assert.equal(safeName('x'.repeat(300)).length, 100);
  });

  test('paragraphs splits plain text and strips HTML safely', () => {
    assert.deepEqual(paragraphs('　　第一段\n\n　　第二段', 'text/plain; charset=utf-8'), ['第一段', '第二段']);
    assert.deepEqual(paragraphs('<p>一 &amp; 二</p><script>alert(1)</script><p>三<br>四</p>', 'text/html'), ['一 & 二', '三', '四']);
  });

  test('privateAddress rejects internal ranges', () => {
    for (const ip of ['10.0.0.1', '127.0.0.1', '172.16.3.4', '192.168.1.1', '169.254.1.1', '100.64.0.1', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1']) assert.equal(privateAddress(ip), true, ip);
    for (const ip of ['1.1.1.1', '104.16.0.1', '2606:4700::1']) assert.equal(privateAddress(ip), false, ip);
  });

  test('buildEpub writes a valid container with mimetype first and escaped text', async () => {
    const bytes = await buildEpub({ ref: '1', title: '书 <&>', authors: ['甲'], description: '简介' },
      [{ title: '第1章', paragraphs: ['a < b', '控制\u0001字符'] }]);
    const zip = await JSZip.loadAsync(bytes);
    assert.equal(Object.keys(zip.files)[0], 'mimetype');
    assert.equal(await zip.file('mimetype')!.async('string'), 'application/epub+zip');
    const opf = await zip.file('OEBPS/content.opf')!.async('string');
    assert.match(opf, /<dc:title>书 &lt;&amp;&gt;<\/dc:title>/);
    const chapter = await zip.file('OEBPS/c00001.xhtml')!.async('string');
    assert.match(chapter, /<p>a &lt; b<\/p><p>控制字符<\/p>/);
  });
});

describe('EpubExportService', () => {
  const host = (overrides: Partial<Record<string, unknown>> = {}) => ({
    chapterPublication: async () => ({ entry: { ref: 'e1', title: '测试书', authors: ['乙'] }, publicationRef: 'p1', sourceName: '某书源' }),
    manifest: async () => ({ publicationRef: 'p1', items: [
      { id: 'a', seq: 0, title: '一', kind: 'chapter', mediaType: 'text/plain', ref: 'r1' },
      { id: 'b', seq: 1, title: '二', kind: 'chapter', mediaType: 'text/plain', ref: 'r2' },
    ] }),
    resource: async (_u: string, _s: string, _p: string, ref: string) => ({ mediaType: 'text/plain; charset=utf-8', text: `正文 ${ref}` }),
    ...overrides,
  }) as unknown as SourceHost;
  const until = async (fn: () => boolean) => { for (let i = 0; i < 200 && !fn(); i++) await new Promise((r) => setTimeout(r, 10)); };

  test('saves <source>/<title>.epub and reports progress', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'epub-export-'));
    try {
      const service = new EpubExportService(host(), dir);
      const job = service.start('u1', 's1', 'e1');
      await until(() => job.state !== 'running');
      assert.equal(job.state, 'done', job.error);
      assert.equal(job.done, 2); assert.equal(job.total, 2);
      assert.equal(job.file, '某书源/测试书.epub');
      const zip = await JSZip.loadAsync(await readFile(join(dir, '某书源', '测试书.epub')));
      assert.match(await zip.file('OEBPS/c00002.xhtml')!.async('string'), /正文 r2/);
      assert.throws(() => service.get('u2', job.id), /导出任务不存在/);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  test('runs one export at a time and retries a busy source', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'epub-export-'));
    try {
      let busy = 1;
      const service = new EpubExportService(host({
        resource: async (_u: string, _s: string, _p: string, ref: string) => {
          if (busy-- > 0) throw new AppError(429, 'RATE_LIMITED', 'busy');
          return { mediaType: 'text/plain', text: ref };
        },
      }), dir);
      const job = service.start('u1', 's1', 'e1');
      assert.equal(service.start('u1', 's1', 'e1'), job);
      assert.throws(() => service.start('u1', 's1', 'other'), /正在保存/);
      await until(() => job.state !== 'running');
      assert.equal(job.state, 'done', job.error);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
