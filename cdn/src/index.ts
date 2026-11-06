/**
 * AMII CDN: a pull-through cache for meme images and audio on Cloudflare.
 *
 *   GET /visuals/<path>  |  GET /audible/<path>
 *
 * 1. Cloudflare edge cache (per data centre, free, fastest)
 * 2. R2 bucket (durable, global, zero egress fees)
 * 3. Origin (`ORIGIN`, default the AMII asset server). On a miss the file is fetched once,
 *    stored in R2, and served from there afterwards.
 *
 * Paths match the AMII asset server, so editors only change `assetSource`.
 * Only media types are stored and only under visuals/ and audible/, so this can't be used to
 * host arbitrary content.
 */

// Minimal shapes of the Workers runtime APIs used here (kept local so tests run in plain Node).
export interface R2ObjectLike {
  readonly size: number;
  readonly httpEtag: string;
  readonly httpMetadata?: { contentType?: string; cacheControl?: string };
  readonly body: ReadableStream | null;
}
export interface R2BucketLike {
  get(key: string): Promise<R2ObjectLike | null>;
  head(key: string): Promise<R2ObjectLike | null>;
  put(
    key: string,
    value: ArrayBuffer,
    options?: { httpMetadata?: { contentType?: string; cacheControl?: string }; customMetadata?: Record<string, string> },
  ): Promise<unknown>;
}
export interface CacheLike {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
}
export interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void;
}

export interface Env {
  ASSETS: R2BucketLike;
  /** Where misses are fetched from, e.g. https://amii.assets.unthrottled.io */
  ORIGIN?: string;
  /** Largest file stored in R2 (MB). Larger files are passed through uncached. */
  MAX_OBJECT_MB?: string;
  /** Cache-Control sent to browsers/editors and the edge. */
  CACHE_CONTROL?: string;
}

export interface Deps {
  fetch: typeof fetch;
  cache?: CacheLike;
}

const DEFAULT_ORIGIN = 'https://amii.assets.unthrottled.io';
const DEFAULT_CACHE_CONTROL = 'public, max-age=604800, stale-while-revalidate=86400';
const SEGMENT = /^[A-Za-z0-9\-_.~%()!]+$/;

const TYPES: Record<string, string> = {
  gif: 'image/gif',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  apng: 'image/apng',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4',
};

/** `visuals/a/b.gif` for a valid media path, otherwise undefined. */
export function assetKey(pathname: string): string | undefined {
  const segments = pathname.replace(/^\/+/, '').split('/');
  const [category, ...rest] = segments;
  if (category !== 'visuals' && category !== 'audible') return undefined;
  if (rest.length === 0) return undefined;
  if (!rest.every((s) => SEGMENT.test(s) && s !== '.' && s !== '..')) return undefined;
  if (!(extension(pathname) in TYPES)) return undefined;
  return segments.join('/');
}

function extension(path: string): string {
  return path.slice(path.lastIndexOf('.') + 1).toLowerCase();
}

function mediaType(key: string, originType: string | null): string | undefined {
  const declared = originType?.split(';')[0].trim().toLowerCase();
  if (declared && (declared.startsWith('image/') || declared.startsWith('audio/'))) return declared;
  // Fall back to the extension only when the origin didn't say. An explicit text/html on a .gif
  // is an error page, and must never be stored.
  if (!declared || declared === 'application/octet-stream' || declared === 'binary/octet-stream') {
    return TYPES[extension(key)];
  }
  return undefined;
}

function text(status: number, body: string, cacheSeconds = 0): Response {
  return new Response(body, {
    status,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': cacheSeconds > 0 ? `public, max-age=${cacheSeconds}` : 'no-store',
    },
  });
}

function baseHeaders(env: Env, contentType: string, etag: string | undefined, source: string): Headers {
  const h = new Headers({
    'content-type': contentType,
    'cache-control': env.CACHE_CONTROL ?? DEFAULT_CACHE_CONTROL,
    'access-control-allow-origin': '*',
    'x-content-type-options': 'nosniff',
    'x-amii-source': source,
  });
  if (etag) h.set('etag', etag);
  return h;
}

function notModified(request: Request, etag: string | undefined): boolean {
  const tags = request.headers.get('if-none-match');
  return !!etag && !!tags && tags.split(',').some((t) => t.trim() === etag || t.trim() === '*');
}

export async function handle(request: Request, env: Env, ctx: ExecutionContextLike, deps: Deps): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('method not allowed', { status: 405, headers: { allow: 'GET, HEAD' } });
  }
  const url = new URL(request.url);
  if (url.pathname === '/healthz') return text(200, 'ok');
  const key = assetKey(url.pathname);
  if (!key) return text(404, 'not found', 300);

  // The edge cache key ignores the query string so `?v=` tricks can't bypass R2.
  const cacheKey = new Request(`${url.origin}/${key}`, { method: 'GET' });
  if (request.method === 'GET' && deps.cache) {
    const hit = await deps.cache.match(cacheKey);
    if (hit) {
      const headers = new Headers(hit.headers);
      headers.set('x-amii-source', 'edge');
      if (notModified(request, headers.get('etag') ?? undefined)) return new Response(null, { status: 304, headers });
      return new Response(hit.body, { status: hit.status, headers });
    }
  }

  const stored = request.method === 'HEAD' ? await env.ASSETS.head(key) : await env.ASSETS.get(key);
  if (stored) {
    const headers = baseHeaders(env, stored.httpMetadata?.contentType ?? TYPES[extension(key)], stored.httpEtag, 'r2');
    headers.set('content-length', String(stored.size));
    if (notModified(request, stored.httpEtag)) return new Response(null, { status: 304, headers });
    const response = new Response(request.method === 'HEAD' ? null : stored.body, { headers });
    if (request.method === 'GET' && deps.cache) ctx.waitUntil(deps.cache.put(cacheKey, response.clone()));
    return response;
  }

  return fromOrigin(request, env, ctx, deps, key, cacheKey);
}

async function fromOrigin(
  request: Request,
  env: Env,
  ctx: ExecutionContextLike,
  deps: Deps,
  key: string,
  cacheKey: Request,
): Promise<Response> {
  const origin = (env.ORIGIN ?? DEFAULT_ORIGIN).replace(/\/+$/, '');
  let upstream: Response;
  try {
    upstream = await deps.fetch(`${origin}/${key}`, { headers: { 'user-agent': 'amii-cdn' } });
  } catch {
    return text(502, 'origin unreachable');
  }
  if (upstream.status === 404) return text(404, 'not found', 300);
  if (!upstream.ok) return text(502, `origin responded ${upstream.status}`);

  const contentType = mediaType(key, upstream.headers.get('content-type'));
  if (!contentType) return text(502, 'origin returned a non-media type');

  const maxBytes = Number(env.MAX_OBJECT_MB ?? '25') * 1024 * 1024;
  const declared = Number(upstream.headers.get('content-length') ?? NaN);
  if (declared > maxBytes) {
    // Too big to keep: stream it through untouched.
    return new Response(request.method === 'HEAD' ? null : upstream.body, {
      headers: baseHeaders(env, contentType, undefined, 'origin-passthrough'),
    });
  }

  const body = await upstream.arrayBuffer();
  if (body.byteLength > maxBytes || body.byteLength === 0) {
    return new Response(request.method === 'HEAD' ? null : body, {
      headers: baseHeaders(env, contentType, undefined, 'origin-passthrough'),
    });
  }

  const cacheControl = env.CACHE_CONTROL ?? DEFAULT_CACHE_CONTROL;
  ctx.waitUntil(
    env.ASSETS.put(key, body, {
      httpMetadata: { contentType, cacheControl },
      customMetadata: { origin, fetchedAt: new Date().toISOString() },
    }),
  );
  const headers = baseHeaders(env, contentType, undefined, 'origin');
  headers.set('content-length', String(body.byteLength));
  const response = new Response(request.method === 'HEAD' ? null : body, { headers });
  if (request.method === 'GET' && deps.cache) ctx.waitUntil(deps.cache.put(cacheKey, response.clone()));
  return response;
}

// Workers entry point. `caches.default` is the zone's edge cache (a no-op on *.workers.dev).
declare const caches: { default: CacheLike } | undefined;

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContextLike): Promise<Response> {
    return handle(request, env, ctx, {
      fetch: (input, init) => fetch(input, init),
      cache: typeof caches !== 'undefined' ? caches.default : undefined,
    });
  },
};
