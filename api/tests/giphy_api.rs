use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use amii_api::cache::CacheConfig;
use amii_api::giphy_routes::{CATEGORY_QUERIES, GiphyConfig};
use amii_api::{Config, app};
use axum::Router;
use axum::body::Body;
use axum::extract::{RawQuery, State};
use axum::http::{Request, StatusCode};
use axum::routing::get;
use http_body_util::BodyExt;
use tower::ServiceExt;

#[derive(Default)]
struct Mock {
    hits: AtomicUsize,
    queries: std::sync::Mutex<Vec<String>>,
}

async fn start_giphy() -> (String, Arc<Mock>) {
    let mock = Arc::new(Mock::default());
    let router = Router::new()
        .route(
            "/v1/gifs/search",
            get(|State(m): State<Arc<Mock>>, RawQuery(q): RawQuery| async move {
                let n = m.hits.fetch_add(1, Ordering::SeqCst);
                m.queries.lock().unwrap().push(q.unwrap_or_default());
                // Two results per search; "shared" appears in every category to test merging.
                format!(
                    r#"{{"data":[
                      {{"id":"shared","title":"Shared GIF by someone","url":"https://giphy.com/gifs/shared","rating":"g",
                        "images":{{"original":{{"url":"https://media.giphy.com/media/shared/giphy.gif","size":"1000"}}}}}},
                      {{"id":"u{n}","title":"Unique {n} GIF","url":"https://giphy.com/gifs/u{n}","rating":"r",
                        "images":{{"original":{{"url":"https://media.giphy.com/media/u{n}/giphy.gif","size":"999999999"}},
                                   "downsized":{{"url":"https://media.giphy.com/media/u{n}/small.gif","size":"2000"}}}}}}
                    ],"pagination":{{"total_count":2,"count":2,"offset":0}}}}"#
                )
            }),
        )
        .route(
            "/v1/gifs/trending",
            get(|State(m): State<Arc<Mock>>| async move {
                m.hits.fetch_add(1, Ordering::SeqCst);
                r#"{"data":[]}"#
            }),
        )
        .with_state(mock.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    (format!("http://{addr}/v1/"), mock)
}

fn config(giphy_base: &str, key: Option<&str>, budget: u32, fresh: Duration) -> Config {
    let cache = CacheConfig { fresh_ttl: fresh, stale_ttl: Duration::from_secs(3600), max_bytes: 1 << 20 };
    Config {
        upstream_api_url: "http://127.0.0.1:9/public/".into(),
        upstream_asset_url: "http://127.0.0.1:9".into(),
        query_cache: cache,
        media_cache: cache,
        changed_since_bucket_secs: 3600,
        upstream_timeout: Duration::from_secs(5),
        admin_token: None,
        media_redirect_url: None,
        giphy: GiphyConfig {
            api_key: key.map(Into::into),
            base_url: giphy_base.into(),
            max_rating: giphy::Rating::Pg13,
            query_prefix: "anime".into(),
            hourly_budget: budget,
            per_category: 25,
            max_gif_bytes: 4 << 20,
            manifest: None,
            live_search: true,
        },
        giphy_cache: cache,
        curator: amii_api::curator::CuratorConfig::disabled(),
    }
}

async fn get_json(app: &Router, uri: &str) -> (StatusCode, String, serde_json::Value) {
    let res = app.clone().oneshot(Request::get(uri).body(Body::empty()).unwrap()).await.unwrap();
    let status = res.status();
    let cache = res.headers().get("x-cache").map(|v| v.to_str().unwrap().to_owned()).unwrap_or_default();
    let bytes = res.into_body().collect().await.unwrap().to_bytes();
    let json = serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::String(String::from_utf8_lossy(&bytes).into()));
    (status, cache, json)
}

#[tokio::test]
async fn visuals_fan_out_merge_and_cache() {
    let (base, mock) = start_giphy().await;
    let app = app(config(&base, Some("k3y"), 90, Duration::from_secs(600)));

    let (status, cache, body) = get_json(&app, "/public/giphy/visuals").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(cache, "MISS");
    assert_eq!(mock.hits.load(Ordering::SeqCst), CATEGORY_QUERIES.len());

    let items = body.as_array().unwrap();
    let shared = items.iter().find(|v| v["id"] == "giphy:shared").unwrap();
    assert_eq!(shared["cat"].as_array().unwrap().len(), CATEGORY_QUERIES.len(), "merged across categories");
    assert_eq!(shared["alt"], "Shared");
    assert_eq!(shared["source"], "giphy");
    let unique = items.iter().find(|v| v["id"] != "giphy:shared").unwrap();
    assert_eq!(unique["lewd"], true, "rating r is flagged");
    assert!(unique["url"].as_str().unwrap().ends_with("small.gif"), "oversized original skipped");

    let (_, cache, _) = get_json(&app, "/public/giphy/visuals?categories=smug,4").await;
    assert_eq!(cache, "HIT");
    assert_eq!(mock.hits.load(Ordering::SeqCst), CATEGORY_QUERIES.len(), "no new upstream calls");

    let queries = mock.queries.lock().unwrap();
    assert!(queries.iter().all(|q| q.contains("api_key=k3y") && q.contains("rating=pg-13")));
    assert!(queries.iter().any(|q| q.contains("q=anime+smug") || q.contains("q=anime%20smug")));
    assert!(!body.to_string().contains("k3y"), "key never leaks to clients");
}

#[tokio::test]
async fn search_caps_rating_and_normalizes_cache_key() {
    let (base, mock) = start_giphy().await;
    let app = app(config(&base, Some("k"), 90, Duration::from_secs(600)));

    let (status, _, body) = get_json(&app, "/giphy/search?q=Anime%20%20Smug&rating=r&limit=500").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["data"].as_array().unwrap().len(), 2);
    let (_, cache, _) = get_json(&app, "/giphy/search?q=anime+smug&rating=pg-13&limit=50").await;
    assert_eq!(cache, "HIT");

    let q = mock.queries.lock().unwrap()[0].clone();
    assert!(q.contains("rating=pg-13") && q.contains("limit=50"), "{q}");
    assert_eq!(get_json(&app, "/giphy/search?q=").await.0, StatusCode::BAD_REQUEST);
    assert_eq!(get_json(&app, "/giphy/gifs/..%2Fsecret").await.0, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn budget_protects_the_key() {
    let (base, mock) = start_giphy().await;
    let app = app(config(&base, Some("k"), 2, Duration::ZERO));

    assert_eq!(get_json(&app, "/giphy/search?q=a").await.0, StatusCode::OK);
    assert_eq!(get_json(&app, "/giphy/search?q=b").await.0, StatusCode::OK);
    // Over budget, but a cached copy exists: serve it stale rather than fail.
    let (status, cache, _) = get_json(&app, "/giphy/search?q=a").await;
    assert_eq!((status, cache.as_str()), (StatusCode::OK, "STALE"));
    // Over budget and nothing cached.
    assert_eq!(get_json(&app, "/giphy/search?q=c").await.0, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(mock.hits.load(Ordering::SeqCst), 2);

    let (_, _, stats) = get_json(&app, "/cache/stats").await;
    assert_eq!(stats["giphy"]["budget_remaining_this_hour"], 0);
}

#[tokio::test]
async fn unconfigured_giphy_is_503() {
    let (base, _) = start_giphy().await;
    let app = app(config(&base, None, 90, Duration::from_secs(60)));
    assert_eq!(get_json(&app, "/public/giphy/visuals").await.0, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(get_json(&app, "/giphy/trending").await.0, StatusCode::SERVICE_UNAVAILABLE);
}

fn write_manifest(dir: &std::path::Path) -> String {
    let path = dir.join("giphy-characters.json");
    std::fs::write(
        &path,
        r#"{"version":1,"updatedAt":"2026-11-06T00:00:00Z","entries":[
          {"giphyId":"shared","characterId":"c1","characterName":"Aqua","anime":"KonoSuba","cat":[5],"confidence":0.9,
           "reason":"Aqua smirking","url":"https://media.giphy.com/media/shared/giphy.gif","page":"https://giphy.com/gifs/shared","rating":"g"},
          {"giphyId":"aquacry","characterId":"c1","characterName":"Aqua","anime":"KonoSuba","cat":[12,13],"confidence":0.8,
           "reason":"Aqua crying","url":"https://media.giphy.com/media/aquacry/giphy.gif","page":"https://giphy.com/gifs/aquacry","rating":"pg"},
          {"giphyId":"evil","characterId":"c1","characterName":"Aqua","anime":"KonoSuba","cat":[4],"confidence":0.9,
           "reason":"x","url":"https://evil.example/x.gif","page":"","rating":"g"},
          {"giphyId":"spicy","characterId":"c1","characterName":"Aqua","anime":"KonoSuba","cat":[4],"confidence":0.9,
           "reason":"x","url":"https://media.giphy.com/media/spicy/giphy.gif","page":"","rating":"r"}
        ]}"#,
    )
    .unwrap();
    path.to_string_lossy().into_owned()
}

#[tokio::test]
async fn curated_manifest_is_served_with_character_ids() {
    let dir = std::env::temp_dir().join(format!("amii-manifest-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let (base, mock) = start_giphy().await;

    // No GIPHY key: the manifest alone is served, no GIPHY calls.
    let mut cfg = config(&base, None, 90, Duration::from_secs(600));
    cfg.giphy.manifest = Some(write_manifest(&dir));
    let app_no_key = app(cfg);
    let (status, _, body) = get_json(&app_no_key, "/public/giphy/visuals").await;
    assert_eq!(status, StatusCode::OK);
    let ids: Vec<&str> = body.as_array().unwrap().iter().map(|v| v["id"].as_str().unwrap()).collect();
    assert_eq!(ids, ["giphy:aquacry", "giphy:shared"], "non-GIPHY url and over-cap rating dropped");
    assert_eq!(body[0]["char"], serde_json::json!(["c1"]));
    assert_eq!(mock.hits.load(Ordering::SeqCst), 0);

    // Category filter applies to manifest entries too.
    let (_, _, smug) = get_json(&app_no_key, "/public/giphy/visuals?categories=smug").await;
    assert_eq!(smug.as_array().unwrap().len(), 1);

    // With a key: live search results and manifest merge; the shared GIF gains the character.
    let mut cfg = config(&base, Some("k"), 90, Duration::from_secs(600));
    cfg.giphy.manifest = Some(write_manifest(&dir));
    let (_, _, merged) = get_json(&app(cfg), "/public/giphy/visuals").await;
    let shared = merged.as_array().unwrap().iter().find(|v| v["id"] == "giphy:shared").unwrap();
    assert_eq!(shared["char"], serde_json::json!(["c1"]));
    assert_eq!(shared["cat"].as_array().unwrap().len(), CATEGORY_QUERIES.len());
}
