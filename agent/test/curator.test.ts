import Anthropic from '@anthropic-ai/sdk';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { describe, it } from 'node:test';
import { runCharacter, SYSTEM_PROMPT } from '../src/agent';
import { chooseCharacters } from '../src/cli';
import { GiphyConfig, searchGiphy, toCandidate } from '../src/giphy';
import { emptyManifest, mergeManifest, ManifestEntry } from '../src/manifest';
import { CharacterSession, SearchBudget } from '../src/tools';

const aqua = { id: 'c1', name: 'Aqua', anime: 'KonoSuba' };

function gif(id: string, rating = 'g') {
  return {
    id,
    title: `Aqua ${id} GIF by Crunchyroll`,
    username: 'crunchyroll',
    rating,
    url: `https://giphy.com/gifs/${id}`,
    images: {
      original: { url: `https://media.giphy.com/media/${id}/giphy.gif`, size: 1000 },
      fixed_height_still: { url: `https://media.giphy.com/media/${id}/200_s.gif` },
    },
  };
}

function fakeApi(pages: Record<string, unknown[]>, calls: string[] = []) {
  return (async (input: string | URL) => {
    const url = new URL(String(input));
    calls.push(url.pathname + url.search);
    if (url.pathname === '/v1/gifs/search') {
      return Response.json({ data: pages[url.searchParams.get('q')!] ?? [] });
    }
    return new Response('nope', { status: 404 });
  }) as typeof fetch;
}

const giphyCfg = (fetchImpl: typeof fetch): GiphyConfig => ({ apiKey: 'sekret', rating: 'pg-13', baseUrl: 'https://giphy.test/v1/', fetchImpl });

describe('toCandidate', () => {
  it('needs a still and an animation, and cleans the title', () => {
    const c = toCandidate(gif('a1'))!;
    assert.equal(c.title, 'Aqua a1');
    assert.equal(c.still, 'https://media.giphy.com/media/a1/200_s.gif');
    assert.equal(toCandidate({ id: 'x', images: { original: { url: 'u' } } }), undefined);
  });
});

describe('CharacterSession', () => {
  it('shows only unseen, non-R candidates as label + image pairs, within the search budget', async () => {
    const calls: string[] = [];
    const s = new CharacterSession(aqua, {
      giphy: giphyCfg(fakeApi({ 'aqua konosuba': [gif('known'), gif('a1'), gif('lewd', 'r'), gif('a2'), gif('a3')] }, calls)),
      budget: new SearchBudget(10),
      knownIds: new Set(['known']),
      maxSearches: 2,
      perSearch: 2,
    });
    const blocks = await s.search('aqua konosuba', 0);
    assert.ok(Array.isArray(blocks));
    assert.equal(blocks.filter((b) => b.type === 'image').length, 2);
    assert.deepEqual([...s.shown.keys()], ['a1', 'a2']);
    assert.equal(calls[0], '/v1/gifs/search?api_key=sekret&q=aqua+konosuba&limit=25&offset=0&rating=pg-13&lang=en');

    const again = await s.search('aqua konosuba', 0);
    assert.equal(typeof again === 'string' ? 'text' : 'blocks', 'blocks', 'a3 is still unseen');
    await assert.rejects(s.search('third', 0), /Search limit reached/);
  });

  it('records only ids it showed, maps category names to ids, clamps confidence', async () => {
    const s = new CharacterSession(aqua, { giphy: giphyCfg(fakeApi({ q: [gif('a1')] })), budget: new SearchBudget(10), knownIds: new Set(), maxSearches: 3, perSearch: 5 });
    await s.search('q', 0);
    assert.throws(
      () => s.record([
        { giphy_id: 'a1', categories: ['smug', 'happy', 'smug'], confidence: 1.4, reason: 'smirking' },
        { giphy_id: 'made-up', categories: ['happy'], confidence: 0.9, reason: '?' },
      ]),
      /Rejected ids you were not shown.*made-up/,
    );
    const a = s.accepted.get('a1')!;
    assert.deepEqual(a.cat, [4, 5]);
    assert.equal(a.confidence, 1);
    assert.equal(s.accepted.size, 1);
  });

  it('waits out a short 429 from GIPHY, then retries', async () => {
    let n = 0;
    const waits: number[] = [];
    const fetchImpl = (async () =>
      n++ === 0 ? new Response('', { status: 429, headers: { 'retry-after': '30' } }) : Response.json({ data: [gif('a1')] })) as unknown as typeof fetch;
    const s = new CharacterSession(aqua, { giphy: giphyCfg(fetchImpl), budget: new SearchBudget(10), knownIds: new Set(), maxSearches: 1, perSearch: 5, sleep: async (ms) => void waits.push(ms) });
    await s.search('q', 0);
    assert.deepEqual(waits, [30_000]);
  });
});

describe('GIPHY access', () => {
  it('never puts the key in error messages', async () => {
    const fail = (status: number) => (async () => new Response('x', { status })) as unknown as typeof fetch;
    for (const status of [401, 500]) {
      await assert.rejects(searchGiphy(giphyCfg(fail(status)), 'q', 0, 10), (err: Error) => !err.message.includes('sekret'));
    }
  });

  it('shares one search budget across every character in the run', async () => {
    const budget = new SearchBudget(2);
    const make = (c: typeof aqua) =>
      new CharacterSession(c, { giphy: giphyCfg(fakeApi({ q: [gif('a1')] })), budget, knownIds: new Set(), maxSearches: 5, perSearch: 5 });
    await make(aqua).search('q', 0);
    await make({ ...aqua, id: 'c2' }).search('q', 0);
    await assert.rejects(make({ ...aqua, id: 'c3' }).search('q', 0), /budget for this run is used up/);
  });
});

describe('manifest + selection', () => {
  const entry = (giphyId: string, characterId = 'c1', characterName = 'Aqua'): ManifestEntry => ({
    giphyId, characterId, characterName, anime: 'KonoSuba', cat: [4], confidence: 0.9, reason: '', url: '', still: '', page: '', rating: 'g', addedAt: '', model: '',
  });

  it('merges without clobbering existing (possibly hand-edited) entries', () => {
    const base = mergeManifest(emptyManifest(), [{ ...entry('a1'), reason: 'edited by a human' }]).manifest;
    const { manifest, added } = mergeManifest(base, [entry('a1'), entry('a2'), entry('a2')]);
    assert.equal(added, 1);
    assert.equal(manifest.entries.find((e) => e.giphyId === 'a1')!.reason, 'edited by a human');
  });

  it('prefers characters with the fewest GIFs, or exactly the named ones', () => {
    const all = [aqua, { id: 'c2', name: 'Megumin', anime: 'KonoSuba' }, { id: 'c3', name: 'Rem', anime: 'Re:Zero' }];
    const counts: Record<string, number> = { c1: 5, c2: 0, c3: 2 };
    assert.deepEqual(chooseCharacters(all, (id) => counts[id], undefined, 2).map((c) => c.name), ['Megumin', 'Rem']);
    assert.deepEqual(chooseCharacters(all, () => 0, ['rem', 'c1'], 10).map((c) => c.id), ['c1', 'c3']);
    assert.throws(() => chooseCharacters(all, () => 0, ['Goku'], 10), /Unknown characters: goku/);
  });
});

describe('runCharacter (real SDK tool runner against a fake Messages API)', () => {
  it('searches, sees frames, records, and turns accepted picks into manifest entries', async () => {
    const requests: { headers: http.IncomingHttpHeaders; body: any }[] = [];
    const replies = [
      { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tu1', name: 'search_giphy', input: { query: 'Aqua KonoSuba', offset: 0 } }] },
      {
        stop_reason: 'tool_use',
        content: [{
          type: 'tool_use', id: 'tu2', name: 'record_gifs',
          input: { gifs: [
            { giphy_id: 'a1', categories: ['smug'], confidence: 0.92, reason: 'Aqua smirking' },
            { giphy_id: 'a2', categories: ['shocked'], confidence: 0.4, reason: 'might be Darkness' },
          ] },
        }],
      },
      { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Recorded 2; shocked is thin.' }] },
    ];
    const server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        requests.push({ headers: req.headers, body: JSON.parse(raw) });
        const r = replies[requests.length - 1];
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({
          id: `msg_${requests.length}`, type: 'message', role: 'assistant', model: 'claude-opus-5-5', stop_sequence: null,
          usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 50, cache_creation_input_tokens: 10 },
          ...r,
        }));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const client = new Anthropic({ apiKey: 'test', baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}` });

    try {
      const result = await runCharacter(client, aqua, new Set(), {
        giphy: giphyCfg(fakeApi({ 'Aqua KonoSuba': [gif('a1'), gif('a2')] })),
        budget: new SearchBudget(10),
        model: 'claude-opus-5-5', effort: 'medium', target: 10, maxSearches: 4, perSearch: 10, minConfidence: 0.7, maxIterations: 10,
      });

      assert.equal(requests.length, 3);
      const first = requests[0];
      assert.equal(first.body.model, 'claude-opus-5-5');
      assert.equal(first.body.fallbacks, 'default');
      assert.deepEqual(first.body.cache_control, { type: 'ephemeral' });
      assert.deepEqual(first.body.thinking, { type: 'adaptive' });
      assert.equal(first.body.output_config.effort, 'medium');
      assert.equal(first.body.system, SYSTEM_PROMPT);
      assert.match(String(first.headers['anthropic-beta']), /server-side-fallback-2026-07-01/);
      assert.deepEqual(first.body.tools.map((t: { name: string }) => t.name), ['search_giphy', 'record_gifs']);

      // Second request carries the search result: label text + image URL blocks.
      const toolResult = requests[1].body.messages.at(-1).content[0];
      assert.equal(toolResult.type, 'tool_result');
      assert.ok(toolResult.content.some((b: any) => b.type === 'image' && b.source.url.endsWith('a1/200_s.gif')));

      assert.equal(result.stopReason, 'end_turn');
      assert.equal(result.summary, 'Recorded 2; shocked is thin.');
      assert.deepEqual(result.entries.map((e) => [e.giphyId, e.cat]), [['a1', [5]]], 'low-confidence pick filtered out');
      assert.equal(result.entries[0].url, 'https://media.giphy.com/media/a1/giphy.gif');
      assert.deepEqual(result.usage, { input: 300, output: 60, cacheRead: 150, cacheWrite: 30 });
    } finally {
      server.close();
    }
  });
});
