import { createHash, randomUUID } from 'node:crypto';
import { mkdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import JSZip from 'jszip';
import { Parser } from 'htmlparser2';
import type { FastifyBaseLogger } from 'fastify';
import { AppError, badRequest, conflict, notFound } from '../lib/errors.ts';
import { chapterMedia } from '../publications/rich-content.ts';
import { fetchRemoteImage } from '../lib/remote-image.ts';
import type { CatalogEntry, ResourceResponse } from '../sources/types.ts';
import type { SourceHost } from './source-host.ts';

/**
 * 「保存 EPUB」: turns a chapter source entry into an EPUB file under
 * EPUB_EXPORT_DIR (default DATA_DIR/epub-archive), laid out as
 * `<source name>/<title> [<entry ref>].epub`. The finished file is then also
 * imported for the exporting user exactly like a source file download
 * (`FileAcquisitions.importExported`: a copy under DATA_DIR/acquired, put on
 * that user's shelf), so it can be read without waiting for any library scan.
 * Re-exporting the same entry replaces the previous copy on that shelf.
 *
 * The directory is server-owned and must resolve outside BOOKS_DIR, so an
 * archive never re-enters the library scan; mirroring it elsewhere (OneDrive
 * in the codearea deployment) is the deployment's job.
 *
 * Export is one job at a time and reads chapters sequentially (in manifest
 * `seq` order) through the same SourceHost calls the reader uses, so it never
 * hammers a site harder than reading does. A busy source (429) is retried with
 * backoff. Anything that would make the archive silently incomplete — an empty
 * chapter, a book too large to hold in memory — fails the job instead.
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
  /** The shelf copy; absent when the archive was saved but the shelf import failed (see shelfError). */
  bookId?: string;
  shelfError?: string;
  error?: string;
  startedAt: number;
  finishedAt?: number;
}

const MAX_CHAPTERS = 20_000;
const MAX_CHAPTER_BYTES = 8 * 1024 * 1024;
/** All chapter text held for one export; keeps a huge book from exhausting the heap. */
const MAX_TOTAL_TEXT_BYTES = 32 * 1024 * 1024;
const MAX_TOTAL_PARAGRAPHS = 500_000;
const MAX_KEPT_JOBS = 20;
/** Bytes per path component; leaves room under the common 255-byte limit. */
const MAX_NAME_BYTES = 150;
const ILLUSTRATION_NOTE = '（此处有插图，未保存到 EPUB）';
const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((done, fail) => {
  if (signal.aborted) { fail(signal.reason); return; }
  const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); done(); }, ms);
  const onAbort = () => { clearTimeout(timer); fail(signal.reason); };
  signal.addEventListener('abort', onAbort, { once: true });
});

export { privateAddress, publicOnlyLookup } from '../lib/remote-image.ts';

export class EpubExportService {
  private readonly jobs = new Map<string, EpubExportJob>();
  private running: { job: EpubExportJob; controller: AbortController } | null = null;
  readonly dir: string;

  constructor(private readonly host: SourceHost, dir: string, private readonly booksDir: string, private readonly log?: FastifyBaseLogger) {
    this.dir = resolve(dir);
  }

  start(userId: string, sourceId: string, entryRef: string): EpubExportJob {
    const current = this.running?.job;
    if (current) {
      if (current.userId === userId && current.sourceId === sourceId && current.entryRef === entryRef) return current;
      throw conflict(`正在保存《${current.title || '另一本书'}》,完成后再试`, 'EXPORT_BUSY');
    }
    const job: EpubExportJob = { id: randomUUID(), userId, sourceId, entryRef, title: '', state: 'running', done: 0, total: 0, startedAt: Date.now() };
    this.remember(job);
    const controller = new AbortController();
    this.running = { job, controller };
    void this.run(job, controller.signal).then(
      (result) => { job.state = 'done'; Object.assign(job, result); },
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

  private async run(job: EpubExportJob, signal: AbortSignal): Promise<Pick<EpubExportJob, 'file' | 'bookId' | 'shelfError'>> {
    const { entry, publicationRef, sourceName } = await this.retrying(() => this.host.chapterPublication(job.userId, job.sourceId, job.entryRef, signal), signal);
    job.title = entry.title;
    const manifest = await this.retrying(() => this.host.manifest(job.userId, job.sourceId, publicationRef, signal), signal);
    // Reading order is `seq`, exactly as ChapterPublications.normalize() sorts it for the reader.
    const items = manifest.items.filter((item) => item.kind === 'chapter').sort((a, b) => a.seq - b.seq);
    if (!items.length) throw badRequest('这本书没有章节', 'EMPTY_BOOK');
    if (items.length > MAX_CHAPTERS) throw badRequest(`章节数超过 ${MAX_CHAPTERS},暂不支持保存`, 'BOOK_TOO_LARGE');
    job.total = items.length;

    const chapters: Array<{ title: string; paragraphs: string[] }> = [];
    let held = 0, paragraphCount = 0;
    for (const item of items) {
      signal.throwIfAborted();
      const resource = await this.retrying(() => this.host.resource(job.userId, job.sourceId, publicationRef, item.ref, signal), signal);
      // Same media rules as the reader: normalized, and the resource must match what the manifest declared.
      let media: string;
      try {
        media = chapterMedia(resource.mediaType);
        if (media !== chapterMedia(item.mediaType)) throw new Error('mismatch');
      } catch {
        resource.stream?.destroy();
        throw badRequest(`「${item.title}」不是有效的文本章节,无法保存为 EPUB`, 'UNSUPPORTED_FORMAT');
      }
      const text = await readText(resource, item.title);
      // Budget the raw body: trimmed paragraphs may still share memory with it.
      held += Buffer.byteLength(text);
      if (held > MAX_TOTAL_TEXT_BYTES) throw badRequest('这本书太大,暂不支持保存为 EPUB', 'BOOK_TOO_LARGE');
      const body = paragraphs(text, media);
      if (!body.some((line) => line !== ILLUSTRATION_NOTE)) throw badRequest(`「${item.title}」没有可读文字(插图章节暂不支持),已停止保存`, 'EMPTY_CHAPTER');
      paragraphCount += body.length;
      if (held > MAX_TOTAL_TEXT_BYTES || paragraphCount > MAX_TOTAL_PARAGRAPHS) throw badRequest('这本书太大,暂不支持保存为 EPUB', 'BOOK_TOO_LARGE');
      chapters.push({ title: item.title, paragraphs: body });
      job.done++;
    }
    // Identifies the text alone; a re-export with the same text keeps the shelf copy (see importExported).
    const contentDigest = createHash('sha256').update(JSON.stringify(chapters)).digest('hex');
    // A failed cover fetch reuses the previous export's cover.
    const previous = await Promise.resolve().then(() => this.host.previousEpubExport(job.userId, job.sourceId, publicationRef)).catch(() => undefined);
    const cover = await fetchRemoteImage(entry.coverUrl, signal).catch(() => undefined) ?? previous?.cover;
    // Readable title + a stable digest of the source and publication, so distinct books never collide.
    const digest = createHash('sha256').update(`${job.sourceId}\0${publicationRef}`).digest('hex').slice(0, 32);
    // Deterministic bytes: the same content re-exported is the same shelf book (book id hashes the file).
    const bytes = await buildEpub(entry, chapters, cover, { identifier: `urn:reader:epub-export:${digest}`, date: EXPORT_DATE, contentDigest });

    const { folder, archive } = await this.folder(safeName(sourceName || manifest.sourceName || job.sourceId));
    const target = join(folder, `${safeName(entry.title, MAX_NAME_BYTES - 45)} [${digest}].epub`);
    const temporary = join(folder, `.${randomUUID()}.part`);
    try {
      await writeFile(temporary, bytes);
      await rename(temporary, target);
    } finally { await rm(temporary, { force: true }); }
    this.log?.info({ sourceId: job.sourceId, chapters: items.length, bytes: bytes.byteLength }, 'epub export saved');
    const file = relative(archive, target).split(sep).join('/');
    // The archive is the deliverable; a failed shelf import is reported, not a failed export.
    try {
      const bookId = await this.host.importEpubExport(job.userId, job.sourceId, publicationRef, bytes, entry, contentDigest);
      return { file, bookId };
    } catch (error) {
      this.log?.warn({ sourceId: job.sourceId, code: error instanceof AppError ? error.code : 'IMPORT_FAILED' }, 'epub export shelf import failed');
      return { file, shelfError: error instanceof AppError ? error.message : '加入书架失败' };
    }
  }

  /** The per-source folder, checked by canonical path to be inside the archive and outside the library. */
  private async folder(name: string): Promise<{ folder: string; archive: string }> {
    const folder = join(this.dir, name);
    await mkdir(folder, { recursive: true });
    const [real, archive] = await Promise.all([realpath(folder), realpath(this.dir)]);
    if (!inside(archive, real)) throw badRequest('invalid export path', 'PATH_TRAVERSAL');
    const library = await realpath(this.booksDir).catch(() => resolve(this.booksDir));
    if (inside(library, real)) throw badRequest('EPUB 保存目录不能在书库目录里', 'EXPORT_DISABLED');
    return { folder: real, archive };
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

/** True when `child` is `parent` itself or below it, compared by whole path components. */
export function inside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

/** File-system-safe, still human readable (Chinese titles stay intact); capped in UTF-8 bytes. */
export function safeName(value: string, maxBytes = MAX_NAME_BYTES): string {
  const cleaned = value.normalize('NFC').replace(/[\u0000-\u001f\u007f/\\:*?"<>|[\]]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/^\.+/, '').trim();
  let out = '', bytes = 0;
  for (const char of cleaned || '未命名') {
    const size = Buffer.byteLength(char);
    if (bytes + size > maxBytes) break;
    out += char; bytes += size;
  }
  return out.trim() || '未命名';
}

/** Strict UTF-8: a mis-decoded chapter (U+FFFD soup) must fail, not be archived. Oversize fails too. */
async function readText(resource: ResourceResponse, title: string): Promise<string> {
  const tooLarge = () => badRequest(`「${title}」正文过大,已停止保存`, 'BOOK_TOO_LARGE');
  if (resource.text !== undefined) {
    if (Buffer.byteLength(resource.text) > MAX_CHAPTER_BYTES) throw tooLarge();
    return resource.text;
  }
  let bytes: Buffer;
  if (resource.data) bytes = Buffer.from(resource.data);
  else if (resource.stream) {
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of resource.stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      size += buffer.byteLength;
      if (size > MAX_CHAPTER_BYTES) { resource.stream.destroy(); throw tooLarge(); }
      chunks.push(buffer);
    }
    bytes = Buffer.concat(chunks);
  } else return '';
  if (bytes.byteLength > MAX_CHAPTER_BYTES) throw tooLarge();
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw badRequest(`「${title}」不是有效的 UTF-8 文本,已停止保存`, 'UNSUPPORTED_FORMAT'); }
}

// Controls, format characters (zero-width, soft hyphen…), every bidi control, separators and
// noncharacters. Used only to decide whether a line has visible text — never to rewrite the text,
// so legitimate joiners inside emoji or scripts survive.
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Bidi_Control}\p{Zl}\p{Zp}\p{Zs}\ufffd\ufffe\uffff]/gu;
const BLOCK = new Set(['p', 'div', 'br', 'li', 'section', 'article', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'tr', 'pre']);
const SKIPPED = new Set(['script', 'style', 'textarea', 'noscript', 'title', 'template']);

/**
 * Chapter body → plain paragraphs. HTML goes through a real parser (entities
 * decoded, script/style dropped, `>` inside attributes harmless); an
 * illustration becomes a visible note rather than vanishing, so an archive
 * never looks complete when it is not.
 */
export function paragraphs(text: string, mediaType: string): string[] {
  let plain = text;
  if (/html|xml/i.test(mediaType)) {
    const parts: string[] = []; let skip = 0;
    const parser = new Parser({
      onopentag(name) {
        if (SKIPPED.has(name)) skip++;
        else if (!skip && name === 'img') parts.push(`\n${ILLUSTRATION_NOTE}\n`);
        else if (!skip && BLOCK.has(name)) parts.push('\n');
      },
      ontext(data) { if (!skip) parts.push(data); },
      onclosetag(name) {
        if (SKIPPED.has(name)) skip = Math.max(0, skip - 1);
        else if (!skip && BLOCK.has(name)) parts.push('\n');
      },
    }, { decodeEntities: true });
    parser.end(text);
    plain = parts.join('');
  }
  return plain.split(/\n+|　　/).map((line) => line.replace(/^[\s　]+/, '').trim()).filter((line) => line.replace(INVISIBLE, '') !== '');
}

const xml = (value: string) => value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]!))
  // XML 1.0 forbids most control characters; a single one makes the whole chapter unreadable.
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, '');

function xhtml(title: string, body: string): string {
  return '<?xml version="1.0" encoding="utf-8"?>\n<!DOCTYPE html>\n<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="zh-CN">'
    + `<head><meta charset="utf-8"/><title>${xml(title)}</title><link rel="stylesheet" type="text/css" href="style.css"/></head>`
    + `<body>${body}</body></html>`;
}

/** Fixed timestamp for exports, so identical content always produces identical bytes. */
const EXPORT_DATE = new Date('2020-01-01T00:00:00Z');

export async function buildEpub(
  entry: CatalogEntry, chapters: Array<{ title: string; paragraphs: string[] }>, cover?: { bytes: Uint8Array; mediaType: string },
  options: { identifier?: string; date?: Date; contentDigest?: string } = {},
): Promise<Uint8Array> {
  const identifier = options.identifier ?? `urn:uuid:${randomUUID()}`;
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
    // Manifest only, no spine page: the spine (and so every reading position in it) stays the
    // same whether or not a cover could be fetched this time.
    manifest.push(`<item id="cover-image" href="cover.${ext}" media-type="${cover.mediaType}" properties="cover-image"/>`);
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
  const modified = (options.date ?? new Date()).toISOString().replace(/\.\d{3}Z$/, 'Z');
  zip.file('OEBPS/content.opf', '<?xml version="1.0" encoding="utf-8"?>'
    + '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" xml:lang="zh-CN">'
    + '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">'
    + `<dc:identifier id="bookid">${xml(identifier)}</dc:identifier><dc:title>${xml(entry.title)}</dc:title>`
    + authors.map((author) => `<dc:creator>${xml(author)}</dc:creator>`).join('')
    + `<dc:language>${xml(entry.language || 'zh-CN')}</dc:language>`
    + (entry.description ? `<dc:description>${xml(entry.description)}</dc:description>` : '')
    + `<meta property="dcterms:modified">${modified}</meta>${coverMeta}`
    + (options.contentDigest ? `<meta name="reader:content-digest" content="${xml(options.contentDigest)}"/>` : '') + '</metadata>'
    + `<manifest>${manifest.join('')}</manifest><spine>${spine.join('')}</spine></package>`);
  if (options.date) for (const file of Object.values(zip.files)) file.date = options.date;
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 6 }, mimeType: 'application/epub+zip' });
}

export function exportDir(config: { dataDir: string }): string {
  return resolve(process.env.EPUB_EXPORT_DIR || join(config.dataDir, 'epub-archive'));
}
