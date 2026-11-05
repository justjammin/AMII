# Hosting the AMII API

The service is one stateless container. The cache is in memory, and the GIPHY key and admin token
come from secrets. The recommended host is **Fly.io**: one always-on 512 MB machine costs a few
dollars a month, gets HTTPS on `<app>.fly.dev`, and is deployed by CI from `main`.

Any other Docker host works too. CI also publishes `ghcr.io/<owner>/amii-api:latest` (see [Other hosts](#other-hosts)).

## 1. Get a GIPHY key

1. Go to <https://developers.giphy.com/dashboard/> and **Create an App**, then choose **API**.
2. Copy the API key. Beta keys allow about 100 calls an hour, and the API's `GIPHY_HOURLY_BUDGET=90` stays under that.
   Request a production key from the same dashboard when you need more.

## 2. Create the Fly app (once)

```bash
brew install flyctl            # or: curl -L https://fly.io/install.sh | sh
fly auth login

cd api
# Pick a unique name and put it in fly.toml's `app = "..."`, then:
fly launch --no-deploy --copy-config --name <your-app-name>

fly secrets set GIPHY_API_KEY=<key-from-step-1> ADMIN_TOKEN=$(openssl rand -hex 24)
fly deploy
curl https://<your-app-name>.fly.dev/healthz        # -> ok
curl https://<your-app-name>.fly.dev/cache/stats
```

`fly.toml` keeps one machine running all the time (`auto_stop_machines = "off"`), because a
stopped machine would lose its cache. It health-checks `/healthz`, and its cache sizes add up
to about 210 MB on a 512 MB VM.

## 3. Let CI deploy on every push to `main`

```bash
fly tokens create deploy --expiry 8760h   # copy the token (1 year)
```

In GitHub, go to **Settings → Secrets and variables → Actions → New repository secret**, name it
`FLY_API_TOKEN` and paste the token. The `API & VS Code` workflow (`.github/workflows/api.yml`)
then does this on each push to `main`:

1. Runs `cargo clippy -D warnings`, `cargo test --workspace` and the extension tests, and packages the `.vsix` as an artifact.
2. Builds and pushes `ghcr.io/<owner>/amii-api:{latest,<sha>}`.
3. Runs `flyctl deploy --remote-only` and smoke-tests `https://<app>.fly.dev/healthz`.

Without the secret, step 3 is skipped with a notice. The deploy job uses a GitHub
`production` environment, so you can require approvals in **Settings → Environments**.

## 4. Point the editors at it

VS Code (`settings.json`):

```json
"amii.apiUrl": "https://<your-app-name>.fly.dev/public/",
"amii.assetSource": "https://<your-app-name>.fly.dev/media",
"amii.giphy.enabled": true
```

IntelliJ plugin: launch the IDE with
`API_URL=https://<your-app-name>.fly.dev/public/ ASSET_SOURCE=https://<your-app-name>.fly.dev/media`.

## Operating it

```bash
fly logs                                   # request logs (RUST_LOG in fly.toml)
curl https://<app>.fly.dev/cache/stats     # hit/miss/stale counts, GIPHY budget left this hour
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" https://<app>.fly.dev/cache/purge
fly scale memory 1024                      # then raise MEDIA_CACHE_MB in fly.toml
fly secrets set GIPHY_API_KEY=<new>        # rotate; triggers a restart
```

**Scaling out:** each machine has its own cache. Two machines in different regions work fine,
because each warms independently and the GIPHY budget is per machine, so set
`GIPHY_HOURLY_BUDGET` to about 90 divided by the machine count. If you need one shared cache,
put Redis behind `ResponseCache` (Upstash on Fly: `fly redis create`).

## Other hosts

The image is self-contained: it listens on `$PORT` (default 8080), exposes `GET /healthz`
and runs as non-root. Set the same env vars and secrets.

| Host | How |
| --- | --- |
| **Render** | New Web Service, then Existing image `ghcr.io/<owner>/amii-api:latest`. Health check path `/healthz`, and add the env vars. Use a paid instance; free ones sleep and drop the cache. |
| **Google Cloud Run** | `gcloud run deploy amii-api --image ghcr.io/<owner>/amii-api:latest --port 8080 --min-instances 1 --set-secrets GIPHY_API_KEY=giphy-key:latest` (mirror the image to Artifact Registry if your project requires it). |
| **Any VPS** | `docker run -d --restart unless-stopped -p 8080:8080 -e GIPHY_API_KEY=... ghcr.io/<owner>/amii-api:latest` behind Caddy or nginx for TLS. |

GHCR packages start out private. Make it public under **Package settings** or give the host
pull credentials.
