import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { assetKey, CacheLike, Env, handle, R2BucketLike, R2ObjectLike } from '../src/index';

class FakeR2 implements R2BucketLike {
  objects = new Map<string, { data: ArrayBuffer; contentType?: string }>();
  gets = 0;
  private obj(key: string, withBody: boolean): R2ObjectLike | null {
    const o = this.objects.get(key);
    if (!o) return null;
    return {
      size: o.data.byteLength,
      httpEtag: `"etag-${key}"`,
      httpMetadata: { contentType: o.contentType },
      body: withBody ? new Response(o.data).body : null,
    };
  }
  async get(key: string) {
    this.gets++;
    return this.obj(key, true);
  }
  async head(key: string) {
    return this.obj(key, false);
  }
  async put(key: string, value: ArrayBuffer, options?: { httpMetadata?: { contentType?: string } }) {
    this.objects.set(key, { data: value, contentType: options?.httpMetadata?.contentType });
  }
}

class FakeCache implements CacheLike {
  store = new Map<string, Response>();
  async match(req: Request) {
    return this.store.get(req.url)?.clone();
  }
  async put(req: Request, res: Response) {
    this.store.set(req.url, res);
  }
}

function setup(origin: (url: string) => Response | Promise<Response>, env: Partial<Env> = {}) {
  const r2 = new FakeR2();
  const cache = new FakeCache();
  const pending: Promise<unknown>[] = [];
  const originCalls: string[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p) };
  const fullEnv: Env = { ASSETS: r2, ORIGIN: 'https://origin.test', ...env };
  const fetchImpl = (async (input: string | URL | Request) => {
    originCalls.push(String(input));
    return origin(String(input));
  }) as typeof fetch;
  const call = async (path: string, init: RequestInit = {}, useCache = true) => {
    const res = await handle(new Request(`https://cdn.test${path}`, init), fullEnv, ctx, {
      fetch: fetchImpl,
      cache: useCache ? cache : undefined,
    });
    await Promise.all(pending.splice(0));
    return res;
  };
  return { r2, cache, call, originCalls };
}

const gif = () => new Response('GIF89a-bytes', { headers: { 'content-type': 'image/gif' } });

describe('assetKey', () => {
  it('accepts media under visuals/ and audible/ only', () => {
    assert.equal(assetKey('/visuals/mocking/aqua_mocking_laugh.gif'), 'visuals/mocking/aqua_mocking_laugh.gif');
    assert.equal(assetKey('/audible/aqua.mp3'), 'audible/aqua.mp3');
    assert.equal(assetKey('/visuals/x.html'), undefined);
    assert.equal(assetKey('/secrets/x.gif'), undefined);
    assert.equal(assetKey('/visuals/../x.gif'), undefined);
    assert.equal(assetKey('/visuals//x.gif'), undefined);
    assert.equal(assetKey('/visuals'), undefined);
  });
});

describe('pull-through CDN', () => {
  it('fetches from origin once, stores in R2, then serves from edge cache / R2', async () => {
    const { r2, cache, call, originCalls } = setup(gif);

    const first = await call('/visuals/happy/aqua.gif');
    assert.equal(first.status, 200);
    assert.equal(first.headers.get('x-amii-source'), 'origin');
    assert.equal(first.headers.get('content-type'), 'image/gif');
    assert.equal(await first.text(), 'GIF89a-bytes');
    assert.deepEqual(originCalls, ['https://origin.test/visuals/happy/aqua.gif']);
    assert.equal(r2.objects.get('visuals/happy/aqua.gif')?.contentType, 'image/gif');

    const second = await call('/visuals/happy/aqua.gif?v=123');
    assert.equal(second.headers.get('x-amii-source'), 'edge');
    assert.equal(await second.text(), 'GIF89a-bytes');
    assert.equal(originCalls.length, 1, 'query string does not bypass the cache');

    cache.store.clear(); // another data centre: edge cold, R2 warm
    const third = await call('/visuals/happy/aqua.gif');
    assert.equal(third.headers.get('x-amii-source'), 'r2');
    assert.equal(third.headers.get('etag'), '"etag-visuals/happy/aqua.gif"');
    assert.equal(await third.text(), 'GIF89a-bytes');
    assert.equal(originCalls.length, 1);
  });

  it('answers conditional requests with 304', async () => {
    const { call } = setup(gif);
    await call('/visuals/a.gif');
    const res = await call('/visuals/a.gif', { headers: { 'if-none-match': '"etag-visuals/a.gif"' } }, false);
    assert.equal(res.status, 304);
  });

  it('works without an edge cache (workers.dev) and supports HEAD', async () => {
    const { r2, call } = setup(gif);
    await call('/audible/aqua.mp3', {}, false);
    const head = await call('/audible/aqua.mp3', { method: 'HEAD' }, false);
    assert.equal(head.status, 200);
    assert.equal(head.headers.get('content-length'), String('GIF89a-bytes'.length));
    assert.equal(r2.objects.size, 1);
  });

  it('does not store errors, non-media or oversized files', async () => {
    const missing = setup(() => new Response('nope', { status: 404 }));
    assert.equal((await missing.call('/visuals/x.gif')).status, 404);
    assert.equal(missing.r2.objects.size, 0);

    const down = setup(() => new Response('boom', { status: 503 }));
    assert.equal((await down.call('/visuals/x.gif')).status, 502);

    const html = setup(() => new Response('<html>', { headers: { 'content-type': 'text/html' } }));
    assert.equal((await html.call('/visuals/x.gif')).status, 502, 'error pages are never stored as media');
    assert.equal(html.r2.objects.size, 0);

    const untyped = setup(() => new Response(new Uint8Array([1, 2, 3])));
    const typed = await untyped.call('/audible/a.mp3');
    assert.equal(typed.headers.get('content-type'), 'audio/mpeg', 'typed by extension when origin is silent');

    const big = setup(() => new Response('x'.repeat(2 * 1024 * 1024), { headers: { 'content-type': 'image/gif' } }), {
      MAX_OBJECT_MB: '1',
    });
    const passthrough = await big.call('/visuals/huge.gif');
    assert.equal(passthrough.headers.get('x-amii-source'), 'origin-passthrough');
    assert.equal(big.r2.objects.size, 0);
  });

  it('rejects other methods and paths', async () => {
    const { call, originCalls } = setup(gif);
    assert.equal((await call('/visuals/a.gif', { method: 'POST' })).status, 405);
    assert.equal((await call('/index.html')).status, 404);
    assert.equal((await call('/healthz')).status, 200);
    assert.equal(originCalls.length, 0);
  });
});
