//! Server-side GIPHY curator.
//!
//! On a schedule (and on demand via `POST /admin/curator/run`), for the characters with the fewest
//! GIFs: search GIPHY for "<name> <anime>" plus emotion queries for that character's thinnest
//! categories, then send the candidates' first-frame stills to Claude in one request. Claude
//! returns, per GIF, whether it really shows the character and which AMII categories fit, as
//! schema-constrained JSON. Accepted GIFs go into a curated store on disk (a Fly volume) and are
//! served from `/public/giphy/visuals` straight away, tagged with the character id.
//!
//! * Only GIF ids that were actually sent to Claude can be stored.
//! * Every GIF Claude judged is remembered, so it is never paid for twice.
//! * `DELETE /admin/giphy/{id}` removes a GIF and blocks it from coming back.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use giphy::{Rating, SearchParams};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::sync::{Mutex, RwLock};

use crate::giphy_routes::CATEGORY_QUERIES;
use crate::{AppState, authorized};

pub const ANTHROPIC_VERSION: &str = "2026-10-21";
pub const FALLBACK_BETA: &str = "server-side-fallback-2026-07-01";

/// Visual cues per category, shown to Claude. Same ids/names as `CATEGORY_QUERIES`.
const CATEGORY_HINTS: &[(&str, &str)] = &[
    ("acknowledgement", "nodding, thumbs up, \"got it\", okay gesture"),
    ("frustration", "annoyed, exasperated, head in hands, grumbling"),
    ("enraged", "furious, screaming, flipping a table, rage aura"),
    ("celebration", "cheering, dancing, victory pose, confetti"),
    ("happy", "smiling, laughing warmly, cheerful"),
    ("smug", "smirk, self-satisfied, \"heh\", hair flip"),
    ("waiting", "waiting around, looking at a watch, sitting idle"),
    ("motivation", "determined, fist pump, \"you can do it\", fired up"),
    ("welcoming", "waving hello, greeting, welcoming gesture"),
    ("departure", "waving goodbye, leaving, walking away"),
    ("encouragement", "cheering someone on, supportive, pom-poms"),
    ("mocking", "laughing at someone, pointing and laughing, teasing"),
    ("shocked", "jaw drop, wide eyes, gasp, stunned"),
    ("disappointment", "sigh, facepalm, let down, dejected"),
    ("alert", "startled, alarmed, \"!\" reaction, sudden attention"),
    ("bored", "yawning, slumped, uninterested, chin on hand"),
    ("tired", "sleepy, falling asleep, exhausted"),
    ("patiently_waiting", "tapping foot or fingers, waiting patiently"),
    ("pouting", "pout, puffed cheeks, sulking, \"hmph\""),
];

// ------------------------------------------------------------------ config

#[derive(Debug, Clone)]
pub struct CuratorConfig {
    pub anthropic_api_key: Option<String>,
    pub anthropic_base_url: String,
    pub model: String,
    pub effort: String,
    /// Where the curated store is persisted (a Fly volume). `None` keeps it in memory only.
    pub data_dir: Option<PathBuf>,
    /// How often the scheduled run fires. Zero disables the schedule (manual runs still work).
    pub interval: Duration,
    pub characters_per_run: usize,
    pub searches_per_character: usize,
    pub candidates_per_character: usize,
    /// Characters at or above this many GIFs are skipped by scheduled runs.
    pub target_per_character: usize,
    pub min_confidence: f64,
}

impl CuratorConfig {
    pub fn from_env() -> Self {
        fn var<T: std::str::FromStr>(name: &str, default: T) -> T {
            std::env::var(name).ok().and_then(|v| v.parse().ok()).unwrap_or(default)
        }
        Self {
            anthropic_api_key: std::env::var("ANTHROPIC_API_KEY").ok().filter(|k| !k.is_empty()),
            anthropic_base_url: var("ANTHROPIC_BASE_URL", "https://api.anthropic.com".to_owned()),
            model: var("CURATOR_MODEL", "claude-opus-5-5".to_owned()),
            effort: var("CURATOR_EFFORT", "medium".to_owned()),
            data_dir: std::env::var("CURATOR_DATA_DIR").ok().filter(|d| !d.is_empty()).map(PathBuf::from),
            interval: Duration::from_secs(var("CURATOR_INTERVAL_HOURS", 24u64) * 3600),
            characters_per_run: var("CURATOR_CHARACTERS_PER_RUN", 5),
            searches_per_character: var("CURATOR_SEARCHES_PER_CHARACTER", 3usize).max(1),
            candidates_per_character: var("CURATOR_CANDIDATES_PER_CHARACTER", 20usize).clamp(1, 40),
            target_per_character: var("CURATOR_TARGET_PER_CHARACTER", 15),
            min_confidence: var("CURATOR_MIN_CONFIDENCE", 0.7),
        }
    }

    /// Off: no key, no schedule, nothing persisted.
    pub fn disabled() -> Self {
        Self {
            anthropic_api_key: None,
            anthropic_base_url: "https://api.anthropic.com".into(),
            model: "claude-opus-5-5".into(),
            effort: "medium".into(),
            data_dir: None,
            interval: Duration::ZERO,
            characters_per_run: 5,
            searches_per_character: 3,
            candidates_per_character: 20,
            target_per_character: 15,
            min_confidence: 0.7,
        }
    }
}

// ------------------------------------------------------------------- store

/// Same entry shape as `manifests/giphy-characters.json` (and the `agent/` CLI).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ManifestEntry {
    pub giphy_id: String,
    pub character_id: String,
    #[serde(default)]
    pub character_name: String,
    #[serde(default)]
    pub anime: String,
    pub cat: Vec<u8>,
    #[serde(default)]
    pub confidence: f64,
    #[serde(default)]
    pub reason: String,
    pub url: String,
    #[serde(default)]
    pub still: String,
    #[serde(default)]
    pub page: String,
    #[serde(default)]
    pub rating: String,
    #[serde(default)]
    pub added_at: String,
    #[serde(default)]
    pub model: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CuratedStore {
    #[serde(default = "one")]
    pub version: u32,
    #[serde(default)]
    pub updated_at: String,
    #[serde(default)]
    pub entries: Vec<ManifestEntry>,
    /// Character id -> GIPHY ids Claude already judged (accepted or not).
    #[serde(default)]
    pub evaluated: BTreeMap<String, Vec<String>>,
    /// GIPHY ids removed by an admin; never served or re-added.
    #[serde(default)]
    pub blocked: Vec<String>,
}

fn one() -> u32 {
    1
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct CharacterReport {
    pub character: String,
    pub searches: usize,
    pub candidates: usize,
    pub added: usize,
    pub rejected: usize,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct RunReport {
    pub started_at: String,
    pub finished_at: Option<String>,
    pub trigger: String,
    pub characters: Vec<CharacterReport>,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub error: Option<String>,
}

pub struct CuratorState {
    pub config: CuratorConfig,
    pub store: RwLock<CuratedStore>,
    pub last_run: RwLock<Option<RunReport>>,
    running: Mutex<()>,
}

impl CuratorState {
    pub fn load(config: CuratorConfig) -> Self {
        if let Some(dir) = &config.data_dir {
            let probe = dir.join(".write-test");
            let writable = std::fs::create_dir_all(dir).and_then(|_| std::fs::write(&probe, b"ok")).and_then(|_| std::fs::remove_file(&probe));
            if let Err(e) = writable {
                tracing::error!(error = %e, dir = %dir.display(), "CURATOR_DATA_DIR is not writable; curated GIFs will be lost on restart");
            }
        }
        let store = config
            .data_dir
            .as_ref()
            .and_then(|dir| std::fs::read(dir.join("giphy-curated.json")).ok())
            .and_then(|bytes| match serde_json::from_slice::<CuratedStore>(&bytes) {
                Ok(s) => Some(s),
                Err(e) => {
                    tracing::error!(error = %e, "curated store is unreadable; starting empty (file left untouched until next save)");
                    None
                }
            })
            .unwrap_or_else(|| CuratedStore { version: 1, ..Default::default() });
        Self { config, store: RwLock::new(store), last_run: RwLock::new(None), running: Mutex::new(()) }
    }

    pub fn enabled(&self) -> bool {
        self.config.anthropic_api_key.is_some()
    }

    async fn save(&self) {
        let Some(dir) = &self.config.data_dir else { return };
        let bytes = {
            let mut store = self.store.write().await;
            store.updated_at = now_rfc3339();
            serde_json::to_vec_pretty(&*store).expect("serializable store")
        };
        let path = dir.join("giphy-curated.json");
        let tmp = dir.join("giphy-curated.json.tmp");
        let result = async {
            tokio::fs::create_dir_all(dir).await?;
            tokio::fs::write(&tmp, &bytes).await?;
            tokio::fs::rename(&tmp, &path).await
        }
        .await;
        if let Err(e) = result {
            tracing::error!(error = %e, path = %path.display(), "failed to persist curated store");
        }
    }
}

// ------------------------------------------------------------- scheduling

pub fn spawn_scheduler(state: Arc<AppState>) {
    let curator = &state.curator;
    if !curator.enabled() || curator.config.interval.is_zero() {
        tracing::info!(enabled = curator.enabled(), "GIPHY curator schedule off");
        return;
    }
    let interval = curator.config.interval;
    tracing::info!(hours = interval.as_secs() / 3600, "GIPHY curator scheduled");
    tokio::spawn(async move {
        // Give the app a moment to warm caches before the first run.
        tokio::time::sleep(Duration::from_secs(60)).await;
        loop {
            match run(&state, None, "schedule").await {
                Ok(report) => tracing::info!(added = report.characters.iter().map(|c| c.added).sum::<usize>(), "curator run finished"),
                Err(e) => tracing::warn!(error = %e, "curator run skipped"),
            }
            tokio::time::sleep(interval).await;
        }
    });
}

/// One curation pass. Returns an error only when nothing could run (busy, not configured, no characters).
pub async fn run(state: &AppState, only: Option<Vec<String>>, trigger: &str) -> Result<RunReport, String> {
    let curator = &state.curator;
    let Some(api_key) = curator.config.anthropic_api_key.clone() else { return Err("ANTHROPIC_API_KEY is not set".into()) };
    let Some(client) = state.giphy.client.clone() else { return Err("GIPHY_API_KEY is not set".into()) };
    let Ok(_guard) = curator.running.try_lock() else { return Err("a curator run is already in progress".into()) };

    let mut report = RunReport { started_at: now_rfc3339(), trigger: trigger.to_owned(), ..Default::default() };
    *curator.last_run.write().await = Some(report.clone());

    let characters = match load_characters(state).await {
        Ok(c) => c,
        Err(e) => {
            report.error = Some(e.clone());
            report.finished_at = Some(now_rfc3339());
            *curator.last_run.write().await = Some(report);
            return Err(e);
        }
    };
    let baked = crate::giphy_routes::baked_entries(state).await;
    let chosen = choose_characters(&characters, &baked, &*curator.store.read().await, only.as_deref(), &curator.config);

    for character in chosen {
        let result = curate_character(state, &client, &api_key, &character, &baked).await;
        report.input_tokens += result.1;
        report.output_tokens += result.2;
        report.characters.push(result.0);
        curator.save().await;
        *curator.last_run.write().await = Some(report.clone());
    }
    report.finished_at = Some(now_rfc3339());
    *curator.last_run.write().await = Some(report.clone());
    Ok(report)
}

#[derive(Debug, Clone)]
pub struct Character {
    pub id: String,
    pub name: String,
    pub anime: String,
}

async fn load_characters(state: &AppState) -> Result<Vec<Character>, String> {
    #[derive(Deserialize)]
    struct Anime {
        id: String,
        name: String,
        #[serde(default)]
        del: Option<bool>,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Char {
        id: String,
        name: String,
        anime_id: String,
        #[serde(default)]
        del: Option<bool>,
    }
    let anime: Vec<Anime> = serde_json::from_slice(&crate::upstream_definitions(state, "anime").await?).map_err(|e| e.to_string())?;
    let chars: Vec<Char> = serde_json::from_slice(&crate::upstream_definitions(state, "characters").await?).map_err(|e| e.to_string())?;
    let names: HashMap<String, String> = anime.into_iter().filter(|a| a.del != Some(true)).map(|a| (a.id, a.name)).collect();
    Ok(chars
        .into_iter()
        .filter(|c| c.del != Some(true))
        .filter_map(|c| names.get(&c.anime_id).map(|a| Character { id: c.id, name: c.name, anime: a.clone() }))
        .collect())
}

fn choose_characters(
    all: &[Character],
    baked: &[ManifestEntry],
    store: &CuratedStore,
    only: Option<&[String]>,
    cfg: &CuratorConfig,
) -> Vec<Character> {
    if let Some(names) = only.filter(|n| !n.is_empty()) {
        let wanted: Vec<String> = names.iter().map(|n| n.trim().to_lowercase()).collect();
        return all.iter().filter(|c| wanted.contains(&c.id.to_lowercase()) || wanted.contains(&c.name.to_lowercase())).cloned().collect();
    }
    let mut counts: HashMap<&str, usize> = HashMap::new();
    for e in baked.iter().chain(store.entries.iter()) {
        *counts.entry(e.character_id.as_str()).or_default() += 1;
    }
    let mut eligible: Vec<&Character> =
        all.iter().filter(|c| counts.get(c.id.as_str()).copied().unwrap_or(0) < cfg.target_per_character).collect();
    eligible.sort_by(|a, b| {
        let ca = counts.get(a.id.as_str()).copied().unwrap_or(0);
        let cb = counts.get(b.id.as_str()).copied().unwrap_or(0);
        ca.cmp(&cb).then_with(|| a.name.cmp(&b.name))
    });
    eligible.into_iter().take(cfg.characters_per_run).cloned().collect()
}

struct Candidate {
    gif: giphy::Gif,
    still: String,
    url: String,
}

/// Returns (report, input tokens, output tokens).
async fn curate_character(
    state: &AppState,
    client: &giphy::Client,
    api_key: &str,
    character: &Character,
    baked: &[ManifestEntry],
) -> (CharacterReport, u64, u64) {
    let cfg = &state.curator.config;
    let mut report = CharacterReport { character: format!("{} ({})", character.name, character.anime), ..Default::default() };

    // What we already have for this character, and what not to look at again.
    let (known, mut cat_counts) = {
        let store = state.curator.store.read().await;
        let mut known: HashSet<String> = store.blocked.iter().cloned().collect();
        known.extend(store.evaluated.get(&character.id).into_iter().flatten().cloned());
        let mut cat_counts: HashMap<u8, usize> = CATEGORY_QUERIES.iter().map(|(id, _, _)| (*id, 0)).collect();
        for e in baked.iter().chain(store.entries.iter()).filter(|e| e.character_id == character.id) {
            known.insert(e.giphy_id.clone());
            for c in &e.cat {
                *cat_counts.entry(*c).or_default() += 1;
            }
        }
        (known, cat_counts)
    };

    // "<name> <anime>" first, then emotion queries for the thinnest categories.
    let mut queries = vec![format!("{} {}", character.name, character.anime)];
    let mut thin: Vec<(u8, usize)> = cat_counts.drain().collect();
    thin.sort();
    thin.sort_by_key(|(_, n)| *n);
    for (cat, _) in thin {
        if queries.len() >= cfg.searches_per_character {
            break;
        }
        if let Some((_, _, q)) = CATEGORY_QUERIES.iter().find(|(id, _, _)| *id == cat) {
            queries.push(format!("{} {q}", character.name));
        }
    }

    let max_rating = state.giphy.config.max_rating;
    let mut candidates: Vec<Candidate> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for q in queries {
        if candidates.len() >= cfg.candidates_per_character {
            break;
        }
        if !state.giphy.budget.try_take().await {
            report.error = Some("GIPHY hourly budget exhausted".into());
            break;
        }
        report.searches += 1;
        let page = match client.search(&SearchParams::new(q).limit(25).rating(max_rating)).await {
            Ok(p) => p,
            Err(e) => {
                report.error = Some(e.to_string());
                break;
            }
        };
        for gif in page.data {
            if candidates.len() >= cfg.candidates_per_character {
                break;
            }
            let ok_rating = matches!(gif.rating, Rating::Unrated) || gif.rating <= max_rating;
            if !ok_rating || known.contains(&gif.id) || !seen.insert(gif.id.clone()) || !gif.id.chars().all(|c| c.is_ascii_alphanumeric()) {
                continue;
            }
            let (Some(still), Some(anim)) = (gif.still(), gif.best_rendition(state.giphy.config.max_gif_bytes)) else { continue };
            let (still, url) = (still.url.clone(), anim.url.clone());
            candidates.push(Candidate { gif, still, url });
        }
    }
    report.candidates = candidates.len();
    if candidates.is_empty() {
        return (report, 0, 0);
    }

    let classified = match classify(state, api_key, character, &candidates).await {
        Ok(c) => c,
        Err(e) => {
            report.error = Some(e);
            return (report, 0, 0);
        }
    };

    let by_id: HashMap<&str, &Candidate> = candidates.iter().map(|c| (c.gif.id.as_str(), c)).collect();
    let now = now_rfc3339();
    let mut store = state.curator.store.write().await;
    let evaluated = store.evaluated.entry(character.id.clone()).or_default();
    let mut new_entries = Vec::new();
    for judged in &classified.gifs {
        let Some(candidate) = by_id.get(judged.giphy_id.as_str()) else { continue }; // not something we sent
        if !evaluated.contains(&judged.giphy_id) {
            evaluated.push(judged.giphy_id.clone());
        }
        let cats: Vec<u8> = {
            let mut v: Vec<u8> = judged
                .categories
                .iter()
                .filter_map(|name| CATEGORY_QUERIES.iter().find(|(_, n, _)| n == name).map(|(id, _, _)| *id))
                .collect();
            v.sort_unstable();
            v.dedup();
            v.truncate(3);
            v
        };
        if !judged.is_character || judged.confidence < cfg.min_confidence || cats.is_empty() {
            report.rejected += 1;
            continue;
        }
        new_entries.push(ManifestEntry {
            giphy_id: judged.giphy_id.clone(),
            character_id: character.id.clone(),
            character_name: character.name.clone(),
            anime: character.anime.clone(),
            cat: cats,
            confidence: (judged.confidence.clamp(0.0, 1.0) * 100.0).round() / 100.0,
            reason: judged.reason.chars().take(300).collect(),
            url: candidate.url.clone(),
            still: candidate.still.clone(),
            page: candidate.gif.url.clone(),
            rating: candidate.gif.rating.as_str().to_owned(),
            added_at: now.clone(),
            model: classified.model.clone(),
        });
    }
    report.added = new_entries.len();
    store.entries.extend(new_entries);
    (report, classified.input_tokens, classified.output_tokens)
}

// ------------------------------------------------------------------ Claude

#[derive(Debug, Deserialize)]
struct Judged {
    giphy_id: String,
    is_character: bool,
    categories: Vec<String>,
    confidence: f64,
    #[serde(default)]
    reason: String,
}

#[derive(Debug, Deserialize)]
struct Judgement {
    gifs: Vec<Judged>,
}

struct Classified {
    gifs: Vec<Judged>,
    model: String,
    input_tokens: u64,
    output_tokens: u64,
}

pub fn system_prompt() -> String {
    let cats: Vec<String> = CATEGORY_HINTS.iter().map(|(n, h)| format!("- {n}: {h}")).collect();
    format!(
        "You curate anime reaction GIFs for AMII, an editor plugin where an anime character reacts to a developer's work: \
celebrating passing tests, getting frustrated at failing builds, getting bored while they're idle.

You'll get one character and a numbered list of GIPHY candidates, each as a label line (giphy_id, title, uploader) followed by \
the GIF's first frame. Judge every candidate and return one result per giphy_id.

- is_character: true only if the named character is the clear main subject, from the anime itself (official animation, or \
edits and subtitled clips of it). False for cosplay, live action, AI renders, fan art in a noticeably different style, other \
characters from the same show, and anything sexual or suggestive. Titles and uploader names are often wrong, so judge mainly \
from the frame. When you can't tell, say false: a wrong character is worse than a missing GIF.
- categories: 1-3 AMII categories that fit the reaction, most fitting first (empty if is_character is false).
- confidence: 0-1, how sure you are that it's the character and the categories fit. A first frame doesn't show the whole \
GIF, so lower it when the reaction is ambiguous.
- reason: one short sentence on what the frame shows.

AMII categories:
{}",
        cats.join("\n")
    )
}

pub fn output_schema() -> Value {
    let names: Vec<&str> = CATEGORY_HINTS.iter().map(|(n, _)| *n).collect();
    json!({
        "type": "object",
        "properties": {
            "gifs": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "giphy_id": {"type": "string"},
                        "is_character": {"type": "boolean"},
                        "categories": {"type": "array", "items": {"type": "string", "enum": names}},
                        "confidence": {"type": "number"},
                        "reason": {"type": "string"}
                    },
                    "required": ["giphy_id", "is_character", "categories", "confidence", "reason"],
                    "additionalProperties": false
                }
            }
        },
        "required": ["gifs"],
        "additionalProperties": false
    })
}

pub fn request_body(cfg: &CuratorConfig, character: &Character, items: &[(String, String, String, String)]) -> Value {
    let mut content = vec![json!({
        "type": "text",
        "text": format!(
            "Character: {}\nAnime: {}\n{} candidates follow.",
            character.name, character.anime, items.len()
        )
    })];
    for (i, (id, title, user, still)) in items.iter().enumerate() {
        content.push(json!({"type": "text", "text": format!("#{} giphy_id={id} | title: \"{title}\" | uploader: {user}", i + 1)}));
        content.push(json!({"type": "image", "source": {"type": "url", "url": still}}));
    }
    json!({
        "model": cfg.model,
        "max_tokens": 16000,
        "thinking": {"type": "adaptive"},
        "output_config": {"effort": cfg.effort, "format": {"type": "json_schema", "schema": output_schema()}},
        // A policy decline is retried on a suitable fallback model instead of losing the batch.
        "fallbacks": "default",
        "system": system_prompt(),
        "messages": [{"role": "user", "content": content}]
    })
}

async fn classify(state: &AppState, api_key: &str, character: &Character, candidates: &[Candidate]) -> Result<Classified, String> {
    let cfg = &state.curator.config;
    let items: Vec<(String, String, String, String)> = candidates
        .iter()
        .map(|c| (c.gif.id.clone(), c.gif.clean_title(), if c.gif.username.is_empty() { "unknown".into() } else { c.gif.username.clone() }, c.still.clone()))
        .collect();
    let body = request_body(cfg, character, &items);
    let url = format!("{}/v1/messages", cfg.anthropic_base_url.trim_end_matches('/'));

    let mut attempt = 0;
    let response: Value = loop {
        attempt += 1;
        let res = state
            .http
            .post(&url)
            .timeout(Duration::from_secs(600))
            .header("x-api-key", api_key)
            .header("anthropic-version", ANTHROPIC_VERSION)
            .header("anthropic-beta", FALLBACK_BETA)
            .json(&body)
            .send()
            .await;
        match res {
            Ok(r) if r.status().is_success() => break r.json().await.map_err(|e| format!("Claude response: {e}"))?,
            Ok(r) => {
                let status = r.status().as_u16();
                let retry_after = r.headers().get("retry-after").and_then(|v| v.to_str().ok()).and_then(|v| v.parse::<u64>().ok());
                let text = r.text().await.unwrap_or_default();
                let retryable = status == 429 || status == 529 || status >= 500;
                if !retryable || attempt >= 3 {
                    return Err(format!("Claude API {status}: {}", text.chars().take(300).collect::<String>()));
                }
                tokio::time::sleep(Duration::from_secs(retry_after.unwrap_or(5 * attempt)).min(Duration::from_secs(60))).await;
            }
            Err(e) if attempt < 3 => {
                tracing::warn!(error = %e, "Claude request failed; retrying");
                tokio::time::sleep(Duration::from_secs(5 * attempt)).await;
            }
            Err(e) => return Err(format!("Claude request failed: {e}")),
        }
    };

    match response["stop_reason"].as_str() {
        Some("refusal") => {
            return Err(format!("declined ({})", response["stop_details"]["category"].as_str().unwrap_or("unknown")));
        }
        Some("max_tokens") => return Err("response hit max_tokens".into()),
        _ => {}
    }
    let text: String = response["content"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|b| b["type"] == "text")
        .filter_map(|b| b["text"].as_str())
        .collect();
    let judgement: Judgement = serde_json::from_str(&text).map_err(|e| format!("unexpected Claude output: {e}"))?;
    Ok(Classified {
        gifs: judgement.gifs,
        model: response["model"].as_str().unwrap_or(&cfg.model).to_owned(),
        input_tokens: response["usage"]["input_tokens"].as_u64().unwrap_or(0),
        output_tokens: response["usage"]["output_tokens"].as_u64().unwrap_or(0),
    })
}

// ------------------------------------------------------------------ routes

pub fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/admin/curator/run", post(trigger_run))
        .route("/admin/curator/status", get(status))
        .route("/admin/giphy/{id}", delete(remove_gif))
}

#[derive(Deserialize)]
struct RunQuery {
    characters: Option<String>,
}

async fn trigger_run(State(state): State<Arc<AppState>>, headers: HeaderMap, Query(q): Query<RunQuery>) -> Response {
    if let Err(code) = authorized(&state, &headers) {
        return code.into_response();
    }
    if !state.curator.enabled() || state.giphy.client.is_none() {
        return (StatusCode::SERVICE_UNAVAILABLE, "curator needs ANTHROPIC_API_KEY and GIPHY_API_KEY").into_response();
    }
    if state.curator.running.try_lock().is_err() {
        return (StatusCode::CONFLICT, "a curator run is already in progress").into_response();
    }
    let only = q.characters.map(|c| c.split(',').map(|s| s.trim().to_owned()).filter(|s| !s.is_empty()).collect());
    let bg = state.clone();
    tokio::spawn(async move {
        if let Err(e) = run(&bg, only, "manual").await {
            tracing::warn!(error = %e, "manual curator run failed");
        }
    });
    (StatusCode::ACCEPTED, Json(json!({"started": true, "status": "/admin/curator/status"}))).into_response()
}

async fn status(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    if let Err(code) = authorized(&state, &headers) {
        return code.into_response();
    }
    let c = &state.curator;
    let store = c.store.read().await;
    Json(json!({
        "enabled": c.enabled() && state.giphy.client.is_some(),
        "running": c.running.try_lock().is_err(),
        "model": c.config.model,
        "interval_hours": c.config.interval.as_secs() / 3600,
        "persisted": c.config.data_dir.is_some(),
        "curated_gifs": store.entries.len(),
        "blocked_gifs": store.blocked.len(),
        "evaluated_gifs": store.evaluated.values().map(Vec::len).sum::<usize>(),
        "last_run": *c.last_run.read().await,
    }))
    .into_response()
}

async fn remove_gif(State(state): State<Arc<AppState>>, headers: HeaderMap, Path(id): Path<String>) -> StatusCode {
    if let Err(code) = authorized(&state, &headers) {
        return code;
    }
    let id = id.strip_prefix("giphy:").unwrap_or(&id).to_owned();
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric()) {
        return StatusCode::BAD_REQUEST;
    }
    {
        let mut store = state.curator.store.write().await;
        store.entries.retain(|e| e.giphy_id != id);
        if !store.blocked.contains(&id) {
            store.blocked.push(id);
        }
    }
    state.curator.save().await;
    StatusCode::NO_CONTENT
}

// ------------------------------------------------------------------- utils

/// RFC 3339 UTC timestamp without a date-time dependency.
pub fn now_rfc3339() -> String {
    let secs = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let (days, rem) = (secs / 86_400, secs % 86_400);
    // Civil-from-days (Howard Hinnant).
    let z = days as i64 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z", rem / 3600, rem % 3600 / 60, rem % 60)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hints_match_category_ids() {
        assert_eq!(CATEGORY_HINTS.len(), CATEGORY_QUERIES.len());
        for ((_, name, _), (hint_name, _)) in CATEGORY_QUERIES.iter().zip(CATEGORY_HINTS) {
            assert_eq!(name, hint_name);
        }
    }

    #[test]
    fn timestamp_shape() {
        let t = now_rfc3339();
        assert_eq!(t.len(), 20);
        assert!(t.starts_with("20") && t.ends_with('Z'));
    }

    #[test]
    fn picks_characters_with_fewest_gifs_under_target() {
        let all: Vec<Character> = ["Aqua", "Megumin", "Rem"]
            .iter()
            .enumerate()
            .map(|(i, n)| Character { id: format!("c{i}"), name: (*n).into(), anime: "x".into() })
            .collect();
        let entry = |c: &str| ManifestEntry {
            giphy_id: "g".into(), character_id: c.into(), character_name: String::new(), anime: String::new(), cat: vec![4],
            confidence: 1.0, reason: String::new(), url: String::new(), still: String::new(), page: String::new(),
            rating: String::new(), added_at: String::new(), model: String::new(),
        };
        let mut cfg = CuratorConfig::disabled();
        cfg.characters_per_run = 2;
        cfg.target_per_character = 2;
        let baked = vec![entry("c0"), entry("c0"), entry("c2")];
        let picked = choose_characters(&all, &baked, &CuratedStore::default(), None, &cfg);
        assert_eq!(picked.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(), ["Megumin", "Rem"], "Aqua is at target");
        let named = choose_characters(&all, &baked, &CuratedStore::default(), Some(&["aqua".to_owned()]), &cfg);
        assert_eq!(named.len(), 1, "named characters ignore the target");
    }
}
