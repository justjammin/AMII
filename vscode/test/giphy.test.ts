import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { VisualRepository } from '../src/assets/repository';
import { AssetStore, isAllowedMediaUrl } from '../src/assets/store';
import { MemeCategory } from '../src/core/types';

const prefs = { allowLewds: false, onlyCustomAssets: false, preferredCharacters: [], blacklistedCharacters: [], preferredGenders: ['female', 'male', 'other'] as const };

describe('GIPHY source', () => {
  it('only allows https GIPHY CDN urls', () => {
    assert.ok(isAllowedMediaUrl('https://media2.giphy.com/media/abc/giphy.gif'));
    assert.ok(!isAllowedMediaUrl('http://media.giphy.com/a.gif'));
    assert.ok(!isAllowedMediaUrl('https://giphy.com.evil.example/a.gif'));
    assert.ok(!isAllowedMediaUrl('file:///etc/passwd'));
  });

  it('syncs visuals from the API, drops disallowed urls, and downloads by url once', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'amii-giphy-'));
    const calls: string[] = [];
    const fetchImpl = (async (url: URL | string) => {
      calls.push(String(url));
      if (String(url).endsWith('/giphy/visuals')) {
        return new Response(JSON.stringify([
          { id: 'giphy:a', alt: 'Smug', cat: [5], lewd: false, url: 'https://media.giphy.com/media/a/giphy.gif', page: 'https://giphy.com/gifs/a', source: 'giphy' },
          { id: 'giphy:b', alt: 'Bad', cat: [5], url: 'https://evil.example/b.gif', page: '', source: 'giphy' },
        ]));
      }
      return new Response('GIF89a');
    }) as unknown as typeof fetch;

    const store = new AssetStore({ apiUrl: 'https://my-api.test/public/', assetSource: 'https://cdn.test', storageDir: dir, fetchImpl });
    const items = await store.loadGiphy();
    assert.deepEqual(items.map((i) => i.id), ['giphy:a']);
    assert.equal(calls[0], 'https://my-api.test/public/giphy/visuals');

    const repo = new VisualRepository();
    repo.indexGiphy(items);
    const pick = repo.pick([MemeCategory.Smug], prefs);
    assert.equal(pick?.source.kind, 'giphy');

    // Curated entries carry character ids, so preferred-character filtering works for GIPHY too.
    const curated = new VisualRepository();
    curated.index({ anime: [{ id: 'a1', name: 'KonoSuba' }], characters: [{ id: 'c1', animeId: 'a1', name: 'Aqua', gender: 0 }], visuals: [], audible: [] });
    curated.indexGiphy([
      { id: 'giphy:x', alt: 'Aqua smirk', cat: [5], char: ['c1'], url: 'https://media.giphy.com/media/x/giphy.gif', page: '', source: 'giphy' },
      { id: 'giphy:y', alt: 'someone else', cat: [5], url: 'https://media.giphy.com/media/y/giphy.gif', page: '', source: 'giphy' },
    ]);
    for (let i = 0; i < 5; i++) {
      assert.equal(curated.pick([MemeCategory.Smug], { ...prefs, preferredCharacters: ['Aqua'] })?.id, 'giphy:x');
    }

    const [f1, f2] = await Promise.all([store.resolveUrl(items[0].url), store.resolveUrl(items[0].url)]);
    assert.equal(f1, f2);
    assert.equal(await fs.readFile(f1!, 'utf8'), 'GIF89a');
    assert.equal(calls.filter((c) => c.includes('media.giphy.com')).length, 1);
    assert.equal(await store.resolveUrl('https://evil.example/x.gif'), undefined);
  });
});
