import { promises as fs } from 'fs';

/** One reviewed GIPHY GIF for one AMII character. */
export interface ManifestEntry {
  giphyId: string;
  characterId: string;
  characterName: string;
  anime: string;
  /** AMII category ids (see categories.ts). */
  cat: number[];
  confidence: number;
  reason: string;
  url: string;
  still: string;
  page: string;
  rating: string;
  addedAt: string;
  model: string;
}

export interface Manifest {
  version: 1;
  updatedAt: string;
  entries: ManifestEntry[];
}

export const emptyManifest = (): Manifest => ({ version: 1, updatedAt: new Date(0).toISOString(), entries: [] });

export async function loadManifest(path: string): Promise<Manifest> {
  try {
    const m = JSON.parse(await fs.readFile(path, 'utf8')) as Manifest;
    if (m.version !== 1 || !Array.isArray(m.entries)) throw new Error('unsupported manifest');
    return m;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return emptyManifest();
    throw err;
  }
}

const key = (e: Pick<ManifestEntry, 'giphyId' | 'characterId'>) => `${e.characterId}:${e.giphyId}`;

/** Adds new entries; an existing (character, gif) pair is kept as-is so human edits survive re-runs. */
export function mergeManifest(existing: Manifest, additions: readonly ManifestEntry[], now = new Date()): { manifest: Manifest; added: number } {
  const seen = new Set(existing.entries.map(key));
  const fresh = additions.filter((a) => !seen.has(key(a)) && (seen.add(key(a)), true));
  const entries = [...existing.entries, ...fresh].sort(
    (a, b) => a.characterName.localeCompare(b.characterName) || a.giphyId.localeCompare(b.giphyId),
  );
  return { manifest: { version: 1, updatedAt: fresh.length ? now.toISOString() : existing.updatedAt, entries }, added: fresh.length };
}

export async function saveManifest(path: string, manifest: Manifest): Promise<void> {
  const tmp = `${path}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(manifest, null, 2) + '\n');
  await fs.rename(tmp, path);
}

export function knownIdsFor(manifest: Manifest, characterId: string): Set<string> {
  return new Set(manifest.entries.filter((e) => e.characterId === characterId).map((e) => e.giphyId));
}
