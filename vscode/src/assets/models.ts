// REST representations served by the AMII API (`/public/assets/{category}`).

export interface Representation {
  id: string;
  /** Tombstone: present on `changedSince` deltas for deleted records. */
  del?: boolean;
}

export interface VisualRepresentation extends Representation {
  path: string;
  alt: string;
  cat: number[];
  char: string[];
  aud?: string;
  lewd?: boolean;
}

export interface AudibleRepresentation extends Representation {
  path: string;
}

export interface AnimeRepresentation extends Representation {
  name: string;
}

export interface CharacterRepresentation extends Representation {
  animeId: string;
  name: string;
  /** 0 = female, 1 = male, 2 = other (ordinal, as the API sends it). */
  gender: number;
}

/** `/public/giphy/visuals` from the AMII API: same shape as visuals plus a direct GIF url. */
export interface GiphyVisualRepresentation extends Representation {
  alt: string;
  cat: number[];
  lewd?: boolean;
  /** AMII character ids, for GIFs from the curated manifest. */
  char?: string[];
  url: string;
  /** GIPHY page, for attribution. */
  page: string;
  source: 'giphy';
}

/** The curated per-character GIPHY manifest (api/manifests/giphy-characters.json). */
export interface GiphyManifest {
  version: number;
  entries: {
    giphyId: string;
    characterId: string;
    cat: number[];
    reason?: string;
    url: string;
    page?: string;
    rating?: string;
  }[];
}

const RATING_ORDER = ['g', 'pg', 'pg-13', 'r'];

/**
 * Turns manifest entries into the same shape `/public/giphy/visuals` serves, merging categories and
 * characters when one GIF is listed for several characters. Entries rated above pg-13 are dropped.
 */
export function manifestToVisuals(manifest: GiphyManifest): GiphyVisualRepresentation[] {
  const byId = new Map<string, GiphyVisualRepresentation>();
  for (const e of manifest.entries ?? []) {
    if (!/^[A-Za-z0-9]+$/.test(e.giphyId)) continue;
    const rating = RATING_ORDER.indexOf((e.rating ?? '').toLowerCase());
    if (rating > RATING_ORDER.indexOf('pg-13')) continue;
    const id = `giphy:${e.giphyId}`;
    const v = byId.get(id) ?? {
      id,
      alt: e.reason || 'GIPHY',
      cat: [],
      char: [],
      lewd: false,
      url: e.url,
      page: e.page || `https://giphy.com/gifs/${e.giphyId}`,
      source: 'giphy' as const,
    };
    for (const c of e.cat) if (!v.cat.includes(c)) v.cat.push(c);
    if (!v.char!.includes(e.characterId)) v.char!.push(e.characterId);
    byId.set(id, v);
  }
  return [...byId.values()];
}

export type DefinitionCategory = 'visuals' | 'audible' | 'anime' | 'characters';
export const DEFINITION_CATEGORIES: readonly DefinitionCategory[] = ['anime', 'characters', 'visuals', 'audible'];

export interface Definitions {
  visuals: VisualRepresentation[];
  audible: AudibleRepresentation[];
  anime: AnimeRepresentation[];
  characters: CharacterRepresentation[];
}

/**
 * Applies a `changedSince` delta onto the existing set: newer records win,
 * tombstoned ids are dropped. Port of APIAssetManager.downloadAndUpdateAssetDefinitions.
 */
export function mergeDefinitions<T extends Representation>(existing: readonly T[], delta: readonly T[]): T[] {
  const deleted = new Set(delta.filter((d) => d.del).map((d) => d.id));
  const seen = new Set<string>();
  const merged: T[] = [];
  for (const item of [...delta, ...existing]) {
    if (item.del || deleted.has(item.id) || seen.has(item.id)) continue;
    seen.add(item.id);
    merged.push(item);
  }
  return merged;
}
