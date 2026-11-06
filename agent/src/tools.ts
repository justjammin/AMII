import type { BetaToolResultContentBlockParam } from '@anthropic-ai/sdk/resources/beta';
import { betaZodTool } from '@anthropic-ai/sdk/helpers/beta/zod';
import * as z from 'zod/v4';
import { CATEGORY_NAMES, categoryId } from './categories';
import { GiphyCandidate, RateLimitedError, searchGiphy } from './giphy';

export interface Character {
  id: string;
  name: string;
  anime: string;
}

export interface SessionOptions {
  apiUrl: string;
  /** GIPHY ids already in the manifest for this character: never shown again. */
  knownIds: ReadonlySet<string>;
  maxSearches: number;
  perSearch: number;
  /** Longest we'll wait out a 429 from the AMII API before telling the model to wrap up. */
  maxRateLimitWaitSeconds?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export interface Accepted {
  gif: GiphyCandidate;
  cat: number[];
  confidence: number;
  reason: string;
}

/**
 * Per-character state behind the agent's two tools. The model can only record GIFs it was
 * actually shown, so a hallucinated or misremembered id is rejected rather than stored.
 */
export class CharacterSession {
  readonly shown = new Map<string, GiphyCandidate>();
  readonly accepted = new Map<string, Accepted>();
  searches = 0;

  constructor(readonly character: Character, private readonly opts: SessionOptions) {}

  async search(query: string, offset: number): Promise<string | BetaToolResultContentBlockParam[]> {
    if (this.searches >= this.opts.maxSearches) {
      throw new Error(`Search limit reached (${this.opts.maxSearches}). Record your picks with record_gifs and finish.`);
    }
    this.searches++;
    const sleep = this.opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    let results: GiphyCandidate[] | undefined;
    for (let attempt = 0; results === undefined; attempt++) {
      try {
        results = await searchGiphy(this.opts.apiUrl, query, offset, 25, this.opts.fetchImpl);
      } catch (err) {
        const wait = err instanceof RateLimitedError ? err.retryAfterSeconds : -1;
        if (wait < 0 || wait > (this.opts.maxRateLimitWaitSeconds ?? 120) || attempt >= 2) throw err;
        await sleep(wait * 1000);
      }
    }

    const fresh = results
      .filter((g) => g.rating.toLowerCase() !== 'r')
      .filter((g) => !this.opts.knownIds.has(g.id) && !this.shown.has(g.id))
      .slice(0, this.opts.perSearch);
    if (fresh.length === 0) {
      return `No new candidates for "${query}" at offset ${offset}. Try a different query or a higher offset (searches left: ${this.searchesLeft}).`;
    }

    const blocks: BetaToolResultContentBlockParam[] = [
      {
        type: 'text',
        text: `${fresh.length} new candidates for "${query}" (offset ${offset}); searches left: ${this.searchesLeft}. Each label is followed by that GIF's first frame.`,
      },
    ];
    for (const g of fresh) {
      this.shown.set(g.id, g);
      blocks.push({ type: 'text', text: `giphy_id=${g.id} | title: "${g.title}" | uploader: ${g.username || 'unknown'} | rating: ${g.rating || '?'}` });
      blocks.push({ type: 'image', source: { type: 'url', url: g.still } });
    }
    return blocks;
  }

  record(gifs: { giphy_id: string; categories: (typeof CATEGORY_NAMES)[number][]; confidence: number; reason: string }[]): string {
    const unknown = gifs.filter((g) => !this.shown.has(g.giphy_id)).map((g) => g.giphy_id);
    for (const g of gifs) {
      const gif = this.shown.get(g.giphy_id);
      if (!gif) continue;
      this.accepted.set(g.giphy_id, {
        gif,
        cat: [...new Set(g.categories.map(categoryId))].sort((a, b) => a - b),
        confidence: Math.max(0, Math.min(1, g.confidence)),
        reason: g.reason.slice(0, 300),
      });
    }
    const summary = `Recorded ${gifs.length - unknown.length}; ${this.accepted.size} accepted so far for ${this.character.name}.`;
    if (unknown.length > 0) {
      throw new Error(`${summary} Rejected ids you were not shown in a search result: ${unknown.join(', ')}. Only record giphy_id values from search results.`);
    }
    return summary;
  }

  private get searchesLeft(): number {
    return this.opts.maxSearches - this.searches;
  }
}

export function makeTools(session: CharacterSession) {
  const searchTool = betaZodTool({
    name: 'search_giphy',
    description:
      'Search GIPHY for GIFs. Returns up to ~10 unseen candidates, each as a label line with its giphy_id followed by a still of the first frame. ' +
      'Use specific queries (character name + anime, or name + an emotion). Increase offset to page through more results for the same query.',
    inputSchema: z.object({
      query: z.string().min(2).max(80).describe('Search text, e.g. "Aqua KonoSuba crying"'),
      offset: z.number().int().min(0).max(500).describe('Result offset for paging; 0 for the first page'),
    }),
    run: ({ query, offset }) => session.search(query, offset),
  });

  const recordTool = betaZodTool({
    name: 'record_gifs',
    description:
      'Record GIFs that clearly show the target character, with the AMII reaction categories each one fits. ' +
      'Call it as you go; you can call it several times. Only use giphy_id values from search results.',
    inputSchema: z.object({
      gifs: z
        .array(
          z.object({
            giphy_id: z.string().describe('Exactly as shown in the search result label'),
            categories: z.array(z.enum(CATEGORY_NAMES)).min(1).max(3).describe('Best-fitting AMII categories, most fitting first'),
            confidence: z.number().min(0).max(1).describe('How sure you are that this is the character AND the categories fit'),
            reason: z.string().max(300).describe('One short sentence: what the frame shows'),
          }),
        )
        .min(1)
        .max(25),
    }),
    run: ({ gifs }) => session.record(gifs),
  });

  return [searchTool, recordTool];
}
