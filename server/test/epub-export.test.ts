import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import JSZip from 'jszip';
import { AppError } from '../src/lib/errors.ts';
import { EpubExportService, buildEpub, inside, paragraphs, privateAddress, safeName } from '../src/services/epub-export.ts';
import type { SourceHost } from '../src/services/source-host.ts';

describe('epub export helpers', () => {
  test('safeName keeps Chinese titles, strips path characters and caps UTF-8 bytes', () => {
    assert.equal(safeName('淫书生'), '淫书生');
    assert.equal(safeName('../a/b:c*?'), 'a b c');
    assert.equal(safeName('   '), '未命名');
    assert.ok(Buffer.byteLength(safeName('书'.repeat(300))) <= 150);
    assert.equal(safeName('书'.repeat(300), 30), '书'.repeat(10));
  });

  test('inside compares whole path components', () => {
    assert.equal(inside('/books', '/books'), true);
    assert.equal(inside('/books', '/books/a/..x'), true);
    assert.equal(inside('/books', '/books-archive'), false);
    assert.equal(inside('/books', '/data/epub-archive'), false);
  });

  test('paragraphs splits plain text, strips HTML and keeps a note for illustrations', () => {
    assert.deepEqual(paragraphs('　　第一段\n\n　　第二段', 'text/plain; charset=utf-8'), ['第一段', '第二段']);
    assert.deepEqual(paragraphs('<p>一 &amp; 二</p><script>alert(1)</script><p>三<br>四</p>', 'text/html'), ['一 & 二', '三', '四']);
    assert.deepEqual(paragraphs('<p><img alt="a>b" src="reader-res:a">图注</p>', 'text/html'), ['（此处有插图，未保存到 EPUB）', '图注']);
    assert.deepEqual(paragraphs('\u200b\ufeff\n正文\u200b', 'text/plain'), ['正文']);
  });

  test('privateAddress rejects internal ranges', () => {
    for (const ip of ['10.0.0.1', '127.0.0.1', '172.16.3.4', '192.168.1.1', '169.254.1.1', '100.64.0.1', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1', '::ffff:a00:1', '::ffff:7f00:1']) assert.equal(privateAddress(ip), true, ip);
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
    // Array order deliberately differs from reading order (seq).
    manifest: async () => ({ publicationRef: 'p1', items: [
      { id: 'b', seq: 1, title: '二', kind: 'chapter', mediaType: 'text/plain', ref: 'r2' },
      { id: 'a', seq: 0, title: '一', kind: 'chapter', mediaType: 'text/plain', ref: 'r1' },
    ] }),
    resource: async (_u: string, _s: string, _p: string, ref: string) => ({ mediaType: 'text/plain; charset=utf-8', text: `正文 ${ref}` }),
    ...overrides,
  }) as unknown as SourceHost;
  const until = async (fn: () => boolean) => { for (let i = 0; i < 300 && !fn(); i++) await new Promise((r) => setTimeout(r, 10)); };
  const fixture = async () => {
    const root = await mkdtemp(join(tmpdir(), 'epub-export-'));
    await mkdir(join(root, 'books'));
    return { root, dir: join(root, 'archive'), books: join(root, 'books') };
  };

  test('saves <source>/<title> [<digest>].epub in seq order and reports progress', async () => {
    const { root, dir, books } = await fixture();
    try {
      const service = new EpubExportService(host(), dir, books);
      const job = service.start('u1', 's1', 'e1');
      await until(() => job.state !== 'running');
      assert.equal(job.state, 'done', job.error);
      assert.equal(job.done, 2); assert.equal(job.total, 2);
      assert.match(job.file ?? '', /^某书源\/测试书 \[[0-9a-f]{8}\]\.epub$/);
      assert.deepEqual(await readdir(join(dir, '某书源')), [job.file!.split('/')[1]]);
      const zip = await JSZip.loadAsync(await readFile(join(dir, job.file!)));
      assert.match(await zip.file('OEBPS/c00001.xhtml')!.async('string'), /<h2>一<\/h2><p>正文 r1<\/p>/);
      assert.match(await zip.file('OEBPS/c00002.xhtml')!.async('string'), /正文 r2/);
      assert.throws(() => service.get('u2', job.id), /导出任务不存在/);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test('runs one export at a time, per admin, and retries a busy source', async () => {
    const { root, dir, books } = await fixture();
    try {
      let busy = 1;
      const service = new EpubExportService(host({
        resource: async (_u: string, _s: string, _p: string, ref: string) => {
          if (busy-- > 0) throw new AppError(429, 'RATE_LIMITED', 'busy');
          return { mediaType: 'text/plain', text: ref };
        },
      }), dir, books);
      const job = service.start('u1', 's1', 'e1');
      assert.equal(service.start('u1', 's1', 'e1'), job);
      assert.throws(() => service.start('u2', 's1', 'e1'), /正在保存/);
      assert.throws(() => service.start('u1', 's1', 'other'), /正在保存/);
      await until(() => job.state !== 'running');
      assert.equal(job.state, 'done', job.error);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test('fails instead of saving an archive with an empty chapter', async () => {
    const { root, dir, books } = await fixture();
    try {
      const service = new EpubExportService(host({
        resource: async (_u: string, _s: string, _p: string, ref: string) => ({ mediaType: 'text/plain', text: ref === 'r2' ? '  \n ' : '正文' }),
      }), dir, books);
      const job = service.start('u1', 's1', 'e1');
      await until(() => job.state !== 'running');
      assert.equal(job.state, 'failed');
      assert.match(job.error ?? '', /没有可读文字/);
      await assert.rejects(readdir(join(dir, '某书源')));
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test('refuses an archive directory inside the library', async () => {
    const { root, books } = await fixture();
    try {
      const service = new EpubExportService(host(), join(books, 'archive'), books);
      const job = service.start('u1', 's1', 'e1');
      await until(() => job.state !== 'running');
      assert.equal(job.state, 'failed');
      assert.match(job.error ?? '', /不能在书库目录里/);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test('fails on an illustration-only chapter and on invalid UTF-8', async () => {
    for (const [declared, resource, pattern] of [
      ['text/html', { mediaType: 'text/html', text: '<p><img src="reader-res:x"></p>' }, /插图章节/],
      ['text/plain', { mediaType: 'text/plain', data: new Uint8Array([0xff, 0xfe, 0xfd]) }, /UTF-8/],
      ['text/plain', { mediaType: 'image/png', text: 'x' }, /文本章节/],
      ['text/html', { mediaType: 'text/plain', text: '<p>声明是 HTML,实际是纯文本</p>' }, /文本章节/],
      ['text/plain', { mediaType: 'text/plain', text: '\u0000\u0001\u202e' }, /没有可读文字/],
    ] as const) {
      const { root, dir, books } = await fixture();
      try {
        const manifest = async () => ({ publicationRef: 'p1', items: [{ id: 'a', seq: 0, title: '一', kind: 'chapter', mediaType: declared, ref: 'r1' }] });
        const service = new EpubExportService(host({ manifest, resource: async () => resource }), dir, books);
        const job = service.start('u1', 's1', 'e1');
        await until(() => job.state !== 'running');
        assert.equal(job.state, 'failed');
        assert.match(job.error ?? '', pattern);
      } finally { await rm(root, { recursive: true, force: true }); }
    }
  });

  test('reports the path relative to the real archive when it is a symlink', async () => {
    const { root, books } = await fixture();
    try {
      await mkdir(join(root, 'real-archive'));
      await symlink(join(root, 'real-archive'), join(root, 'link-archive'));
      const service = new EpubExportService(host(), join(root, 'link-archive'), books);
      const job = service.start('u1', 's1', 'e1');
      await until(() => job.state !== 'running');
      assert.equal(job.state, 'done', job.error);
      assert.match(job.file ?? '', /^某书源\//);
      await readFile(join(root, 'real-archive', job.file!));
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
