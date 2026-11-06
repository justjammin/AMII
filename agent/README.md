# GIPHY character curator (Claude agent)

> **The hosted API now curates on its own** (`api/src/curator.rs`): on a schedule it grabs new GIFs
> from GIPHY and has Claude categorize them, with no PRs. This CLI is the optional manual tool for a
> deeper, agentic pass on specific characters. Its output is baked into the API image after PR review.

Builds a manifest of GIPHY GIFs per AMII character, such as Aqua from KonoSuba or Rem from Re:Zero. Each GIF is
checked to really show that character and tagged with the AMII reaction categories it fits.
The manifest is reviewed in a pull request, baked into the API image, and merged into
`/public/giphy/visuals` with character ids. That makes the extension's **preferred characters**
setting work for GIPHY GIFs too.

```
for each character (fewest GIFs first):
  Claude ──search_giphy("Aqua KonoSuba smug")──► api.giphy.com   (GIPHY_API_KEY from a CI secret,
     ▲                                                             run-wide search budget, rating ≤ pg-13)
     └── label + first-frame still for each candidate (vision)
  Claude ──record_gifs([{giphy_id, categories, confidence, reason}])
          rejects ids it wasn't shown · drops confidence < 0.7 · never re-shows known ids
  → merged into api/manifests/giphy-characters.json → PR → review → deploy
```

## Why an agent and not a single prompt

Search results are noisy. A query for a character often turns up other characters from the same
show, cosplay, or unrelated GIFs, and good results come from rephrasing queries and searching
for missing emotions. Claude decides what to search next, looks at each candidate's still frame,
and stops when the categories are covered or the search budget is spent. Code does the rest:
budgets, validation, de-duplication, merging and saving after each character.

**Model:** `claude-opus-5-5` with adaptive thinking and effort `medium`, set by `--model` and `--effort`.
Requests use `fallbacks: "default"` (beta `server-side-fallback-2026-07-01`), so a policy
decline is retried on a suitable fallback model instead of failing the character. Prompt caching
is on (`cache_control: ephemeral`): the system prompt, tools and earlier turns, images included,
are re-read from cache on each loop iteration. The run log prints token totals.

## Run it

You need a GIPHY API key and an Anthropic API key. **This is the only place the GIPHY key is
used**: the deployed API just serves the reviewed manifest. The character list comes from the public
AMII API (`--api`, default the upstream one), so no server of yours has to be running.

```bash
cd agent && npm install
export ANTHROPIC_API_KEY=...            # or `ant auth login`
export GIPHY_API_KEY=...
npm run curate -- --dry-run                                  # which characters it would do
npm run curate -- --characters "Aqua,Megumin" --target 10
npm run curate -- --limit 20                                 # 20 characters with the fewest GIFs
git diff ../api/manifests/giphy-characters.json                      # review, then commit
```

| Flag | Default | |
| --- | --- | --- |
| `--characters` | (fewest-first) | Names or ids, comma-separated |
| `--limit` | `10` | Characters per run when none are named |
| `--target` | `12` | New GIFs to aim for per character |
| `--max-searches` | `6` | GIPHY searches per character |
| `--per-search` | `10` | New candidates shown per search (each is one small image) |
| `--min-confidence` | `0.7` | Lower picks are dropped |
| `--concurrency` | `2` | Characters in parallel |
| `--max-total-searches` | `90` | GIPHY searches for the whole run, shared by all characters |
| `--rating` | `pg-13` | Highest GIPHY rating requested |
| `--api` | upstream AMII API | Where the character list comes from |
| `--model` / `--effort` | `claude-opus-5-5` / `medium` | |

**GIPHY budget:** beta keys allow about 100 calls an hour. Each run is capped at
`--max-total-searches` (90), shared across characters, and each character at `--max-searches` (6).
Ten characters at six searches is about 60. When the budget runs out, Claude is told to finish with what it
has. A short 429 is waited out. For big runs, get a production key and raise the cap.

## Automate it

`.github/workflows/curate-giphy.yml` runs monthly, or on demand with character names, and opens a
PR titled "Curated GIPHY GIFs for AMII characters" with the run log. Set:

- secrets `ANTHROPIC_API_KEY` and `GIPHY_API_KEY`
- optional variable `AMII_API_URL` for the character list (default: the upstream AMII API)

Merging the PR rebuilds and redeploys the API with the new manifest.

## Reviewing a PR

Each entry has `still` (first frame), `page` (GIPHY link), `reason`, `confidence` and `cat`.
Delete entries you don't like, or fix `cat`. Re-runs never overwrite an existing
(character, GIF) entry, so your edits survive. Entries are stored by GIPHY id and URL only; the
GIFs themselves stay on GIPHY's CDN, as their terms require.

## Manifest format

```json
{ "version": 1, "updatedAt": "...", "entries": [
  { "giphyId": "abc123", "characterId": "<AMII id>", "characterName": "Aqua", "anime": "KonoSuba",
    "cat": [5], "confidence": 0.92, "reason": "Aqua smirking with arms crossed",
    "url": "https://media.giphy.com/media/abc123/giphy.gif", "still": "...200_s.gif",
    "page": "https://giphy.com/gifs/abc123", "rating": "g", "addedAt": "...", "model": "claude-opus-5-5" } ] }
```

## Develop

```bash
npm test   # tools, manifest merge, character selection, and a full run of the SDK tool runner
           # against a local fake Messages API (no API key or network needed)
```
