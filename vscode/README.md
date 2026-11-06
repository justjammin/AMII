# AMII for VS Code

A TypeScript port of the [AMII](https://github.com/ani-memes/AMII) JetBrains plugin. MIKU (the
Meme Inference Knowledge Unit) watches your tasks, tests and terminal commands, builds up a mood,
and reacts with anime memes.

## What it reacts to

| Event | Source in VS Code |
| --- | --- |
| **TEST** pass/fail | Tasks in the `test` group or named `*test*`; terminal commands like `npm test`, `cargo test`, `pytest`, `go test`, `./gradlew test` |
| **TASK** pass/fail | Any other task (`tasks.json`, npm scripts, build tasks), judged by exit code |
| **PROCESS** pass/fail | Other integrated-terminal commands on `amii.terminalCommandAllowList` (needs shell integration) |
| **IDLE** / return | No editing for `amii.idleTimeoutMinutes`. MIKU gets patient, then bored, then tired. The meme goes away when you come back |
| **LOGS** | Terminal output containing one of `amii.logSearchTerms` (off by default) |
| **STARTUP**, **ON_DEMAND**, **SILENCE** | Window open, `AMII: Show Random Meme` / status-bar click, and a quiet meme after `amii.silenceTimeoutMinutes` without one |

The emotion engine is a straight port of the IntelliJ one. Repeated failures move MIKU from
shocked to disappointed to frustrated to enraged. A fix after a failure makes her smug, and
fixing a frustrating streak makes her relieved. Frustration cools down every 2 minutes, and
`AMII: Relax` resets it.

## Display

VS Code has no floating overlays, so memes go in one of two places (`amii.displayMode`):

- `beside` (default): a small editor tab opens beside your code without taking focus, and closes after `amii.memeDisplayDurationSeconds`.
- `panel`: the **AMII → MIKU** view in the bottom panel.

Click a meme to see who it is. Press ✕ to dismiss it.

## Commands

`AMII: Show Random Meme`, `Relax`, `Clear Memes`, `Show Previous Meme`, `Toggle Discreet Mode`,
`Toggle Minimal Mode`, `Synchronize Assets`, `Rescan Custom Assets`,
`Choose Preferred Characters`, `Settings`, `Simulate Event (debug)`.

## Custom memes

Set `amii.customAssetsPath` to a folder. Sub-folders named after a category tag their files:

```
~/memes/
  celebration/yay.gif
  frustration/table_flip.gif
  patiently_waiting/tap.gif
  smug.gif               # files in the root count as "happy"
```

Categories: acknowledgement, frustration, enraged, celebration, happy, smug, waiting, motivation,
welcoming, departure, encouragement, mocking, shocked, disappointment, alert, bored, tired,
patiently_waiting, pouting. Set `amii.onlyCustomAssets` to use only your own memes.

## Using your own caching API

Optional, see above. To run the caching API from `../api` instead of upstream:

```json
"amii.apiUrl": "http://localhost:8080/public/",
"amii.assetSource": "http://localhost:8080/media"
```

### GIPHY memes

Turn on `"amii.giphy.enabled": true` to add curated anime GIFs from GIPHY, tagged by character (so
they respect your preferred and blocked characters) and captioned "Powered by GIPHY".

- `"amii.giphy.source": "api"` (default) asks your hosted AMII API (`amii.apiUrl`). Its curator grabs
  new GIFs from GIPHY on a schedule and has Claude categorize them per character.
- `"amii.giphy.source": "manifest"` reads a manifest file straight from `amii.giphy.manifestUrl`, with no
  server. Point it at `https://<your-api>/public/giphy/manifest` or at the reviewed file on GitHub.

GIFs are only downloaded from `https://*.giphy.com`.

## Running with no server at all

Every default works without hosting anything: AMII's meme lists come from the upstream API, the images
come from the upstream asset server, and GIPHY GIFs come from the manifest on GitHub. Hosting the
`api/` server or the `cdn/` Worker is optional and adds caching, a CDN, and independence from upstream:

| Setting | No server (default) | Self-hosted |
| --- | --- | --- |
| `amii.apiUrl` | `https://amii.api.unthrottled.io/public/` | `https://<app>.fly.dev/public/` |
| `amii.assetSource` | `https://amii.assets.unthrottled.io` | `https://<your-cdn>` |
| `amii.giphy.source` | `manifest` | `api` (default) |

Definitions are also cached on disk under the extension's global storage and refreshed with
`changedSince` deltas once a day. Downloaded memes are kept, so the extension keeps working offline.

## Develop

```bash
npm install
npm test          # node:test, no VS Code needed (emotion engine, reactions, asset store, repository)
npm run compile
# F5 in VS Code ("Run AMII extension") to launch an Extension Development Host
npm run package   # -> amii-vscode-<version>.vsix  (code --install-extension amii-vscode-0.1.0.vsix)
```

Layout: `src/core` is pure TS (types, emotion engine, personality, MIKU orchestrator, event
classification). `src/assets` covers the API client, disk cache and meme selection.
`src/events` and `src/ui` hold the VS Code glue.

## Not ported (yet)

- Floating overlay anchors (`TOP_RIGHT`, `CENTER`, …): VS Code has no API for overlays.
- Doki Theme discreet-mode integration and per-project discreet mode.
- Run-configuration / test-runner results from other extensions' Testing API (VS Code doesn't expose them). Use tasks or the terminal instead.
- Promotion / onboarding flows and the settings tree UI. Use VS Code settings and `Choose Preferred Characters`.
