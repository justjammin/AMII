import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { assetKey } from '../src/index';
import { encodePath, mirror } from '../scripts/mirror';

describe('mirror', () => {
  it('encodes paths so the Worker accepts them', () => {
    const encoded = encodePath("happy/aqua's (best) day!.gif");
    assert.equal(encoded, 'happy/aqua%27s%20(best)%20day!.gif');
    assert.ok(assetKey(`/visuals/${encoded}`));
  });

  it('lists every asset once, HEADs it through the CDN and tallies outcomes', async () => {
    const heads: string[] = [];
    let flaky = 0;
    const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/assets/visuals')) {
        return Response.json([
          { id: '1', path: 'happy/a.gif' },
          { id: '2', path: 'happy/a.gif' }, // duplicate path
          { id: '3', path: 'smug/b.gif' },
          { id: '4', path: 'gone/c.gif', del: true },
          { id: '5', path: 'missing/d.gif' },
          { id: '6', path: 'flaky/e.gif' },
        ]);
      }
      if (url.endsWith('/assets/audible')) return Response.json([{ id: 'a', path: 'aqua.mp3' }]);
      assert.equal(init?.method, 'HEAD');
      heads.push(url);
      if (url.includes('missing')) return new Response(null, { status: 404 });
      if (url.includes('flaky') && flaky++ < 2) return new Response(null, { status: 503 });
      const source = url.includes('smug') ? 'r2' : 'origin';
      return new Response(null, { headers: { 'x-amii-source': source } });
    }) as typeof fetch;

    const report = await mirror({
      api: 'https://api.test/public',
      cdn: 'https://cdn.test/',
      concurrency: 3,
      fetchImpl,
      log: () => {},
      sleep: async () => {},
    });

    assert.equal(report.total, 5);
    assert.deepEqual(report.counts, { stored: 3, already: 1, passthrough: 0, missing: 1, rejected: 0, error: 0 });
    assert.deepEqual(report.failures.map((f) => f.path), ['visuals/missing/d.gif']);
    assert.ok(heads.includes('https://cdn.test/audible/aqua.mp3'));
    assert.equal(heads.filter((h) => h.includes('flaky')).length, 3, 'retried transient 503s');
  });

  it('dry run lists without touching the CDN', async () => {
    let cdnCalls = 0;
    const fetchImpl = (async (input: string | URL) => {
      if (String(input).includes('/assets/')) return Response.json([{ id: '1', path: 'x.gif' }]);
      cdnCalls++;
      return new Response(null);
    }) as typeof fetch;
    const report = await mirror({ api: 'https://api.test/', cdn: 'https://cdn.test', concurrency: 2, dryRun: true, fetchImpl, log: () => {} });
    assert.equal(report.total, 2);
    assert.equal(cdnCalls, 0);
  });
});
