// Minimal GIPHY search client used by the curator (runs in CI with the GIPHY_API_KEY secret).

export interface GiphyCandidate {
  id: string;
  title: string;
  username: string;
  rating: string;
  /** Animated GIF to show in editors. */
  url: string;
  /** Static first frame, shown to the model. */
  still: string;
  /** GIPHY page, for attribution. */
  page: string;
}

interface Rendition {
  url?: string;
  size?: number | null;
}
interface RawGif {
  id: string;
  title?: string;
  username?: string;
  rating?: string;
  url?: string;
  images?: Record<string, Rendition | null | undefined>;
}

export class RateLimitedError extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super(`GIPHY rate limit hit; retry after ${retryAfterSeconds}s`);
  }
}

const MAX_GIF_BYTES = 4 * 1024 * 1024;

export function toCandidate(g: RawGif): GiphyCandidate | undefined {
  const i = g.images ?? {};
  const pick = (...keys: string[]) => keys.map((k) => i[k]).find((r) => r?.url);
  const still = pick('fixed_height_still', 'downsized_still', 'original_still');
  const anim =
    ['original', 'downsized_large', 'downsized_medium', 'downsized', 'fixed_height']
      .map((k) => i[k])
      .find((r) => r?.url && (r.size == null || r.size <= MAX_GIF_BYTES)) ?? pick('fixed_height');
  if (!still?.url || !anim?.url) return undefined;
  return {
    id: g.id,
    title: (g.title ?? '').replace(/ GIF( by .*)?$/, '').trim(),
    username: g.username ?? '',
    rating: g.rating ?? '',
    url: anim.url,
    still: still.url,
    page: g.url ?? `https://giphy.com/gifs/${g.id}`,
  };
}

export interface GiphyConfig {
  apiKey: string;
  /** Highest rating to request (GIPHY's `rating` param). */
  rating: 'g' | 'pg' | 'pg-13';
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export const DEFAULT_GIPHY_BASE = 'https://api.giphy.com/v1/';

/** GIPHY search, straight to api.giphy.com. Errors never include the URL, which carries the key. */
export async function searchGiphy(cfg: GiphyConfig, query: string, offset: number, limit: number): Promise<GiphyCandidate[]> {
  const url = new URL('gifs/search', cfg.baseUrl ?? DEFAULT_GIPHY_BASE);
  url.searchParams.set('api_key', cfg.apiKey);
  url.searchParams.set('q', query);
  url.searchParams.set('limit', String(Math.min(50, Math.max(1, limit))));
  url.searchParams.set('offset', String(Math.min(4999, Math.max(0, offset))));
  url.searchParams.set('rating', cfg.rating);
  url.searchParams.set('lang', 'en');
  const res = await (cfg.fetchImpl ?? fetch)(url);
  if (res.status === 429) throw new RateLimitedError(Number(res.headers.get('retry-after') ?? 60));
  if (res.status === 401 || res.status === 403) throw new Error('GIPHY rejected the API key (check the GIPHY_API_KEY secret)');
  if (!res.ok) throw new Error(`GIPHY search failed: HTTP ${res.status}`);
  const body = (await res.json()) as { data: RawGif[] };
  return body.data.map(toCandidate).filter((c): c is GiphyCandidate => !!c);
}
