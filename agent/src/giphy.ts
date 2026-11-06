// Thin client for the AMII API's GIPHY routes (the GIPHY key stays on the server).

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
    super(`AMII API GIPHY budget exhausted; retry after ${retryAfterSeconds}s`);
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

export async function searchGiphy(
  apiUrl: string,
  query: string,
  offset: number,
  limit: number,
  fetchImpl: typeof fetch = fetch,
): Promise<GiphyCandidate[]> {
  const base = apiUrl.replace(/\/public\/?$/, '').replace(/\/+$/, '');
  const url = new URL(`${base}/giphy/search`);
  url.searchParams.set('q', query);
  url.searchParams.set('offset', String(offset));
  url.searchParams.set('limit', String(limit));
  const res = await fetchImpl(url);
  if (res.status === 429) throw new RateLimitedError(Number(res.headers.get('retry-after') ?? 600));
  if (!res.ok) throw new Error(`GIPHY search failed: HTTP ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { data: RawGif[] };
  return body.data.map(toCandidate).filter((c): c is GiphyCandidate => !!c);
}
