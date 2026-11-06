# amii-cdn

A Cloudflare Worker that serves AMII's meme images and audio from an **R2** bucket and
Cloudflare's edge, filling itself from the original asset server on demand. There is no sync job and no
upload step. The first request for a file stores it, and every later request is served by Cloudflare.

```
editor ── GET /visuals/happy/aqua.gif ──► Worker
                                           ├─ 1. edge cache (per data centre)       x-amii-source: edge
                                           ├─ 2. R2 bucket (durable, zero egress)   x-amii-source: r2
                                           └─ 3. ORIGIN, then stored in R2          x-amii-source: origin
```

Paths match the AMII asset server, so switching is just `amii.assetSource`.

## Why

- **Zero egress fees on R2**, so bandwidth costs don't grow with users.
- **Files survive restarts and deploys**, unlike the API's in-memory media cache.
- **Edge caching near users** and less work for the Fly app. With `MEDIA_REDIRECT_URL` set,
  the API stops serving GIF bytes and can drop `MEDIA_CACHE_MB` to a few MB.
- **Origin outages:** files already in R2 keep working.

## What it will and won't store

- Only `GET`/`HEAD` on `/visuals/...` and `/audible/...` with a known media extension
  (`gif png jpg jpeg webp apng mp3 wav ogg m4a`). Anything else gets a 404 without contacting the origin.
- Only origin `200` responses whose type is `image/*` or `audio/*`, or untyped responses with a media
  extension. A `text/html` error page on a `.gif` path is refused and never stored.
- Files up to `MAX_OBJECT_MB` (25 MB). Bigger ones are streamed through without being stored.
- The query string is ignored, so `?v=123` can't be used to bypass the cache or flood R2.

**GIPHY GIFs are not routed through here.** GIPHY's API terms require serving their content from
GIPHY's CDN, so the GIPHY routes keep handing out `media.giphy.com` URLs.

**Rights:** the AMII asset files are anime clips from the AMII project. Mirroring them on your
own CDN redistributes them, so check that you're comfortable with that, or point `ORIGIN` at a
source you control and fill it with your own memes (same `visuals/<category>/<file>` layout).

## Deploy

You need a Cloudflare account; the free plan covers this. A domain on Cloudflare is
recommended but optional.

```bash
cd cdn
npm install
npx wrangler login
npx wrangler r2 bucket create amii-assets
npx wrangler deploy                      # -> https://amii-cdn.<your-subdomain>.workers.dev
curl -I https://amii-cdn.<your-subdomain>.workers.dev/visuals/mocking/aqua_mocking_laugh.gif
```

**Custom domain (recommended):** Cloudflare's edge cache (`caches.default`) only works on a
zone you own; on `*.workers.dev` every request goes to R2. Add your domain to Cloudflare,
uncomment the `routes` line in `wrangler.toml`, for example `cdn.example.com` with
`custom_domain = true`, and run `npx wrangler deploy` again.

**From CI:** add repository secrets `CLOUDFLARE_API_TOKEN` (use the "Edit Cloudflare Workers"
template, plus R2 edit permission) and `CLOUDFLARE_ACCOUNT_ID`. Pushes to `main` then test,
dry-run and deploy the Worker. See `.github/workflows/api.yml`.

## Point things at it

```jsonc
// VS Code settings.json
"amii.assetSource": "https://cdn.example.com",        // or the workers.dev URL
"amii.apiUrl": "https://<your-fly-app>.fly.dev/public/"
```

```toml
# api/fly.toml [env]: older clients that still use /media/* are 308-redirected to the CDN
MEDIA_REDIRECT_URL = "https://cdn.example.com"
MEDIA_CACHE_MB = "8"
```

IntelliJ plugin: `ASSET_SOURCE=https://cdn.example.com`.

## Settings (`wrangler.toml` `[vars]`)

| Var | Default | |
| --- | --- | --- |
| `ORIGIN` | `https://amii.assets.unthrottled.io` | Where misses are fetched from |
| `MAX_OBJECT_MB` | `25` | Largest file stored in R2 |
| `CACHE_CONTROL` | `public, max-age=604800, stale-while-revalidate=86400` | Sent to clients and the edge |

## Operating it

```bash
npx wrangler tail                                       # live logs
npx wrangler r2 object delete amii-assets/visuals/x.gif # evict one file (edge copies age out per CACHE_CONTROL)
```

To warm it ahead of time, request the paths once: `curl -s -o /dev/null <cdn>/visuals/<path>` for
each `path` in `/public/assets/visuals`.

**Cost:** R2 includes 10 GB of storage and 10 million reads a month free, with no egress charges. The
Workers free plan allows 100k requests a day; the paid plan ($5/mo) raises that to 10 million a month.

## Develop

```bash
npm test               # node:test with a fake R2 + edge cache: tiers, 304s, HEAD, refusal rules
npm run check          # wrangler dry-run bundle
npx wrangler dev --local --var ORIGIN:http://127.0.0.1:8000   # real workerd + local R2
```
