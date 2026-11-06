# amii-api

A small Rust service (axum + moka) that sits in front of the AMII asset API and media CDN and
caches the queries the editor plugins make. Point the VS Code extension (or the IntelliJ plugin,
via `API_URL` / `ASSET_SOURCE` env vars) at it instead of the upstream.

```
editor ──► amii-api ──► amii.api.unthrottled.io/public/   (definitions, JSON)
              │    └──► amii.assets.unthrottled.io          (gifs / audio)
              └─ in-memory cache: fresh → HIT, expired + upstream down → STALE
```

## Routes

| Route | What |
| --- | --- |
| `GET /public/assets/{visuals,audible,anime,characters}[?changedSince=<epoch s>]` | Asset definitions, cached for `QUERY_TTL_SECS` |
| `GET /media/{visuals,audible}/<path>` | Images / audio, cached for `MEDIA_TTL_SECS` |
| `GET /healthz` | Liveness |
| `GET /cache/stats` | Entries, bytes, hits, misses, stale serves, upstream errors |
| `POST /cache/purge` | Drop everything. Needs `Authorization: Bearer $ADMIN_TOKEN`; 404 when no token is set |
| `GET /public/giphy/visuals[?categories=smug,celebration]` | GIPHY anime GIFs as AMII meme definitions: one search per meme category, merged and tagged with `cat` |
| `GET /giphy/search?q=&limit=&offset=&rating=` | GIPHY search; rating is capped at `GIPHY_MAX_RATING` |
| `GET /giphy/trending?limit=&offset=` | GIPHY trending |
| `GET /giphy/gifs/{id}` | A single GIF |

Every cached response carries `X-Cache: HIT|MISS|STALE`, an `ETag` and `Cache-Control`;
`If-None-Match` gets a `304`.

## How the cache behaves

- **Single-flight**: concurrent misses for the same key make one upstream request; the rest wait and reuse it.
- **Stale-while-error**: once an entry expires it is refetched, but if upstream fails the last good copy is served (`STALE`) until `STALE_TTL_SECS`.
- **`changedSince` bucketing**: every client sends its own timestamp, which would make every
  delta query unique. The API rounds it *down* to `CHANGED_SINCE_BUCKET_SECS` (1h default), so
  clients share entries. That's safe because an earlier `changedSince` returns a superset, and
  clients merge deltas idempotently (newer record wins, `del: true` removes).
- **Bounded by bytes**: `QUERY_CACHE_MB` / `MEDIA_CACHE_MB` cap the total body size (LRU-ish eviction via moka's TinyLFU).
- Only known categories and `visuals/` / `audible/` media paths are proxied. It is not an open proxy.

## GIPHY

GIPHY GIFs that editors see come from the **curator** below, plus the optional baked-in manifest
(`manifests/giphy-characters.json`, e.g. from the [`agent/`](../agent/README.md) CLI). `/giphy/search`,
`/giphy/trending` and `/giphy/gifs/{id}` are raw GIPHY proxies that need `GIPHY_API_KEY`. The key never leaves the server.

- **Same cache as everything else:** single-flight, stale-while-error, ETags. Search keys are normalized (case, whitespace, clamped limit and rating), so equivalent queries share an entry.
- **Hourly budget:** `GIPHY_HOURLY_BUDGET` (default 90) caps upstream calls, because beta keys allow about 100 an hour. Once it's spent, cached copies are served `STALE`, and uncached queries get `429` with `Retry-After`. `/cache/stats` shows the remaining budget.
- **Ratings:** whatever a client asks for, GIPHY is never asked above `GIPHY_MAX_RATING` (`pg-13` by default). `r` results are flagged `lewd` so the extension's filter applies.
- **Cost:** a cold `/public/giphy/visuals` makes 19 GIPHY calls, one per category. After that it's served from cache for `GIPHY_TTL_SECS` (6 hours).

## Deploy

See [DEPLOY.md](DEPLOY.md). It covers Fly.io (configured in `fly.toml` and deployed by CI) and any other Docker host via the GHCR image.

## GIPHY curator (built in)

The API grabs new GIPHY GIFs and categorizes them itself (`src/curator.rs`). Every
`CURATOR_INTERVAL_HOURS` (24 by default), and when you trigger a run:

1. It picks the `CURATOR_CHARACTERS_PER_RUN` characters with the fewest GIFs (from the upstream AMII list).
2. It searches GIPHY for "<name> <anime>", then "<name> <emotion>" for that character's thinnest categories.
   Results are rated pg-13 or below, and GIFs it already judged or that were removed are skipped.
3. It sends all candidates to Claude (`CURATOR_MODEL`, `claude-opus-5-5`) in **one request**, as a label
   plus the first-frame still for each. Claude returns schema-constrained JSON: is it really this
   character, 1-3 AMII categories, a confidence, and a reason. Policy declines fall back automatically
   (`fallbacks: "default"`).
4. GIFs that show the character, at `CURATOR_MIN_CONFIDENCE` (0.7) or above, are saved to
   `$CURATOR_DATA_DIR/giphy-curated.json` (a Fly volume) and served right away from `/public/giphy/visuals`,
   tagged with the character id. Every judged GIF is remembered, so none is paid for twice.

Only GIF ids that were actually sent to Claude can be stored. Cost: one Claude call per character per run,
with about 20 small images; the token totals are in `/admin/curator/status`.

```bash
H="Authorization: Bearer $ADMIN_TOKEN"
curl -X POST -H "$H" "https://<app>.fly.dev/admin/curator/run?characters=Aqua,Megumin"   # run now (202)
curl -H "$H" https://<app>.fly.dev/admin/curator/status                                  # last run, counts, tokens
curl https://<app>.fly.dev/public/giphy/manifest                                          # everything served, for review
curl -X DELETE -H "$H" https://<app>.fly.dev/admin/giphy/<giphyId>                         # remove + block a bad one
```

## Run locally

```bash
cargo run --release                       # http://localhost:8080
# or
docker build -t amii-api . && docker run -p 8080:8080 amii-api
```

Then in VS Code settings:

```json
"amii.apiUrl": "http://localhost:8080/public/",
"amii.assetSource": "http://localhost:8080/media"
```

## Configuration (env)

| Var | Default |
| --- | --- |
| `PORT` | `8080` |
| `UPSTREAM_API_URL` | `https://amii.api.unthrottled.io/public/` |
| `UPSTREAM_ASSET_URL` | `https://amii.assets.unthrottled.io` |
| `QUERY_TTL_SECS` | `300` |
| `STALE_TTL_SECS` | `86400` |
| `QUERY_CACHE_MB` | `64` |
| `MEDIA_TTL_SECS` | `604800` |
| `MEDIA_STALE_TTL_SECS` | `2592000` |
| `MEDIA_CACHE_MB` | `512` |
| `CHANGED_SINCE_BUCKET_SECS` | `3600` |
| `UPSTREAM_TIMEOUT_SECS` | `15` |
| `ADMIN_TOKEN` | unset (purge disabled) |
| `MEDIA_REDIRECT_URL` | unset. When set to your CDN (see `../cdn`), `/media/*` answers with a 308 redirect there instead of proxying |
| `GIPHY_API_KEY` | unset. Needed by the curator (and the `/giphy/*` routes, which return 503 without it) |
| `ANTHROPIC_API_KEY` | unset. Needed by the curator to categorize GIFs |
| `CURATOR_DATA_DIR` | unset (in memory). `/data` on Fly (volume) |
| `CURATOR_INTERVAL_HOURS` | `24` (`0` = manual runs only) |
| `CURATOR_CHARACTERS_PER_RUN` / `CURATOR_SEARCHES_PER_CHARACTER` / `CURATOR_CANDIDATES_PER_CHARACTER` | `5` / `3` / `20` |
| `CURATOR_TARGET_PER_CHARACTER` | `15` (scheduled runs skip characters that have this many) |
| `CURATOR_MIN_CONFIDENCE` | `0.7` |
| `CURATOR_MODEL` / `CURATOR_EFFORT` | `claude-opus-5-5` / `medium` |
| `GIPHY_LIVE_SEARCH` | `false`. `true` also mixes live, uncurated per-category searches into `/public/giphy/visuals` |
| `GIPHY_MAX_RATING` | `pg-13` |
| `GIPHY_QUERY_PREFIX` | `anime` |
| `GIPHY_PER_CATEGORY` | `25` (max 50) |
| `GIPHY_HOURLY_BUDGET` | `90` |
| `GIPHY_TTL_SECS` / `GIPHY_STALE_TTL_SECS` | `21600` / `604800` |
| `GIPHY_CACHE_MB` | `32` |
| `GIPHY_MAX_GIF_MB` | `4` (largest rendition handed to editors) |
| `GIPHY_MANIFEST` | `/manifests/giphy-characters.json` in the image. A curated per-character manifest (path or URL) from [`../agent`](../agent/README.md), merged into `/public/giphy/visuals` with character ids; served even without `GIPHY_API_KEY` |
| `RUST_LOG` | `amii_api=info,tower_http=info` |

## Test

```bash
cargo test --workspace   # mock upstream + mock GIPHY: HIT/MISS, coalescing, bucketing, STALE, ETag/304,
                         # path confinement, purge auth, GIPHY fan-out/merge, rating cap, budget, key never leaked
```

The cache is in-memory, so it is per instance and empties on restart. If you run more than one
replica, put Redis behind `ResponseCache` (the `get_or_fetch` interface stays the same).
