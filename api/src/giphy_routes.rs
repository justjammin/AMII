//! GIPHY-backed routes. The API key lives only on the server; every GIPHY call goes through
//! the response cache and an hourly budget so a public deployment can't burn the key's quota.
//!
//! * `GET /giphy/search?q=&limit=&offset=&rating=` — GIPHY search, rating capped at `GIPHY_MAX_RATING`
//! * `GET /giphy/trending?limit=&offset=`
//! * `GET /giphy/gifs/{id}`
//! * `GET /public/giphy/visuals[?categories=celebration,smug]` — AMII-shaped meme definitions,
//!   one GIPHY search per meme category, consumed by the editor plugins.

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use bytes::Bytes;
use giphy::{Rating, SearchParams, TrendingParams};
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

use crate::cache::{CacheStatus, CachedResponse};
use crate::{AppState, respond};

/// AMII meme categories (ids match the `cat` field of `/public/assets/visuals`) and the
/// GIPHY search used to fill them. The configured prefix (default "anime") is prepended.
pub const CATEGORY_QUERIES: &[(u8, &str, &str)] = &[
    (0, "acknowledgement", "nod okay"),
    (1, "frustration", "frustrated"),
    (2, "enraged", "angry rage"),
    (3, "celebration", "celebration"),
    (4, "happy", "happy"),
    (5, "smug", "smug"),
    (6, "waiting", "waiting"),
    (7, "motivation", "you can do it"),
    (8, "welcoming", "hello wave"),
    (9, "departure", "bye wave"),
    (10, "encouragement", "cheering"),
    (11, "mocking", "laughing at you"),
    (12, "shocked", "shocked"),
    (13, "disappointment", "disappointed"),
    (14, "alert", "alert surprised"),
    (15, "bored", "bored"),
    (16, "tired", "tired sleepy"),
    (17, "patiently_waiting", "tapping waiting"),
    (18, "pouting", "pout"),
];

#[derive(Debug, Clone)]
pub struct GiphyConfig {
    pub api_key: Option<String>,
    pub base_url: String,
    /// Highest rating ever requested from GIPHY, whatever the client asks for.
    pub max_rating: Rating,
    pub query_prefix: String,
    /// Max GIPHY calls per rolling hour (beta keys allow ~100).
    pub hourly_budget: u32,
    pub per_category: u32,
    /// Largest rendition handed to editors.
    pub max_gif_bytes: u32,
    /// Curated per-character manifest (file path or https URL), produced by `agent/` and reviewed
    /// in a PR. Its entries are merged into `/public/giphy/visuals` with character ids.
    pub manifest: Option<String>,
}

impl GiphyConfig {
    pub fn from_env() -> Self {
        fn var<T: std::str::FromStr>(name: &str, default: T) -> T {
            std::env::var(name).ok().and_then(|v| v.parse().ok()).unwrap_or(default)
        }
        Self {
            api_key: std::env::var("GIPHY_API_KEY").ok().filter(|k| !k.is_empty()),
            base_url: var("GIPHY_BASE_URL", giphy::DEFAULT_BASE_URL.to_owned()),
            max_rating: var("GIPHY_MAX_RATING", Rating::Pg13),
            query_prefix: var("GIPHY_QUERY_PREFIX", "anime".to_owned()),
            hourly_budget: var("GIPHY_HOURLY_BUDGET", 90),
            per_category: var("GIPHY_PER_CATEGORY", 25u32).clamp(1, giphy::MAX_LIMIT),
            max_gif_bytes: var("GIPHY_MAX_GIF_MB", 4u32) * 1024 * 1024,
            manifest: std::env::var("GIPHY_MANIFEST").ok().filter(|m| !m.is_empty()),
        }
    }
}

/// Fixed-window counter: at most `limit` upstream calls per hour.
pub struct Budget {
    limit: u32,
    window: Mutex<(Instant, u32)>,
}

impl Budget {
    pub fn new(limit: u32) -> Self {
        Self { limit, window: Mutex::new((Instant::now(), 0)) }
    }

    async fn try_take(&self) -> bool {
        let mut w = self.window.lock().await;
        if w.0.elapsed() >= Duration::from_secs(3600) {
            *w = (Instant::now(), 0);
        }
        if w.1 >= self.limit {
            return false;
        }
        w.1 += 1;
        true
    }

    pub async fn remaining(&self) -> u32 {
        let w = self.window.lock().await;
        if w.0.elapsed() >= Duration::from_secs(3600) { self.limit } else { self.limit.saturating_sub(w.1) }
    }
}

pub struct Giphy {
    pub client: Option<giphy::Client>,
    pub config: GiphyConfig,
    pub budget: Budget,
}

impl Giphy {
    pub fn new(config: GiphyConfig, http: reqwest::Client) -> Self {
        let client = config
            .api_key
            .as_ref()
            .map(|key| giphy::Client::with_http(http, key.clone()).base_url(config.base_url.clone()));
        Self { client, budget: Budget::new(config.hourly_budget), config }
    }
}

#[derive(Debug)]
pub enum GiphyError {
    NotConfigured,
    OverBudget,
    Upstream(giphy::Error),
    Encode(String),
}

impl IntoResponse for GiphyError {
    fn into_response(self) -> Response {
        let (status, msg) = match self {
            GiphyError::NotConfigured => (StatusCode::SERVICE_UNAVAILABLE, "GIPHY is not configured (set GIPHY_API_KEY)".to_owned()),
            GiphyError::OverBudget | GiphyError::Upstream(giphy::Error::RateLimited) => {
                (StatusCode::TOO_MANY_REQUESTS, "GIPHY budget exhausted, try again later".to_owned())
            }
            GiphyError::Upstream(giphy::Error::NotFound) => (StatusCode::NOT_FOUND, "not found".to_owned()),
            GiphyError::Upstream(giphy::Error::Unauthorized(_)) => {
                tracing::error!("GIPHY rejected the configured API key");
                (StatusCode::BAD_GATEWAY, "GIPHY rejected the server's API key".to_owned())
            }
            GiphyError::Upstream(e) => (StatusCode::BAD_GATEWAY, e.to_string()),
            GiphyError::Encode(e) => (StatusCode::INTERNAL_SERVER_ERROR, e),
        };
        let mut res = (status, msg).into_response();
        if status == StatusCode::TOO_MANY_REQUESTS {
            res.headers_mut().insert("retry-after", "600".parse().unwrap());
        }
        res
    }
}

pub fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/giphy/search", get(search))
        .route("/giphy/trending", get(trending))
        .route("/giphy/gifs/{id}", get(gif))
        .route("/public/giphy/visuals", get(visuals))
}

/// Runs a GIPHY call through the cache + budget and returns its JSON.
async fn cached_json<T, F, Fut>(state: &AppState, key: &str, call: F) -> Result<(Arc<CachedResponse>, CacheStatus), GiphyError>
where
    T: Serialize,
    F: FnOnce(giphy::Client) -> Fut,
    Fut: Future<Output = Result<T, giphy::Error>>,
{
    let client = state.giphy.client.clone().ok_or(GiphyError::NotConfigured)?;
    state
        .giphy_cache
        .get_or_fetch(key, || async {
            if !state.giphy.budget.try_take().await {
                return Err(GiphyError::OverBudget);
            }
            let value = call(client).await.map_err(GiphyError::Upstream)?;
            let body = serde_json::to_vec(&value).map_err(|e| GiphyError::Encode(e.to_string()))?;
            Ok(CachedResponse::new(Bytes::from(body), "application/json".to_owned()))
        })
        .await
}

fn capped(state: &AppState, requested: Option<&str>) -> Rating {
    let max = state.giphy.config.max_rating;
    requested.and_then(|r| r.parse::<Rating>().ok()).map_or(max, |r| r.min(max))
}

#[derive(Deserialize)]
struct SearchQuery {
    q: String,
    limit: Option<u32>,
    offset: Option<u32>,
    rating: Option<String>,
}

async fn search(State(state): State<Arc<AppState>>, Query(p): Query<SearchQuery>, headers: HeaderMap) -> Result<Response, GiphyError> {
    let q = p.q.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase();
    if q.is_empty() || q.len() > 100 {
        return Ok((StatusCode::BAD_REQUEST, "q must be 1-100 characters").into_response());
    }
    let params = SearchParams::new(q).limit(p.limit.unwrap_or(25)).offset(p.offset.unwrap_or(0)).rating(capped(&state, p.rating.as_deref()));
    let key = format!("search?q={}&limit={}&offset={}&rating={}", params.query, params.limit, params.offset, params.rating.unwrap().as_str());
    let (entry, status) = cached_json(&state, &key, |c| async move { c.search(&params).await }).await?;
    Ok(respond(&headers, &entry, status, state.giphy_cache.fresh_ttl()))
}

#[derive(Deserialize)]
struct TrendingQuery {
    limit: Option<u32>,
    offset: Option<u32>,
}

async fn trending(State(state): State<Arc<AppState>>, Query(p): Query<TrendingQuery>, headers: HeaderMap) -> Result<Response, GiphyError> {
    let params = TrendingParams {
        limit: p.limit.unwrap_or(25).clamp(1, giphy::MAX_LIMIT),
        offset: p.offset.unwrap_or(0).min(giphy::MAX_OFFSET),
        rating: Some(state.giphy.config.max_rating),
    };
    let key = format!("trending?limit={}&offset={}", params.limit, params.offset);
    let (entry, status) = cached_json(&state, &key, |c| async move { c.trending(&params).await }).await?;
    Ok(respond(&headers, &entry, status, state.giphy_cache.fresh_ttl()))
}

async fn gif(State(state): State<Arc<AppState>>, Path(id): Path<String>, headers: HeaderMap) -> Result<Response, GiphyError> {
    if id.is_empty() || id.len() > 64 || !id.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Ok(StatusCode::NOT_FOUND.into_response());
    }
    let key = format!("gif/{id}");
    let (entry, status) = cached_json(&state, &key, |c| async move { c.gif(&id).await }).await?;
    Ok(respond(&headers, &entry, status, state.giphy_cache.fresh_ttl()))
}

/// Same shape as `/public/assets/visuals`, plus `url` (direct GIF), `page` (attribution link)
/// and `source: "giphy"`.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct GiphyVisual {
    pub id: String,
    pub alt: String,
    pub cat: Vec<u8>,
    pub char: Vec<String>,
    pub lewd: bool,
    pub url: String,
    pub page: String,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub source: String,
}

#[derive(Deserialize)]
struct VisualsQuery {
    categories: Option<String>,
}

async fn visuals(State(state): State<Arc<AppState>>, Query(p): Query<VisualsQuery>, headers: HeaderMap) -> Result<Response, GiphyError> {
    if state.giphy.client.is_none() && state.giphy.config.manifest.is_none() {
        return Err(GiphyError::NotConfigured);
    }
    let wanted: Vec<_> = match p.categories.as_deref().map(str::trim).filter(|c| !c.is_empty() && *c != "all") {
        None => CATEGORY_QUERIES.iter().collect(),
        Some(list) => {
            let names: Vec<String> = list.split(',').map(|s| s.trim().to_lowercase()).collect();
            CATEGORY_QUERIES
                .iter()
                .filter(|(id, name, _)| names.iter().any(|n| n == name || n == &id.to_string()))
                .collect()
        }
    };
    if wanted.is_empty() {
        return Ok((StatusCode::BAD_REQUEST, "no known categories requested").into_response());
    }

    let mut tasks = tokio::task::JoinSet::new();
    let searchable = if state.giphy.client.is_some() { wanted.as_slice() } else { &[] };
    for &&(id, name, query) in searchable {
        let state = state.clone();
        tasks.spawn(async move { (id, category_visuals(&state, name, query).await) });
    }

    let mut merged: BTreeMap<String, GiphyVisual> = BTreeMap::new();
    let (mut any_stale, mut any_miss) = (false, false);
    let mut last_error = None;
    while let Some(joined) = tasks.join_next().await {
        let Ok((cat, result)) = joined else { continue };
        match result {
            Ok((items, status)) => {
                any_stale |= status == CacheStatus::Stale;
                any_miss |= status == CacheStatus::Miss;
                for mut v in items {
                    v.cat = vec![cat];
                    merged
                        .entry(v.id.clone())
                        .and_modify(|e| {
                            if !e.cat.contains(&cat) {
                                e.cat.push(cat);
                            }
                        })
                        .or_insert(v);
                }
            }
            // A category that fails (e.g. over budget) is just missing; the rest still serve.
            Err(e) => last_error = Some(e),
        }
    }
    let wanted_ids: Vec<u8> = wanted.iter().map(|(id, _, _)| *id).collect();
    match manifest_visuals(&state).await {
        Ok(entries) => {
            for v in entries {
                let cats: Vec<u8> = v.cat.iter().copied().filter(|c| wanted_ids.contains(c)).collect();
                if cats.is_empty() {
                    continue;
                }
                let e = merged.entry(v.id.clone()).or_insert_with(|| GiphyVisual { cat: Vec::new(), ..v.clone() });
                for c in cats {
                    if !e.cat.contains(&c) {
                        e.cat.push(c);
                    }
                }
                for ch in v.char {
                    if !e.char.contains(&ch) {
                        e.char.push(ch);
                    }
                }
            }
        }
        Err(e) => {
            tracing::warn!(error = ?e, "GIPHY manifest unavailable");
            last_error.get_or_insert(e);
        }
    }

    if merged.is_empty()
        && let Some(e) = last_error
    {
        return Err(e);
    }

    let status = match (any_stale, any_miss) {
        (true, _) => CacheStatus::Stale,
        (false, true) => CacheStatus::Miss,
        _ => CacheStatus::Hit,
    };
    let body = serde_json::to_vec(&merged.into_values().collect::<Vec<_>>()).map_err(|e| GiphyError::Encode(e.to_string()))?;
    let entry = CachedResponse::new(Bytes::from(body), "application/json".to_owned());
    Ok(respond(&headers, &entry, status, state.giphy_cache.fresh_ttl()))
}

async fn category_visuals(state: &AppState, name: &str, query: &str) -> Result<(Vec<GiphyVisual>, CacheStatus), GiphyError> {
    let cfg = &state.giphy.config;
    let full_query = format!("{} {query}", cfg.query_prefix).trim().to_owned();
    let params = SearchParams::new(full_query).limit(cfg.per_category).rating(cfg.max_rating);
    let max_bytes = cfg.max_gif_bytes;
    let key = format!("visuals/{name}?limit={}&rating={}&prefix={}", cfg.per_category, cfg.max_rating.as_str(), cfg.query_prefix);

    let (entry, status) = cached_json(state, &key, |c| async move {
        let page = c.search(&params).await?;
        Ok::<_, giphy::Error>(
            page.data
                .iter()
                .filter_map(|g| {
                    let r = g.best_rendition(max_bytes)?;
                    Some(GiphyVisual {
                        id: format!("giphy:{}", g.id),
                        alt: g.clean_title(),
                        cat: Vec::new(),
                        char: Vec::new(),
                        lewd: g.rating >= Rating::R,
                        url: r.url.clone(),
                        page: g.url.clone(),
                        width: r.width,
                        height: r.height,
                        source: "giphy".to_owned(),
                    })
                })
                .collect::<Vec<_>>(),
        )
    })
    .await?;
    let items: Vec<GiphyVisual> = serde_json::from_slice(&entry.body).map_err(|e| GiphyError::Encode(e.to_string()))?;
    Ok((items, status))
}

/// One reviewed entry of the curated manifest (`agent/` writes these; extra fields are ignored).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManifestEntry {
    giphy_id: String,
    character_id: String,
    cat: Vec<u8>,
    url: String,
    page: String,
    #[serde(default)]
    reason: String,
    #[serde(default)]
    rating: String,
}

#[derive(Debug, Deserialize)]
struct Manifest {
    entries: Vec<ManifestEntry>,
}

fn is_giphy_media(url: &str) -> bool {
    url.strip_prefix("https://")
        .and_then(|rest| rest.split('/').next())
        .is_some_and(|host| host == "giphy.com" || host.ends_with(".giphy.com"))
}

/// Loads the manifest (cached like any GIPHY response) and turns entries into visuals.
async fn manifest_visuals(state: &AppState) -> Result<Vec<GiphyVisual>, GiphyError> {
    let Some(source) = state.giphy.config.manifest.clone() else { return Ok(Vec::new()) };
    let http = state.http.clone();
    let (entry, _) = state
        .giphy_cache
        .get_or_fetch("manifest", || async move {
            let bytes = if source.starts_with("https://") || source.starts_with("http://") {
                let res = http.get(&source).send().await.map_err(|e| GiphyError::Encode(format!("manifest fetch: {e}")))?;
                if !res.status().is_success() {
                    return Err(GiphyError::Encode(format!("manifest fetch: HTTP {}", res.status())));
                }
                res.bytes().await.map_err(|e| GiphyError::Encode(e.to_string()))?
            } else {
                Bytes::from(tokio::fs::read(&source).await.map_err(|e| GiphyError::Encode(format!("manifest read {source}: {e}")))?)
            };
            Ok(CachedResponse::new(bytes, "application/json".to_owned()))
        })
        .await?;
    let manifest: Manifest = serde_json::from_slice(&entry.body).map_err(|e| GiphyError::Encode(format!("manifest parse: {e}")))?;
    let max = state.giphy.config.max_rating;
    Ok(manifest
        .entries
        .into_iter()
        .filter(|e| is_giphy_media(&e.url) && e.giphy_id.chars().all(|c| c.is_ascii_alphanumeric()))
        .filter(|e| e.rating.parse::<Rating>().map_or(true, |r| r <= max))
        .map(|e| GiphyVisual {
            id: format!("giphy:{}", e.giphy_id),
            alt: if e.reason.is_empty() { "GIPHY".to_owned() } else { e.reason },
            cat: e.cat.into_iter().filter(|c| CATEGORY_QUERIES.iter().any(|(id, _, _)| id == c)).collect(),
            char: vec![e.character_id],
            lewd: false,
            url: e.url,
            page: e.page,
            width: None,
            height: None,
            source: "giphy".to_owned(),
        })
        .collect())
}
