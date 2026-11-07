import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';

/**
 * Image bytes for the MCP insert_image tool: sniffing the real type from the bytes (the
 * client's claimed type is not trusted) and fetching a remote image without letting the URL
 * reach the server's own network.
 */

const EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
};

/** The image type of `b` from its magic bytes, or null when it is not a supported image. */
export function sniffImage(b: Buffer): string | null {
  if (b.length < 12) return null;
  if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (
    b.subarray(0, 6).toString('latin1') === 'GIF87a' ||
    b.subarray(0, 6).toString('latin1') === 'GIF89a'
  )
    return 'image/gif';
  if (
    b.subarray(0, 4).toString('latin1') === 'RIFF' &&
    b.subarray(8, 12).toString('latin1') === 'WEBP'
  )
    return 'image/webp';
  const brand = b.subarray(4, 12).toString('latin1');
  if (brand === 'ftypavif' || brand === 'ftypavis') return 'image/avif';
  return null;
}

export const imageExt = (mime: string) => EXT[mime] ?? 'img';

/** Decodes base64 or a `data:image/...;base64,` URL. */
export function decodeBase64Image(s: string): Buffer {
  const m = /^data:[^;,]*;base64,/i.exec(s.trim());
  return Buffer.from(m ? s.trim().slice(m[0].length) : s.replace(/\s+/g, ''), 'base64');
}

const blocked = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 3],
] as const)
  blocked.addSubnet(net, prefix, 'ipv4');
for (const [net, prefix] of [
  ['::', 127],
  ['64:ff9b::', 96],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const)
  blocked.addSubnet(net, prefix, 'ipv6');

export const isPublicAddress = (addr: string) => {
  const v = isIP(addr);
  if (!v) return false;
  // IPv4-mapped IPv6 (::ffff:10.0.0.1) is checked as the IPv4 address it maps to.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(addr);
  if (mapped) return !blocked.check(mapped[1]!, 'ipv4');
  return !blocked.check(addr, v === 4 ? 'ipv4' : 'ipv6');
};

/** DNS lookup that refuses private addresses, checked at connect time (no rebinding window). */
const publicLookup: LookupFunction = (hostname, options, cb) => {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return cb(err, '', 0);
    const list = (addresses as LookupAddress[]).filter((a) => isPublicAddress(a.address));
    if (!list.length)
      return cb(Object.assign(new Error('blocked address'), { code: 'EBLOCKED' }), '', 0);
    if ((options as { all?: boolean }).all)
      return (cb as unknown as (e: null, a: LookupAddress[]) => void)(null, list);
    cb(null, list[0]!.address, list[0]!.family);
  });
};

export class ImageFetchError extends Error {}

/** GETs a public http(s) image, following up to 3 redirects, at most `maxBytes`. */
export async function fetchImage(
  url: string,
  maxBytes: number,
  opts: { timeoutMs?: number; allowPrivate?: boolean } = {},
): Promise<{ data: Buffer; filename: string }> {
  let current = url;
  for (let hop = 0; hop < 4; hop++) {
    let u: URL;
    try {
      u = new URL(current);
    } catch {
      throw new ImageFetchError('Not a valid URL');
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:')
      throw new ImageFetchError('Only http and https image URLs are supported');
    const host = u.hostname.replace(/^\[|\]$/g, '');
    if (!opts.allowPrivate && isIP(host) && !isPublicAddress(host))
      throw new ImageFetchError('That address is not reachable from Bee');
    const res = await new Promise<IncomingMessage>((resolve, reject) => {
      const req = (u.protocol === 'https:' ? httpsRequest : httpRequest)(
        u,
        {
          method: 'GET',
          headers: { accept: 'image/*', 'user-agent': 'Bee/1.0 (+image import)' },
          timeout: opts.timeoutMs ?? 15_000,
          ...(opts.allowPrivate ? {} : { lookup: publicLookup }),
        },
        resolve,
      );
      req.on('timeout', () =>
        req.destroy(new ImageFetchError('The image took too long to download')),
      );
      req.on('error', (e: Error & { code?: string }) =>
        reject(
          e instanceof ImageFetchError
            ? e
            : new ImageFetchError(
                e.code === 'EBLOCKED'
                  ? 'That address is not reachable from Bee'
                  : `Could not download the image (${e.message})`,
              ),
        ),
      );
      req.end();
    });
    const status = res.statusCode ?? 0;
    if (status >= 300 && status < 400 && res.headers.location) {
      res.resume();
      current = new URL(res.headers.location, u).toString();
      continue;
    }
    if (status !== 200) {
      res.resume();
      throw new ImageFetchError(`Could not download the image (HTTP ${status})`);
    }
    if (Number(res.headers['content-length'] ?? 0) > maxBytes) {
      res.destroy();
      throw new ImageFetchError(`The image is larger than ${Math.round(maxBytes / 1048576)} MB`);
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of res as AsyncIterable<Buffer>) {
      size += chunk.length;
      if (size > maxBytes) {
        res.destroy();
        throw new ImageFetchError(`The image is larger than ${Math.round(maxBytes / 1048576)} MB`);
      }
      chunks.push(chunk);
    }
    let name = u.pathname.split('/').pop() || '';
    try {
      name = decodeURIComponent(name);
    } catch {
      // keep it encoded
    }
    name = name.slice(0, 200);
    return { data: Buffer.concat(chunks), filename: name || 'image' };
  }
  throw new ImageFetchError('Too many redirects');
}
