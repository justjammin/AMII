/**
 * Builds/extends a manifest of GIPHY GIFs per AMII character, using Claude as the curator.
 *
 *   GIPHY_API_KEY=... ANTHROPIC_API_KEY=... node out/src/cli.js [--characters "Aqua,Megumin"] [--limit 10]
 *        [--target 12] [--max-searches 6] [--concurrency 2] [--min-confidence 0.7]
 *        [--manifest ../api/manifests/giphy-characters.json] [--dry-run]
 *
 * Needs ANTHROPIC_API_KEY (or an `ant auth login` profile) and GIPHY_API_KEY. Characters come from the
 * public AMII API (--api, default the upstream one); no deployed server is involved.
 */
import Anthropic from '@anthropic-ai/sdk';
import { AgentOptions, runCharacter } from './agent';
import { knownIdsFor, loadManifest, mergeManifest, saveManifest } from './manifest';
import { Character, SearchBudget } from './tools';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}
const num = (name: string, fallback: number) => Number(arg(name) ?? fallback);

export async function loadCharacters(apiUrl: string, fetchImpl: typeof fetch = fetch): Promise<Character[]> {
  const base = apiUrl.endsWith('/') ? apiUrl : `${apiUrl}/`;
  const get = async <T>(path: string): Promise<T> => {
    const res = await fetchImpl(new URL(path, base));
    if (!res.ok) throw new Error(`GET ${path}: HTTP ${res.status}`);
    return (await res.json()) as T;
  };
  const anime = new Map((await get<{ id: string; name: string; del?: boolean }[]>('assets/anime')).filter((a) => !a.del).map((a) => [a.id, a.name]));
  return (await get<{ id: string; name: string; animeId: string; del?: boolean }[]>('assets/characters'))
    .filter((c) => !c.del && anime.has(c.animeId))
    .map((c) => ({ id: c.id, name: c.name, anime: anime.get(c.animeId)! }));
}

/** Named characters (by name or id), otherwise the ones with the fewest manifest entries first. */
export function chooseCharacters(all: Character[], countFor: (id: string) => number, names: string[] | undefined, limit: number): Character[] {
  if (names?.length) {
    const wanted = names.map((n) => n.trim().toLowerCase());
    const found = all.filter((c) => wanted.includes(c.id.toLowerCase()) || wanted.includes(c.name.toLowerCase()));
    const missing = wanted.filter((w) => !found.some((c) => c.id.toLowerCase() === w || c.name.toLowerCase() === w));
    if (missing.length) throw new Error(`Unknown characters: ${missing.join(', ')}`);
    return found;
  }
  return [...all].sort((a, b) => countFor(a.id) - countFor(b.id) || a.name.localeCompare(b.name)).slice(0, limit);
}

async function main() {
  const apiUrl = arg('api') ?? process.env.AMII_API_URL ?? 'https://amii.api.unthrottled.io/public/';
  const giphyKey = process.env.GIPHY_API_KEY;
  const dryRun = process.argv.includes('--dry-run');
  if (!giphyKey && !dryRun) throw new Error('Set GIPHY_API_KEY (get one at developers.giphy.com)');
  const manifestPath = arg('manifest') ?? '../api/manifests/giphy-characters.json';
  const opts: AgentOptions = {
    giphy: { apiKey: giphyKey ?? '', rating: (arg('rating') as 'g' | 'pg' | 'pg-13') ?? 'pg-13' },
    budget: new SearchBudget(num('max-total-searches', 90)),
    model: arg('model') ?? 'claude-opus-5-5',
    effort: (arg('effort') as AgentOptions['effort']) ?? 'medium',
    target: num('target', 12),
    maxSearches: num('max-searches', 6),
    perSearch: num('per-search', 10),
    minConfidence: num('min-confidence', 0.7),
    maxIterations: num('max-iterations', 20),
  };

  let manifest = await loadManifest(manifestPath);
  const characters = chooseCharacters(
    await loadCharacters(apiUrl),
    (id) => knownIdsFor(manifest, id).size,
    arg('characters')?.split(','),
    num('limit', 10),
  );
  console.log(`Curating ${characters.length} characters: ${characters.map((c) => `${c.name} (${c.anime})`).join(', ')}`);
  if (dryRun) return;

  const client = new Anthropic();
  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, added: 0 };
  const queue = [...characters];
  let failures = 0;
  const worker = async () => {
    for (let c = queue.shift(); c; c = queue.shift()) {
      try {
        const result = await runCharacter(client, c, knownIdsFor(manifest, c.id), opts);
        // Merge + save after each character so a crash keeps finished work.
        const merged = mergeManifest(manifest, result.entries);
        manifest = merged.manifest;
        await saveManifest(manifestPath, manifest);
        totals.added += merged.added;
        for (const k of ['input', 'output', 'cacheRead', 'cacheWrite'] as const) totals[k] += result.usage[k];
        console.log(
          `✓ ${c.name}: +${merged.added} (shown ${result.shown}, ${result.searches} searches, stop=${result.stopReason}) ${result.summary}`,
        );
      } catch (err) {
        failures++;
        if (err instanceof Anthropic.RateLimitError) console.error(`✗ ${c.name}: Claude rate limited, ${err.message}`);
        else if (err instanceof Anthropic.APIError) console.error(`✗ ${c.name}: Claude API ${err.status}: ${err.message}`);
        else console.error(`✗ ${c.name}: ${String(err)}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, num('concurrency', 2)) }, worker));

  console.log(
    `\nAdded ${totals.added} GIFs → ${manifestPath} (${manifest.entries.length} total). ` +
      `GIPHY searches used: ${num('max-total-searches', 90) - opts.budget.remaining}. ` +
      `Tokens: ${totals.input} in, ${totals.output} out, ${totals.cacheRead} cache-read, ${totals.cacheWrite} cache-write.`,
  );
  if (failures === characters.length && characters.length > 0) process.exit(1);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
