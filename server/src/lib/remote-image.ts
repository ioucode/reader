import { lookup } from 'node:dns';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';

/**
 * Fetching an image a source plugin pointed at (a book cover). The URL is
 * plugin-supplied, so it is treated as hostile: http(s) only, no credentials in
 * the URL, public addresses only (checked on the connection's own DNS answer),
 * no redirects, a whitelist of image types and a size cap. Anything else is
 * "no image", never an error page passed through.
 */

export const IMAGE_TYPES: ReadonlySet<string> = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
export const MAX_REMOTE_IMAGE_BYTES = 5 * 1024 * 1024;
const TIMEOUT_MS = 15_000;

export interface RemoteImage { bytes: Uint8Array; mediaType: string }

/** True for a URL this module is willing to fetch at all (before DNS). */
export function fetchableImageUrl(value: string | undefined): value is string {
  if (!value || value.length > 2000) return false;
  let parsed: URL;
  try { parsed = new URL(value); } catch { return false; }
  if ((parsed.protocol !== 'https:' && parsed.protocol !== 'http:') || parsed.username || parsed.password) return false;
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  return !(isIP(host) && privateAddress(host));
}

export function fetchRemoteImage(url: string | undefined, signal: AbortSignal, maxBytes = MAX_REMOTE_IMAGE_BYTES): Promise<RemoteImage | undefined> {
  if (!fetchableImageUrl(url)) return Promise.resolve(undefined);
  const parsed = new URL(url);
  const request = parsed.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise((done, fail) => {
    const req = request(parsed, {
      method: 'GET', lookup: publicOnlyLookup, signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]),
      headers: { accept: 'image/webp,image/png,image/jpeg,image/gif;q=0.9' },
    }, (response) => {
      const mediaType = String(response.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
      const declared = Number(response.headers['content-length']);
      if (response.statusCode !== 200 || !IMAGE_TYPES.has(mediaType) || (Number.isFinite(declared) && declared > maxBytes)) {
        // Destroy rather than drain: a rejected body must not keep using bandwidth after the caller moved on.
        response.destroy(); req.destroy(); done(undefined); return;
      }
      const chunks: Buffer[] = []; let size = 0;
      response.on('data', (chunk: Buffer) => {
        size += chunk.byteLength;
        if (size > maxBytes) { response.destroy(); req.destroy(); done(undefined); return; }
        chunks.push(chunk);
      });
      response.on('end', () => done(size > maxBytes || size === 0 ? undefined : { bytes: Buffer.concat(chunks), mediaType }));
      response.on('error', fail);
    });
    req.on('error', fail);
    req.end();
  });
}

/**
 * The connection's own DNS answer is validated (no separate pre-check that a
 * changed DNS answer could slip past), so a plugin-supplied URL can only
 * reach public addresses. TLS still verifies the original hostname.
 */
export const publicOnlyLookup: LookupFunction = (hostname, options, callback) => {
  lookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) { callback(error, '', 0); return; }
    const list = (addresses as unknown as Array<{ address: string; family: number }>);
    const allowed = list.filter(({ address }) => !privateAddress(address));
    if (!allowed.length || allowed.length !== list.length) {
      callback(Object.assign(new Error('image host resolves to a non-public address'), { code: 'EADDRNOTAVAIL' }), '', 0); return;
    }
    if ((options as { all?: boolean }).all) (callback as unknown as (e: null, a: typeof allowed) => void)(null, allowed);
    else callback(null, allowed[0]!.address, allowed[0]!.family);
  });
};

/**
 * True for anything that is not a globally routable unicast address. IPv4 is a
 * denylist of the special-purpose ranges; IPv6 is an allowlist (2000::/3 global
 * unicast only) minus documentation, 6to4 and Teredo, which can embed arbitrary
 * IPv4 addresses.
 */
export function privateAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a = 0, b = 0, c = 0] = address.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19))
      || (a === 192 && b === 0 && (c === 0 || c === 2)) || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113)
      || (a === 192 && b === 88 && c === 99) || a >= 224;
  }
  if (isIP(address) !== 6) return true;
  const lower = address.toLowerCase();
  if (lower.startsWith('::ffff:')) {
    const rest = lower.slice(7);
    // IPv4-mapped in hex form (::ffff:a00:1) → dotted quad before judging.
    const hex = rest.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hex) { const hi = parseInt(hex[1]!, 16), lo = parseInt(hex[2]!, 16); return privateAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`); }
    return privateAddress(rest);
  }
  const [first = 0, second = 0] = hextets(lower);
  if (first < 0x2000 || first > 0x3fff) return true; // not global unicast (covers ::, ::1, fc00::/7, fe80::/10, fec0::/10, ff00::/8, 64:ff9b::/96…)
  return first === 0x2002 || (first === 0x2001 && (second === 0 || second === 0xdb8)) || first === 0x3fff;
}

/** The first two 16-bit groups of an IPv6 address, expanding `::`. */
function hextets(address: string): number[] {
  const [head = '', tail] = address.split('::');
  const left = head ? head.split(':') : [];
  const right = tail === undefined ? [] : tail ? tail.split(':') : [];
  const groups = tail === undefined ? left : [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right];
  return groups.slice(0, 2).map((group) => parseInt(group, 16) || 0);
}
