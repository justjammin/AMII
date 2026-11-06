use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::Duration;

use amii_api::cache::CacheConfig;
use amii_api::{Config, app};
use axum::body::Body;
use axum::extract::{Path, RawQuery, State};
use axum::http::{Request, StatusCode};
use axum::routing::get;
use axum::Router;
use http_body_util::BodyExt;
use tower::ServiceExt;

#[derive(Default)]
struct Upstream {
    hits: AtomicUsize,
    failing: AtomicBool,
    last_query: std::sync::Mutex<Option<String>>,
}

async fn start_upstream() -> (String, Arc<Upstream>) {
    let upstream = Arc::new(Upstream::default());
    let router = Router::new()
        .route(
            "/public/assets/{category}",
            get(|State(u): State<Arc<Upstream>>, Path(cat): Path<String>, RawQuery(q): RawQuery| async move {
                u.hits.fetch_add(1, Ordering::SeqCst);
                *u.last_query.lock().unwrap() = q;
                if u.failing.load(Ordering::SeqCst) {
                    return (StatusCode::SERVICE_UNAVAILABLE, String::new());
                }
                tokio::time::sleep(Duration::from_millis(30)).await;
                (StatusCode::OK, format!(r#"[{{"id":"1","name":"{cat}"}}]"#))
            }),
        )
        .route(
            "/visuals/{*path}",
            get(|State(u): State<Arc<Upstream>>| async move {
                u.hits.fetch_add(1, Ordering::SeqCst);
                ([("content-type", "image/gif")], "GIF89a")
            }),
        )
        .with_state(upstream.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    (format!("http://{addr}"), upstream)
}

pub fn config(base: &str, fresh: Duration) -> Config {
    let cache = CacheConfig { fresh_ttl: fresh, stale_ttl: Duration::from_secs(3600), max_bytes: 1 << 20 };
    Config {
        upstream_api_url: format!("{base}/public/"),
        upstream_asset_url: base.to_owned(),
        query_cache: cache,
        media_cache: cache,
        changed_since_bucket_secs: 3600,
        upstream_timeout: Duration::from_secs(5),
        admin_token: Some("s3cret".into()),
        media_redirect_url: None,
        giphy: amii_api::giphy_routes::GiphyConfig {
            api_key: None,
            base_url: giphy::DEFAULT_BASE_URL.into(),
            max_rating: giphy::Rating::Pg13,
            query_prefix: "anime".into(),
            hourly_budget: 90,
            per_category: 25,
            max_gif_bytes: 4 << 20,
            manifest: None,
        },
        giphy_cache: cache,
    }
}

async fn send(app: &Router, req: Request<Body>) -> (StatusCode, axum::http::HeaderMap, String) {
    let res = app.clone().oneshot(req).await.unwrap();
    let status = res.status();
    let headers = res.headers().clone();
    let body = res.into_body().collect().await.unwrap().to_bytes();
    (status, headers, String::from_utf8_lossy(&body).into_owned())
}

fn get_req(uri: &str) -> Request<Body> {
    Request::get(uri).body(Body::empty()).unwrap()
}

#[tokio::test]
async fn caches_definition_queries() {
    let (base, upstream) = start_upstream().await;
    let app = app(config(&base, Duration::from_secs(60)));

    let (status, headers, body) = send(&app, get_req("/public/assets/anime")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(headers["x-cache"], "MISS");
    assert_eq!(body, r#"[{"id":"1","name":"anime"}]"#);

    let (_, headers, _) = send(&app, get_req("/public/assets/anime")).await;
    assert_eq!(headers["x-cache"], "HIT");
    assert_eq!(upstream.hits.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn coalesces_concurrent_misses() {
    let (base, upstream) = start_upstream().await;
    let app = app(config(&base, Duration::from_secs(60)));
    let tasks: Vec<_> = (0..25)
        .map(|_| {
            let app = app.clone();
            tokio::spawn(async move { send(&app, get_req("/public/assets/visuals")).await.0 })
        })
        .collect();
    for t in tasks {
        assert_eq!(t.await.unwrap(), StatusCode::OK);
    }
    assert_eq!(upstream.hits.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn buckets_changed_since_so_clients_share_entries() {
    let (base, upstream) = start_upstream().await;
    let app = app(config(&base, Duration::from_secs(60)));
    send(&app, get_req("/public/assets/characters?changedSince=1700000100")).await;
    let (_, headers, _) = send(&app, get_req("/public/assets/characters?changedSince=1700002000")).await;
    assert_eq!(headers["x-cache"], "HIT");
    assert_eq!(upstream.hits.load(Ordering::SeqCst), 1);
    assert_eq!(upstream.last_query.lock().unwrap().as_deref(), Some("changedSince=1699999200"));
}

#[tokio::test]
async fn serves_stale_when_upstream_fails() {
    let (base, upstream) = start_upstream().await;
    let app = app(config(&base, Duration::ZERO));
    send(&app, get_req("/public/assets/audible")).await;
    upstream.failing.store(true, Ordering::SeqCst);

    let (status, headers, body) = send(&app, get_req("/public/assets/audible")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(headers["x-cache"], "STALE");
    assert!(body.contains("audible"));

    let (status, _, _) = send(&app, get_req("/public/assets/anime")).await;
    assert_eq!(status, StatusCode::BAD_GATEWAY, "nothing cached to fall back on");
}

#[tokio::test]
async fn supports_conditional_requests() {
    let (base, _) = start_upstream().await;
    let app = app(config(&base, Duration::from_secs(60)));
    let (_, headers, _) = send(&app, get_req("/public/assets/anime")).await;
    let etag = headers["etag"].to_str().unwrap().to_owned();
    let req = Request::get("/public/assets/anime").header("if-none-match", &etag).body(Body::empty()).unwrap();
    let (status, _, body) = send(&app, req).await;
    assert_eq!(status, StatusCode::NOT_MODIFIED);
    assert!(body.is_empty());
}

#[tokio::test]
async fn proxies_and_caches_media_only_within_allowed_paths() {
    let (base, upstream) = start_upstream().await;
    let app = app(config(&base, Duration::from_secs(60)));
    let (status, headers, body) = send(&app, get_req("/media/visuals/happy/aqua.gif")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(headers["content-type"], "image/gif");
    assert_eq!(body, "GIF89a");
    send(&app, get_req("/media/visuals/happy/aqua.gif")).await;
    assert_eq!(upstream.hits.load(Ordering::SeqCst), 1);

    assert_eq!(send(&app, get_req("/media/visuals/..%2F..%2Fetc")).await.0, StatusCode::NOT_FOUND);
    assert_eq!(send(&app, get_req("/media/secrets/x")).await.0, StatusCode::NOT_FOUND);
    assert_eq!(send(&app, get_req("/public/assets/users")).await.0, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn purge_requires_admin_token() {
    let (base, upstream) = start_upstream().await;
    let app = app(config(&base, Duration::from_secs(60)));
    send(&app, get_req("/public/assets/anime")).await;

    let unauthorized = Request::post("/cache/purge").body(Body::empty()).unwrap();
    assert_eq!(send(&app, unauthorized).await.0, StatusCode::UNAUTHORIZED);

    let authorized = Request::post("/cache/purge").header("authorization", "Bearer s3cret").body(Body::empty()).unwrap();
    assert_eq!(send(&app, authorized).await.0, StatusCode::NO_CONTENT);

    let (_, headers, _) = send(&app, get_req("/public/assets/anime")).await;
    assert_eq!(headers["x-cache"], "MISS");
    assert_eq!(upstream.hits.load(Ordering::SeqCst), 2);

    let (status, _, stats) = send(&app, get_req("/cache/stats")).await;
    assert_eq!(status, StatusCode::OK);
    assert!(stats.contains("\"misses\":2"), "{stats}");
}

#[tokio::test]
async fn redirects_media_to_cdn_when_configured() {
    let (base, upstream) = start_upstream().await;
    let mut cfg = config(&base, Duration::from_secs(60));
    cfg.media_redirect_url = Some("https://cdn.example.com/".into());
    let app = app(cfg);
    let (status, headers, _) = send(&app, get_req("/media/visuals/happy/aqua.gif")).await;
    assert_eq!(status, StatusCode::PERMANENT_REDIRECT);
    assert_eq!(headers["location"], "https://cdn.example.com/visuals/happy/aqua.gif");
    assert_eq!(send(&app, get_req("/media/visuals/../x.gif")).await.0, StatusCode::NOT_FOUND);
    assert_eq!(upstream.hits.load(Ordering::SeqCst), 0);
}
