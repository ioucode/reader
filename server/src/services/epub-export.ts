import { randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import JSZip from 'jszip';
import sanitize from 'sanitize-html';
import type { FastifyBaseLogger } from 'fastify';
import { AppError, badRequest, conflict, notFound } from '../lib/errors.ts';
import type { CatalogEntry, ResourceResponse } from '../sources/types.ts';
import type { SourceHost } from './source-host.ts';

/**
 * 「保存 EPUB」: turns a chapter source entry into an EPUB file under
 * EPUB_EXPORT_DIR (default DATA_DIR/epub-archive), laid out as
 * `<source name>/<title>.epub`. Nothing is added to any shelf.
 *
 * The directory is server-owned and deliberately outside BOOKS_DIR, so an
 * archive never re-enters the library scan; mirroring it elsewhere (OneDrive
 * in the codearea deployment) is the deployment's job.
 *
 * Export is one job at a time and reads chapters sequentially through the
 * same SourceHost calls the reader uses, so it never hammers a site harder
 * than reading does. A busy source (429) is retried with backoff.
 */

export type EpubExportState = 'running' | 'done' | 'failed';
export interface EpubExportJob {
  id: string;
  userId: string;
  sourceId: string;
  entryRef: string;
  title: string;
  state: EpubExportState;
  done: number;
  total: number;
  file?: string;
  error?: string;
  startedAt: number;
  finishedAt?: number;
}

const MAX_CHAPTERS = 20_000;
const MAX_CHAPTER_BYTES = 8 * 1024 * 1024;
const MAX_COVER_BYTES = 5 * 1024 * 1024;
const MAX_KEPT_JOBS = 20;
const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((done, fail) => {
  if (signal.aborted) { fail(signal.reason); return; }
  const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); done(); }, ms);
  const onAbort = () => { clearTimeout(timer); fail(signal.reason); };
  signal.addEventListener('abort', onAbort, { once: true });
});

export class EpubExportService {
  private readonly jobs = new Map<string, EpubExportJob>();
  private running: { job: EpubExportJob; controller: AbortController } | null = null;
  readonly dir: string;

  constructor(private readonly host: SourceHost, dir: string, private readonly log?: FastifyBaseLogger) {
    this.dir = resolve(dir);
  }

  start(userId: string, sourceId: string, entryRef: string): EpubExportJob {
    const current = this.running?.job;
    if (current) {
      if (current.sourceId === sourceId && current.entryRef === entryRef) return current;
      throw conflict(`正在保存《${current.title || '另一本书'}》,完成后再试`, 'EXPORT_BUSY');
    }
    const job: EpubExportJob = { id: randomUUID(), userId, sourceId, entryRef, title: '', state: 'running', done: 0, total: 0, startedAt: Date.now() };
    this.remember(job);
    const controller = new AbortController();
    this.running = { job, controller };
    void this.run(job, controller.signal).then(
      (file) => { job.state = 'done'; job.file = file; },
      (error) => {
        job.state = 'failed';
        job.error = error instanceof AppError ? error.message : '保存 EPUB 失败';
        this.log?.warn({ sourceId, code: error instanceof AppError ? error.code : 'EXPORT_FAILED' }, 'epub export failed');
      },
    ).finally(() => { job.finishedAt = Date.now(); this.running = null; });
    return job;
  }

  get(userId: string, jobId: string): EpubExportJob {
    const job = this.jobs.get(jobId);
    if (!job || job.userId !== userId) throw notFound('导出任务不存在', 'EXPORT_NOT_FOUND');
    return job;
  }

  close(): void { this.running?.controller.abort(new AppError(503, 'EXPORT_STOPPED', '服务正在停止')); }

  private remember(job: EpubExportJob): void {
    this.jobs.set(job.id, job);
    while (this.jobs.size > MAX_KEPT_JOBS) this.jobs.delete(this.jobs.keys().next().value!);
  }

  private async run(job: EpubExportJob, signal: AbortSignal): Promise<string> {
    const { entry, publicationRef, sourceName } = await this.retrying(() => this.host.chapterPublication(job.userId, job.sourceId, job.entryRef, signal), signal);
    job.title = entry.title;
    const manifest = await this.retrying(() => this.host.manifest(job.userId, job.sourceId, publicationRef, signal), signal);
    const items = manifest.items.filter((item) => item.kind === 'chapter');
    if (!items.length) throw badRequest('这本书没有章节', 'EMPTY_BOOK');
    if (items.length > MAX_CHAPTERS) throw badRequest(`章节数超过 ${MAX_CHAPTERS},暂不支持保存`, 'BOOK_TOO_LARGE');
    job.total = items.length;

    const chapters: Array<{ title: string; paragraphs: string[] }> = [];
    for (const item of items) {
      signal.throwIfAborted();
      const resource = await this.retrying(() => this.host.resource(job.userId, job.sourceId, publicationRef, item.ref, signal), signal);
      chapters.push({ title: item.title, paragraphs: paragraphs(await readText(resource), resource.mediaType) });
      job.done++;
    }
    const cover = await fetchCover(entry.coverUrl, signal).catch(() => undefined);
    const bytes = await buildEpub(entry, chapters, cover);

    const target = this.target(sourceName || manifest.sourceName || job.sourceId, entry.title);
    await mkdir(dirname(target), { recursive: true });
    const temporary = `${target}.${randomUUID()}.part`;
    try {
      await writeFile(temporary, bytes);
      await rename(temporary, target);
    } finally { await rm(temporary, { force: true }); }
    this.log?.info({ sourceId: job.sourceId, chapters: items.length, bytes: bytes.byteLength }, 'epub export saved');
    return relative(this.dir, target).split(sep).join('/');
  }

  private target(source: string, title: string): string {
    const file = resolve(this.dir, safeName(source), `${safeName(title)}.epub`);
    const rel = relative(this.dir, file);
    if (!rel || rel.startsWith('..') || rel.includes(`..${sep}`)) throw badRequest('invalid export path', 'PATH_TRAVERSAL');
    return file;
  }

  /** The reader and an export share the source's two-call budget; wait instead of failing. */
  private async retrying<T>(action: () => Promise<T>, signal: AbortSignal): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try { return await action(); }
      catch (error) {
        const retryable = error instanceof AppError && (error.statusCode === 429 || error.statusCode === 503 || error.statusCode === 504);
        if (!retryable || attempt >= 5) throw error;
        await sleep(1000 * 2 ** Math.min(attempt, 4), signal);
      }
    }
  }
}

/** File-system-safe, still human readable (Chinese titles stay intact). */
export function safeName(value: string): string {
  const cleaned = value.normalize('NFC').replace(/[\u0000-\u001f\u007f/\\:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/^\.+/, '').trim();
  return (cleaned || '未命名').slice(0, 100);
}

async function readText(resource: ResourceResponse): Promise<string> {
  if (resource.text !== undefined) return resource.text;
  if (resource.data) return Buffer.from(resource.data).subarray(0, MAX_CHAPTER_BYTES).toString('utf8');
  if (resource.stream) {
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of resource.stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      size += buffer.byteLength;
      if (size > MAX_CHAPTER_BYTES) { resource.stream.destroy(); break; }
      chunks.push(buffer);
    }
    return Buffer.concat(chunks).toString('utf8');
  }
  return '';
}

export function paragraphs(text: string, mediaType: string): string[] {
  let plain = text;
  if (/html|xml/i.test(mediaType)) {
    plain = sanitize(text.replace(/<\s*br\s*\/?>/gi, '\n').replace(/<\/(p|div|h[1-6]|li|section|article)\s*>/gi, '\n'),
      { allowedTags: [], allowedAttributes: {}, nonTextTags: ['script', 'style', 'textarea', 'noscript', 'title'] });
    plain = decodeEntities(plain);
  }
  return plain.split(/\n+|　　/).map((line) => line.replace(/^[\s　]+/, '').trim()).filter(Boolean);
}

function decodeEntities(value: string): string {
  const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code: string) => {
    if (code[0] === '#') {
      const point = code[1]?.toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(point) && point > 0 && point < 0x110000 ? String.fromCodePoint(point) : match;
    }
    return named[code.toLowerCase()] ?? match;
  });
}

const xml = (value: string) => value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]!))
  // XML 1.0 forbids most control characters; a single one makes the whole chapter unreadable.
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '');

function xhtml(title: string, body: string): string {
  return '<?xml version="1.0" encoding="utf-8"?>\n<!DOCTYPE html>\n<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="zh-CN">'
    + `<head><meta charset="utf-8"/><title>${xml(title)}</title><link rel="stylesheet" type="text/css" href="style.css"/></head>`
    + `<body>${body}</body></html>`;
}

export async function buildEpub(entry: CatalogEntry, chapters: Array<{ title: string; paragraphs: string[] }>, cover?: { bytes: Uint8Array; mediaType: string }): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  zip.file('META-INF/container.xml', '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">'
    + '<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
  zip.file('OEBPS/style.css', 'body{line-height:1.8;margin:0 1em}h1,h2{text-align:center;margin:1.5em 0 1em}p{text-indent:2em;margin:0 0 .6em}img{max-width:100%}');
  const manifest: string[] = ['<item id="css" href="style.css" media-type="text/css"/>', '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>'];
  const spine: string[] = [];
  let coverMeta = '';
  if (cover) {
    const ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' }[cover.mediaType] ?? 'img';
    zip.file(`OEBPS/cover.${ext}`, cover.bytes);
    zip.file('OEBPS/cover.xhtml', xhtml('封面', `<div style="text-align:center"><img src="cover.${ext}" alt="封面"/></div>`));
    manifest.push(`<item id="cover-image" href="cover.${ext}" media-type="${cover.mediaType}" properties="cover-image"/>`, '<item id="cover" href="cover.xhtml" media-type="application/xhtml+xml"/>');
    spine.push('<itemref idref="cover" linear="no"/>');
    coverMeta = '<meta name="cover" content="cover-image"/>';
  }
  const authors = entry.authors?.filter(Boolean) ?? [];
  const intro = `<h1>${xml(entry.title)}</h1>${authors.length ? `<p>作者：${xml(authors.join('、'))}</p>` : ''}`
    + (entry.description ?? '').split(/\n+/).filter(Boolean).map((line) => `<p>${xml(line)}</p>`).join('');
  zip.file('OEBPS/intro.xhtml', xhtml(entry.title, intro));
  manifest.push('<item id="intro" href="intro.xhtml" media-type="application/xhtml+xml"/>');
  spine.push('<itemref idref="intro"/>');
  const toc: string[] = [];
  chapters.forEach((chapter, index) => {
    const name = `c${String(index + 1).padStart(5, '0')}.xhtml`;
    zip.file(`OEBPS/${name}`, xhtml(chapter.title, `<h2>${xml(chapter.title)}</h2>${chapter.paragraphs.map((p) => `<p>${xml(p)}</p>`).join('')}`));
    manifest.push(`<item id="c${index + 1}" href="${name}" media-type="application/xhtml+xml"/>`);
    spine.push(`<itemref idref="c${index + 1}"/>`);
    toc.push(`<li><a href="${name}">${xml(chapter.title)}</a></li>`);
  });
  zip.file('OEBPS/nav.xhtml', '<?xml version="1.0" encoding="utf-8"?>\n<!DOCTYPE html>\n<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="zh-CN">'
    + `<head><meta charset="utf-8"/><title>目录</title></head><body><nav epub:type="toc" id="toc"><h1>目录</h1><ol>${toc.join('')}</ol></nav></body></html>`);
  const modified = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  zip.file('OEBPS/content.opf', '<?xml version="1.0" encoding="utf-8"?>'
    + '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" xml:lang="zh-CN">'
    + '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">'
    + `<dc:identifier id="bookid">urn:uuid:${randomUUID()}</dc:identifier><dc:title>${xml(entry.title)}</dc:title>`
    + authors.map((author) => `<dc:creator>${xml(author)}</dc:creator>`).join('')
    + `<dc:language>${xml(entry.language || 'zh-CN')}</dc:language>`
    + (entry.description ? `<dc:description>${xml(entry.description)}</dc:description>` : '')
    + `<meta property="dcterms:modified">${modified}</meta>${coverMeta}</metadata>`
    + `<manifest>${manifest.join('')}</manifest><spine>${spine.join('')}</spine></package>`);
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 6 }, mimeType: 'application/epub+zip' });
}

/** Covers come from plugin-supplied URLs: https only, public addresses only, bounded size. */
async function fetchCover(url: string | undefined, signal: AbortSignal): Promise<{ bytes: Uint8Array; mediaType: string } | undefined> {
  if (!url) return undefined;
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return undefined;
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  if (!addresses.length || addresses.some(({ address }) => privateAddress(address))) return undefined;
  const response = await fetch(parsed, { redirect: 'manual', signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]) });
  const mediaType = (response.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  if (!response.ok || !['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(mediaType)) { await response.body?.cancel(); return undefined; }
  const chunks: Uint8Array[] = []; let size = 0;
  for await (const chunk of response.body ?? []) {
    size += chunk.byteLength;
    if (size > MAX_COVER_BYTES) return undefined;
    chunks.push(chunk);
  }
  return { bytes: Buffer.concat(chunks), mediaType };
}

export function privateAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a = 0, b = 0] = address.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  const lower = address.toLowerCase();
  if (lower.startsWith('::ffff:')) return privateAddress(lower.slice(7));
  return lower === '::' || lower === '::1' || /^f[cd]/.test(lower) || /^fe[89ab]/.test(lower) || lower.startsWith('ff');
}

export function exportDir(config: { dataDir: string }): string {
  return resolve(process.env.EPUB_EXPORT_DIR || join(config.dataDir, 'epub-archive'));
}
