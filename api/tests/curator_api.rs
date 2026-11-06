use std::sync::{Arc, Mutex};
use std::time::Duration;

use amii_api::cache::CacheConfig;
use amii_api::curator::{self, CuratorConfig, CuratorState};
use amii_api::giphy_routes::GiphyConfig;
use amii_api::{Config, build};
use axum::Router;
use axum::body::Body;
use axum::extract::{Json as JsonBody, RawQuery, State};
use axum::http::{HeaderMap, Request, StatusCode};
use axum::routing::{get, post};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use tower::ServiceExt;

#[derive(Default)]
struct Mocks {
    giphy_queries: Mutex<Vec<String>>,
    claude_calls: Mutex<Vec<(HeaderMap, Value)>>,
}

fn gif(id: &str, rating: &str) -> Value {
    json!({
        "id": id, "title": format!("{id} GIF by Crunchyroll"), "username": "crunchyroll", "rating": rating,
        "url": format!("https://giphy.com/gifs/{id}"),
        "images": {
            "original": {"url": format!("https://media.giphy.com/media/{id}/giphy.gif"), "size": "1000"},
            "fixed_height_still": {"url": format!("https://media.giphy.com/media/{id}/200_s.gif")}
        }
    })
}

async fn start_mocks() -> (String, Arc<Mocks>) {
    let mocks = Arc::new(Mocks::default());
    let router = Router::new()
        // Upstream AMII definitions
        .route("/public/assets/anime", get(|| async { r#"[{"id":"a1","name":"KonoSuba"}]"# }))
        .route(
            "/public/assets/characters",
            get(|| async { r#"[{"id":"c1","animeId":"a1","name":"Aqua","gender":0},{"id":"c2","animeId":"a1","name":"Megumin","gender":0}]"# }),
        )
        // GIPHY: the same four results for every query (plus one R-rated)
        .route(
            "/v1/gifs/search",
            get(|State(m): State<Arc<Mocks>>, RawQuery(q): RawQuery| async move {
                m.giphy_queries.lock().unwrap().push(q.unwrap_or_default());
                axum::Json(json!({"data": [gif("g1", "g"), gif("g2", "g"), gif("g3", "pg"), gif("spicy", "r")]}))
            }),
        )
        // Claude Messages API
        .route(
            "/v1/messages",
            post(|State(m): State<Arc<Mocks>>, headers: HeaderMap, JsonBody(body): JsonBody<Value>| async move {
                m.claude_calls.lock().unwrap().push((headers, body));
                let judged = json!({"gifs": [
                    {"giphy_id": "g1", "is_character": true, "categories": ["smug", "happy"], "confidence": 0.93, "reason": "Aqua smirking"},
                    {"giphy_id": "g2", "is_character": false, "categories": [], "confidence": 0.9, "reason": "That's Darkness"},
                    {"giphy_id": "g3", "is_character": true, "categories": ["shocked"], "confidence": 0.4, "reason": "unclear"},
                    {"giphy_id": "invented", "is_character": true, "categories": ["happy"], "confidence": 0.99, "reason": "not sent"}
                ]});
                axum::Json(json!({
                    "id": "msg_1", "type": "message", "role": "assistant", "model": "claude-opus-5-5",
                    "stop_reason": "end_turn", "stop_sequence": null,
                    "content": [{"type": "thinking", "thinking": "", "signature": "x"}, {"type": "text", "text": judged.to_string()}],
                    "usage": {"input_tokens": 1200, "output_tokens": 300}
                }))
            }),
        )
        .with_state(mocks.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    (format!("http://{addr}"), mocks)
}

fn config(base: &str, data_dir: &std::path::Path) -> Config {
    let cache = CacheConfig { fresh_ttl: Duration::from_secs(600), stale_ttl: Duration::from_secs(3600), max_bytes: 1 << 20 };
    let mut curator = CuratorConfig::disabled();
    curator.anthropic_api_key = Some("sk-test".into());
    curator.anthropic_base_url = base.into();
    curator.data_dir = Some(data_dir.to_path_buf());
    Config {
        upstream_api_url: format!("{base}/public/"),
        upstream_asset_url: base.into(),
        query_cache: cache,
        media_cache: cache,
        changed_since_bucket_secs: 3600,
        upstream_timeout: Duration::from_secs(5),
        admin_token: Some("adm1n".into()),
        media_redirect_url: None,
        giphy: GiphyConfig {
            api_key: Some("gk".into()),
            base_url: format!("{base}/v1/"),
            max_rating: giphy::Rating::Pg13,
            query_prefix: "anime".into(),
            hourly_budget: 90,
            per_category: 25,
            max_gif_bytes: 4 << 20,
            manifest: None,
            live_search: false,
        },
        giphy_cache: cache,
        curator,
    }
}

async fn call(app: &Router, req: Request<Body>) -> (StatusCode, Value) {
    let res = app.clone().oneshot(req).await.unwrap();
    let status = res.status();
    let bytes = res.into_body().collect().await.unwrap().to_bytes();
    (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
}

#[tokio::test]
async fn curates_new_gifs_categorizes_them_and_serves_them() {
    let dir = std::env::temp_dir().join(format!("amii-curator-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let (base, mocks) = start_mocks().await;
    let (app, state) = build(config(&base, &dir));

    let report = curator::run(&state, Some(vec!["Aqua".into()]), "test").await.unwrap();
    let aqua = &report.characters[0];
    assert_eq!(aqua.character, "Aqua (KonoSuba)");
    assert_eq!((aqua.candidates, aqua.added, aqua.rejected), (3, 1, 2), "R-rated dropped before Claude; g2 not her, g3 too unsure");
    assert_eq!((report.input_tokens, report.output_tokens), (1200, 300));

    // GIPHY was searched with the character, the rating cap, and then her thinnest categories.
    let queries = mocks.giphy_queries.lock().unwrap().clone();
    assert!(queries[0].contains("q=Aqua+KonoSuba") || queries[0].contains("q=Aqua%20KonoSuba"), "{queries:?}");
    assert!(queries.iter().all(|q| q.contains("rating=pg-13") && q.contains("api_key=gk")));
    assert_eq!(queries.len(), 3);

    // One Claude call: right headers, structured output, fallbacks, and one image per candidate.
    {
        let calls = mocks.claude_calls.lock().unwrap();
        assert_eq!(calls.len(), 1);
        let (headers, body) = &calls[0];
        assert_eq!(headers["x-api-key"], "sk-test");
        assert_eq!(headers["anthropic-version"], curator::ANTHROPIC_VERSION);
        assert_eq!(headers["anthropic-beta"], curator::FALLBACK_BETA);
        assert_eq!(body["model"], "claude-opus-5-5");
        assert_eq!(body["fallbacks"], "default");
        assert_eq!(body["output_config"]["format"]["type"], "json_schema");
        assert_eq!(body["output_config"]["effort"], "medium");
        let images: Vec<&Value> = body["messages"][0]["content"].as_array().unwrap().iter().filter(|b| b["type"] == "image").collect();
        assert_eq!(images.len(), 3);
        assert_eq!(images[0]["source"]["url"], "https://media.giphy.com/media/g1/200_s.gif");
    }

    // Served immediately, tagged with the character, from the public endpoints.
    let (status, visuals) = call(&app, Request::get("/public/giphy/visuals?categories=smug").body(Body::empty()).unwrap()).await;
    assert_eq!(status, StatusCode::OK);
    let g1 = visuals.as_array().unwrap().iter().find(|v| v["id"] == "giphy:g1").expect("curated gif served");
    assert_eq!(g1["char"], json!(["c1"]));
    let (_, manifest) = call(&app, Request::get("/public/giphy/manifest").body(Body::empty()).unwrap()).await;
    assert_eq!(manifest["entries"][0]["cat"], json!([4, 5]));
    assert_eq!(manifest["entries"][0]["model"], "claude-opus-5-5");

    // Second run: everything was already judged, so Claude isn't called again.
    let again = curator::run(&state, Some(vec!["aqua".into()]), "test").await.unwrap();
    assert_eq!(again.characters[0].candidates, 0);
    assert_eq!(mocks.claude_calls.lock().unwrap().len(), 1);

    // Admin: auth required; removing a GIF blocks it for good.
    let del = |token: &str| Request::delete("/admin/giphy/g1").header("authorization", format!("Bearer {token}")).body(Body::empty()).unwrap();
    assert_eq!(call(&app, del("nope")).await.0, StatusCode::UNAUTHORIZED);
    assert_eq!(call(&app, del("adm1n")).await.0, StatusCode::NO_CONTENT);
    let (_, manifest) = call(&app, Request::get("/public/giphy/manifest").body(Body::empty()).unwrap()).await;
    assert_eq!(manifest["entries"], json!([]));

    let (status, st) = call(&app, Request::get("/admin/curator/status").header("authorization", "Bearer adm1n").body(Body::empty()).unwrap()).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(st["blocked_gifs"], 1);
    assert_eq!(st["evaluated_gifs"], 3);
    assert_eq!(st["last_run"]["trigger"], "test");

    // Everything survives a restart (Fly volume).
    let reloaded = CuratorState::load(config(&base, &dir).curator);
    let store = reloaded.store.read().await;
    assert_eq!(store.blocked, vec!["g1".to_owned()]);
    assert_eq!(store.evaluated["c1"].len(), 3);
    assert!(store.entries.is_empty());
}

#[tokio::test]
async fn manual_trigger_requires_keys_and_auth() {
    let dir = std::env::temp_dir().join(format!("amii-curator-trigger-{}", std::process::id()));
    let (base, _) = start_mocks().await;

    let mut cfg = config(&base, &dir);
    cfg.curator.anthropic_api_key = None;
    let (app, state) = build(cfg);
    let trigger = Request::post("/admin/curator/run").header("authorization", "Bearer adm1n").body(Body::empty()).unwrap();
    assert_eq!(call(&app, trigger).await.0, StatusCode::SERVICE_UNAVAILABLE);
    assert!(curator::run(&state, None, "test").await.unwrap_err().contains("ANTHROPIC_API_KEY"));

    let (app, _) = build(config(&base, &dir));
    let anon = Request::post("/admin/curator/run").body(Body::empty()).unwrap();
    assert_eq!(call(&app, anon).await.0, StatusCode::UNAUTHORIZED);
    let ok = Request::post("/admin/curator/run?characters=Megumin").header("authorization", "Bearer adm1n").body(Body::empty()).unwrap();
    assert_eq!(call(&app, ok).await.0, StatusCode::ACCEPTED);
}
