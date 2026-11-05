//! AMII API: a caching front for the AMII asset-definition API and media CDN.
//!
//! Routes (compatible with what the VS Code extension and the IntelliJ plugin expect):
//!
//! * `GET  /public/assets/{category}[?changedSince=<epoch secs>]` — asset definitions (JSON)
//! * `GET  /media/{visuals|audible}/{path}`                      — meme images / audio
//! * `GET  /healthz`
//! * `GET  /cache/stats`
//! * `POST /cache/purge` (requires `Authorization: Bearer $ADMIN_TOKEN`)

pub mod cache;

use std::sync::Arc;
use std::time::Duration;

use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use bytes::Bytes;
use serde::Deserialize;

use cache::{CacheConfig, CacheStatus, CachedResponse, ResponseCache};

pub const DEFINITION_CATEGORIES: &[&str] = &["visuals", "audible", "anime", "characters"];
pub const MEDIA_CATEGORIES: &[&str] = &["visuals", "audible"];

#[derive(Debug, Clone)]
pub struct Config {
    pub upstream_api_url: String,
    pub upstream_asset_url: String,
    pub query_cache: CacheConfig,
    pub media_cache: CacheConfig,
    /// `changedSince` is rounded down to this many seconds so clients share cache entries.
    /// Safe because a delta from an earlier time is a superset that clients merge idempotently.
    pub changed_since_bucket_secs: u64,
    pub upstream_timeout: Duration,
    pub admin_token: Option<String>,
}

impl Config {
    pub fn from_env() -> Self {
        fn var<T: std::str::FromStr>(name: &str, default: T) -> T {
            std::env::var(name).ok().and_then(|v| v.parse().ok()).unwrap_or(default)
        }
        let mb = 1024 * 1024;
        Self {
            upstream_api_url: var("UPSTREAM_API_URL", "https://amii.api.unthrottled.io/public/".to_owned()),
            upstream_asset_url: var("UPSTREAM_ASSET_URL", "https://amii.assets.unthrottled.io".to_owned()),
            query_cache: CacheConfig {
                fresh_ttl: Duration::from_secs(var("QUERY_TTL_SECS", 300)),
                stale_ttl: Duration::from_secs(var("STALE_TTL_SECS", 86_400)),
                max_bytes: var("QUERY_CACHE_MB", 64u64) * mb,
            },
            media_cache: CacheConfig {
                fresh_ttl: Duration::from_secs(var("MEDIA_TTL_SECS", 604_800)),
                stale_ttl: Duration::from_secs(var("MEDIA_STALE_TTL_SECS", 2_592_000)),
                max_bytes: var("MEDIA_CACHE_MB", 512u64) * mb,
            },
            changed_since_bucket_secs: var("CHANGED_SINCE_BUCKET_SECS", 3_600u64).max(1),
            upstream_timeout: Duration::from_secs(var("UPSTREAM_TIMEOUT_SECS", 15)),
            admin_token: std::env::var("ADMIN_TOKEN").ok().filter(|t| !t.is_empty()),
        }
    }
}

pub struct AppState {
    config: Config,
    http: reqwest::Client,
    queries: ResponseCache,
    media: ResponseCache,
}

pub fn app(config: Config) -> Router {
    let http = reqwest::Client::builder()
        .timeout(config.upstream_timeout)
        .user_agent(concat!("amii-api/", env!("CARGO_PKG_VERSION")))
        .build()
        .expect("http client");
    let state = Arc::new(AppState {
        queries: ResponseCache::new(config.query_cache),
        media: ResponseCache::new(config.media_cache),
        config,
        http,
    });

    Router::new()
        .route("/public/assets/{category}", get(definitions))
        .route("/media/{*path}", get(media))
        .route("/healthz", get(|| async { "ok" }))
        .route("/cache/stats", get(stats))
        .route("/cache/purge", post(purge))
        .with_state(state)
}

#[derive(Debug)]
enum UpstreamError {
    Status(StatusCode),
    Transport(String),
}

impl IntoResponse for UpstreamError {
    fn into_response(self) -> Response {
        match self {
            // 404s are the client's problem; everything else is a gateway failure.
            UpstreamError::Status(StatusCode::NOT_FOUND) => StatusCode::NOT_FOUND.into_response(),
            UpstreamError::Status(code) => {
                (StatusCode::BAD_GATEWAY, format!("upstream responded {code}")).into_response()
            }
            UpstreamError::Transport(msg) => (StatusCode::BAD_GATEWAY, msg).into_response(),
        }
    }
}

async fn fetch_upstream(http: &reqwest::Client, url: &str, default_type: &str) -> Result<CachedResponse, UpstreamError> {
    tracing::debug!(%url, "upstream fetch");
    let res = http.get(url).send().await.map_err(|e| UpstreamError::Transport(e.to_string()))?;
    let status = res.status();
    if !status.is_success() {
        return Err(UpstreamError::Status(
            StatusCode::from_u16(status.as_u16()).unwrap_or(StatusCode::BAD_GATEWAY),
        ));
    }
    let content_type = res
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or(default_type)
        .to_owned();
    let body: Bytes = res.bytes().await.map_err(|e| UpstreamError::Transport(e.to_string()))?;
    Ok(CachedResponse::new(body, content_type))
}

fn respond(request: &HeaderMap, entry: &CachedResponse, status: CacheStatus, max_age: Duration) -> Response {
    let mut headers = HeaderMap::new();
    let set = |headers: &mut HeaderMap, name, value: &str| {
        if let Ok(v) = HeaderValue::from_str(value) {
            headers.insert(name, v);
        }
    };
    set(&mut headers, header::ETAG, &entry.etag);
    set(&mut headers, header::CACHE_CONTROL, &format!("public, max-age={}", max_age.as_secs()));
    set(&mut headers, header::HeaderName::from_static("x-cache"), status.as_str());

    let not_modified = request
        .get(header::IF_NONE_MATCH)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|tags| tags.split(',').any(|t| t.trim() == entry.etag || t.trim() == "*"));
    if not_modified {
        return (StatusCode::NOT_MODIFIED, headers).into_response();
    }
    set(&mut headers, header::CONTENT_TYPE, &entry.content_type);
    (StatusCode::OK, headers, entry.body.clone()).into_response()
}

#[derive(Deserialize)]
struct DefinitionQuery {
    #[serde(rename = "changedSince")]
    changed_since: Option<u64>,
}

async fn definitions(
    State(state): State<Arc<AppState>>,
    Path(category): Path<String>,
    Query(query): Query<DefinitionQuery>,
    headers: HeaderMap,
) -> Result<Response, UpstreamError> {
    if !DEFINITION_CATEGORIES.contains(&category.as_str()) {
        return Ok(StatusCode::NOT_FOUND.into_response());
    }
    let bucket = state.config.changed_since_bucket_secs;
    let suffix = query
        .changed_since
        .map(|t| format!("?changedSince={}", t - t % bucket))
        .unwrap_or_default();
    let key = format!("assets/{category}{suffix}");
    let base = state.config.upstream_api_url.trim_end_matches('/');
    let url = format!("{base}/{key}");

    let (entry, status) = state
        .queries
        .get_or_fetch(&key, || fetch_upstream(&state.http, &url, "application/json"))
        .await?;
    Ok(respond(&headers, &entry, status, state.queries.fresh_ttl()))
}

fn valid_media_path(path: &str) -> bool {
    let mut segments = path.split('/');
    let Some(category) = segments.next() else { return false };
    let rest: Vec<&str> = segments.collect();
    MEDIA_CATEGORIES.contains(&category)
        && !rest.is_empty()
        && rest.iter().all(|s| {
            !s.is_empty()
                && *s != "."
                && *s != ".."
                && s.chars().all(|c| c.is_ascii_alphanumeric() || "-_.~%()!".contains(c))
        })
}

async fn media(
    State(state): State<Arc<AppState>>,
    Path(path): Path<String>,
    headers: HeaderMap,
) -> Result<Response, UpstreamError> {
    if !valid_media_path(&path) {
        return Ok(StatusCode::NOT_FOUND.into_response());
    }
    let base = state.config.upstream_asset_url.trim_end_matches('/');
    let url = format!("{base}/{path}");
    let (entry, status) = state
        .media
        .get_or_fetch(&path, || fetch_upstream(&state.http, &url, "application/octet-stream"))
        .await?;
    Ok(respond(&headers, &entry, status, state.media.fresh_ttl()))
}

async fn stats(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    Json(serde_json::json!({
        "queries": state.queries.stats().await,
        "media": state.media.stats().await,
    }))
}

async fn purge(State(state): State<Arc<AppState>>, headers: HeaderMap) -> StatusCode {
    let Some(token) = &state.config.admin_token else { return StatusCode::NOT_FOUND };
    let presented = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "));
    if presented.is_none_or(|p| !constant_time_eq(p.as_bytes(), token.as_bytes())) {
        return StatusCode::UNAUTHORIZED;
    }
    state.queries.purge().await;
    state.media.purge().await;
    StatusCode::NO_CONTENT
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

#[cfg(test)]
mod tests {
    use super::valid_media_path;

    #[test]
    fn media_paths_are_confined() {
        assert!(valid_media_path("visuals/mocking/aqua_mocking_laugh.gif"));
        assert!(valid_media_path("audible/aqua.mp3"));
        assert!(!valid_media_path("visuals/../secret"));
        assert!(!valid_media_path("visuals//x.gif"));
        assert!(!valid_media_path("admin/x.gif"));
        assert!(!valid_media_path("visuals"));
        assert!(!valid_media_path("visuals/a?b=c"));
    }
}
