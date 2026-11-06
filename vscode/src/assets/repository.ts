import { promises as fs } from 'fs';
import * as path from 'path';
import { categoryFromName, MemeCategory, Rng } from '../core/types';
import { CharacterRepresentation, Definitions, GiphyVisualRepresentation, VisualRepresentation } from './models';

export type Gender = 'female' | 'male' | 'other';
const GENDERS: readonly Gender[] = ['female', 'male', 'other'];

export interface SelectionPreferences {
  allowLewds: boolean;
  onlyCustomAssets: boolean;
  /** Character names or ids. Empty = everyone. */
  preferredCharacters: readonly string[];
  blacklistedCharacters: readonly string[];
  preferredGenders: readonly Gender[];
}

export interface Character {
  id: string;
  name: string;
  anime: string;
  gender: Gender;
}

export interface Visual {
  id: string;
  alt: string;
  categories: ReadonlySet<MemeCategory>;
  characters: readonly Character[];
  lewd: boolean;
  audioId?: string;
  /** Remote assets have a path relative to the asset source; custom ones are absolute files. */
  source:
    | { kind: 'remote'; path: string }
    | { kind: 'custom'; file: string }
    | { kind: 'giphy'; url: string; page: string };
}

const IMAGE_EXT = new Set(['.gif', '.png', '.jpg', '.jpeg', '.webp', '.apng']);
const RECENT_MEMORY = 10;

/** In-memory index of the synced definitions plus the user's custom asset folder. */
export class VisualRepository {
  private remote: Visual[] = [];
  private custom: Visual[] = [];
  private giphy: Visual[] = [];
  private characters = new Map<string, Character>();
  private audible = new Map<string, string>();
  private recent: string[] = [];

  constructor(private readonly rng: Rng = Math.random) {}

  get size(): number {
    return this.remote.length + this.custom.length + this.giphy.length;
  }

  get allCharacters(): Character[] {
    return [...this.characters.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  audioPath(audioId: string | undefined): string | undefined {
    return audioId ? this.audible.get(audioId) : undefined;
  }

  index(defs: Definitions): void {
    const anime = new Map(defs.anime.map((a) => [a.id, a.name]));
    this.characters = new Map(
      defs.characters
        .filter((c) => anime.has(c.animeId))
        .map((c: CharacterRepresentation) => [
          c.id,
          { id: c.id, name: c.name, anime: anime.get(c.animeId)!, gender: GENDERS[c.gender] ?? 'other' },
        ]),
    );
    this.audible = new Map(defs.audible.map((a) => [a.id, a.path]));
    this.remote = defs.visuals.map((v: VisualRepresentation) => ({
      id: v.id,
      alt: v.alt,
      categories: new Set(v.cat as MemeCategory[]),
      characters: v.char.map((id) => this.characters.get(id)).filter((c): c is Character => !!c),
      lewd: v.lewd === true,
      audioId: v.aud,
      source: { kind: 'remote', path: v.path },
    }));
  }

  indexGiphy(items: readonly GiphyVisualRepresentation[]): void {
    this.giphy = items.map((g) => ({
      id: g.id,
      alt: g.alt || 'GIPHY',
      categories: new Set(g.cat as MemeCategory[]),
      characters: (g.char ?? []).map((id) => this.characters.get(id)).filter((c): c is Character => !!c),
      lewd: g.lewd === true,
      source: { kind: 'giphy', url: g.url, page: g.page },
    }));
  }

  /**
   * Custom assets: `<root>/<category>/<anything>.gif`, e.g. `~/memes/celebration/yay.gif`.
   * Files directly in the root are treated as on-demand memes (Happy).
   */
  async scanCustom(root: string | undefined): Promise<number> {
    this.custom = [];
    if (!root) return 0;
    const found: Visual[] = [];
    const walk = async (dir: string, category?: MemeCategory) => {
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full, categoryFromName(entry.name) ?? category);
        } else if (IMAGE_EXT.has(path.extname(entry.name).toLowerCase())) {
          found.push({
            id: `custom:${full}`,
            alt: path.parse(entry.name).name.replace(/[_-]+/g, ' '),
            categories: new Set([category ?? MemeCategory.Happy]),
            characters: [],
            lewd: false,
            source: { kind: 'custom', file: full },
          });
        }
      }
    };
    await walk(root);
    this.custom = found;
    return found.length;
  }

  /** Picks a meme from one of the categories (duplicates = more weight), honouring preferences. */
  pick(categories: readonly MemeCategory[], prefs: SelectionPreferences): Visual | undefined {
    if (categories.length === 0) return undefined;
    // Weighted first choice, then fall back to the remaining categories.
    const first = categories[Math.floor(this.rng() * categories.length)];
    for (const category of new Set([first, ...categories])) {
      const candidates = this.candidates(category, prefs);
      if (candidates.length > 0) return this.remember(this.choose(candidates));
    }
    return undefined;
  }

  private candidates(category: MemeCategory, prefs: SelectionPreferences): Visual[] {
    const pool = prefs.onlyCustomAssets ? this.custom : [...this.remote, ...this.giphy, ...this.custom];
    const matches = (c: Character, list: readonly string[]) =>
      list.some((p) => p === c.id || p.toLowerCase() === c.name.toLowerCase());

    const allowed = pool.filter(
      (v) =>
        v.categories.has(category) &&
        (prefs.allowLewds || !v.lewd) &&
        !v.characters.some((c) => matches(c, prefs.blacklistedCharacters)) &&
        (v.characters.length === 0 || v.characters.some((c) => prefs.preferredGenders.includes(c.gender))),
    );
    if (prefs.preferredCharacters.length === 0) return allowed;
    const preferred = allowed.filter(
      (v) => v.source.kind === 'custom' || v.characters.some((c) => matches(c, prefs.preferredCharacters)),
    );
    return preferred.length > 0 ? preferred : allowed;
  }

  private choose(candidates: Visual[]): Visual {
    const fresh = candidates.filter((v) => !this.recent.includes(v.id));
    const pool = fresh.length > 0 ? fresh : candidates;
    return pool[Math.floor(this.rng() * pool.length)];
  }

  private remember(visual: Visual): Visual {
    this.recent = [visual.id, ...this.recent.filter((id) => id !== visual.id)].slice(0, RECENT_MEMORY);
    return visual;
  }
}
