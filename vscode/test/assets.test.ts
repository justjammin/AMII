import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { categorizeExitCode, isAllowedCommand, terminalEventType } from '../src/core/classify';
import { MemeCategory, UserEventCategory, UserEventType } from '../src/core/types';
import { Definitions, mergeDefinitions } from '../src/assets/models';
import { SelectionPreferences, VisualRepository } from '../src/assets/repository';
import { AssetStore } from '../src/assets/store';
import { seeded } from './helpers';

const defs: Definitions = {
  anime: [{ id: 'a1', name: 'KonoSuba' }],
  characters: [
    { id: 'c1', animeId: 'a1', name: 'Aqua', gender: 0 },
    { id: 'c2', animeId: 'a1', name: 'Kazuma', gender: 1 },
  ],
  visuals: [
    { id: 'v1', path: 'happy/aqua.gif', alt: 'aqua happy', cat: [4], char: ['c1'], aud: 'au1' },
    { id: 'v2', path: 'happy/kazuma.gif', alt: 'kazuma happy', cat: [4], char: ['c2'] },
    { id: 'v3', path: 'smug/aqua.gif', alt: 'lewd aqua', cat: [5], char: ['c1'], lewd: true },
  ],
  audible: [{ id: 'au1', path: 'aqua.mp3' }],
};

const prefs = (p: Partial<SelectionPreferences> = {}): SelectionPreferences => ({
  allowLewds: false,
  onlyCustomAssets: false,
  preferredCharacters: [],
  blacklistedCharacters: [],
  preferredGenders: ['female', 'male', 'other'],
  ...p,
});

describe('mergeDefinitions', () => {
  it('applies changedSince deltas with tombstones', () => {
    const merged = mergeDefinitions(
      [{ id: '1', name: 'old' }, { id: '2', name: 'keep' }, { id: '3', name: 'gone' }],
      [{ id: '1', name: 'new' }, { id: '3', del: true }, { id: '4', name: 'added' }] as never,
    );
    assert.deepEqual(merged, [{ id: '1', name: 'new' }, { id: '4', name: 'added' }, { id: '2', name: 'keep' }]);
  });
});

describe('VisualRepository', () => {
  const repo = new VisualRepository(seeded(4));
  repo.index(defs);

  it('honours preferred and blacklisted characters', () => {
    for (let i = 0; i < 10; i++) {
      assert.equal(repo.pick([MemeCategory.Happy], prefs({ preferredCharacters: ['aqua'] }))?.id, 'v1');
      assert.equal(repo.pick([MemeCategory.Happy], prefs({ blacklistedCharacters: ['c1'] }))?.id, 'v2');
      assert.equal(repo.pick([MemeCategory.Happy], prefs({ preferredGenders: ['male'] }))?.id, 'v2');
    }
  });

  it('hides lewd memes unless allowed', () => {
    assert.equal(repo.pick([MemeCategory.Smug], prefs()), undefined);
    assert.equal(repo.pick([MemeCategory.Smug], prefs({ allowLewds: true }))?.id, 'v3');
  });

  it('falls back to other categories and resolves audio', () => {
    assert.equal(repo.pick([MemeCategory.Tired, MemeCategory.Happy], prefs({ preferredCharacters: ['Aqua'] }))?.id, 'v1');
    assert.equal(repo.audioPath('au1'), 'aqua.mp3');
  });

  it('indexes custom assets by folder name', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'amii-'));
    await fs.mkdir(path.join(root, 'Patiently_Waiting'), { recursive: true });
    await fs.writeFile(path.join(root, 'Patiently_Waiting', 'wait.gif'), '');
    await fs.writeFile(path.join(root, 'notes.txt'), '');
    const custom = new VisualRepository();
    assert.equal(await custom.scanCustom(root), 1);
    assert.equal(custom.pick([MemeCategory.PatientlyWaiting], prefs({ onlyCustomAssets: true }))?.alt, 'wait');
  });
});

describe('AssetStore', () => {
  it('caches definitions, then asks for deltas with changedSince', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'amii-store-'));
    const calls: string[] = [];
    const responses = [[{ id: '1', name: 'Aqua' }], [{ id: '2', name: 'Megumin' }]];
    const fetchImpl = (async (url: URL) => {
      calls.push(String(url));
      return new Response(JSON.stringify(responses.shift() ?? []));
    }) as unknown as typeof fetch;

    const store = new AssetStore({ apiUrl: 'http://api.test/public', assetSource: 'http://cdn.test', storageDir: dir, fetchImpl });
    assert.equal((await store.loadDefinitions('anime')).length, 1);
    assert.equal((await store.loadDefinitions('anime')).length, 1, 'served from disk');
    assert.equal(calls.length, 1);

    const stale = new AssetStore({ apiUrl: 'http://api.test/public', assetSource: 'http://cdn.test', storageDir: dir, fetchImpl, refreshIntervalMs: -1 });
    assert.deepEqual((await stale.loadDefinitions('anime')).map((a) => a.id), ['2', '1']);
    assert.match(calls[1], /^http:\/\/api\.test\/public\/assets\/anime\?changedSince=\d+$/);
  });

  it('downloads media once and refuses path traversal', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'amii-media-'));
    let downloads = 0;
    const fetchImpl = (async () => {
      downloads++;
      return new Response('GIF89a');
    }) as unknown as typeof fetch;
    const store = new AssetStore({ apiUrl: 'http://api.test/', assetSource: 'http://cdn.test', storageDir: dir, fetchImpl });
    const [a, b] = await Promise.all([store.resolveMedia('visuals', 'x/y.gif'), store.resolveMedia('visuals', 'x/y.gif')]);
    assert.equal(a, b);
    assert.equal(downloads, 1);
    await assert.rejects(store.resolveMedia('visuals', '../../etc/passwd'));
  });
});

describe('classify', () => {
  const policy = { positiveExitCodes: new Set([0]), allowedExitCodes: new Set([130]) };
  it('categorizes exit codes', () => {
    assert.equal(categorizeExitCode(0, policy), UserEventCategory.Positive);
    assert.equal(categorizeExitCode(130, policy), undefined);
    assert.equal(categorizeExitCode(1, policy), UserEventCategory.Negative);
    assert.equal(categorizeExitCode(undefined, policy), undefined);
  });

  it('recognizes test commands', () => {
    for (const cmd of ['npm test', 'cargo test --all', 'pnpm run test', 'npx vitest', './gradlew test', 'go test ./...', 'pytest -q']) {
      assert.equal(terminalEventType(cmd), UserEventType.Test, cmd);
    }
    assert.equal(terminalEventType('npm run build'), UserEventType.Process);
  });

  it('filters commands by allow-list', () => {
    const allow = ['npm', 'cargo', './gradlew', 'jest'];
    assert.ok(isAllowedCommand('FOO=1 npm run build', allow));
    assert.ok(isAllowedCommand('./node_modules/.bin/jest', allow));
    assert.ok(!isAllowedCommand('ls -la', allow));
    assert.ok(isAllowedCommand('ls', []));
  });
});
