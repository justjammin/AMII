use axum::Router;
use axum::extract::{Path, RawQuery};
use axum::http::StatusCode;
use axum::routing::get;
use giphy::{Client, Error, Rating, SearchParams, TrendingParams};

const GIF: &str = r#"{"id":"xT9IgG50Fb7Mi0prBC","title":"Anime Celebration GIF","url":"https://giphy.com/gifs/xT9","rating":"pg",
  "images":{"original":{"url":"https://media.giphy.com/media/xT9/giphy.gif","width":"480","height":"270","size":"123456"}}}"#;

async fn mock() -> String {
    let router = Router::new()
        .route(
            "/v1/gifs/search",
            get(|RawQuery(q): RawQuery| async move {
                let q = q.unwrap_or_default();
                if q.contains("api_key=bad") {
                    return (StatusCode::UNAUTHORIZED, r#"{"message":"Invalid authentication credentials"}"#.to_owned());
                }
                if q.contains("api_key=spent") {
                    return (StatusCode::TOO_MANY_REQUESTS, r#"{"meta":{"msg":"Rate limit"}}"#.to_owned());
                }
                // Echo the query back through pagination so the test can inspect it.
                assert!(q.contains("q=anime+celebration") || q.contains("q=anime%20celebration"), "{q}");
                assert!(q.contains("limit=50") && q.contains("rating=pg-13"), "{q}");
                (StatusCode::OK, format!(r#"{{"data":[{GIF}],"pagination":{{"total_count":900,"count":1,"offset":0}},"meta":{{"status":200}}}}"#))
            }),
        )
        .route("/v1/gifs/trending", get(|| async { format!(r#"{{"data":[{GIF},{GIF}]}}"#) }))
        .route(
            "/v1/gifs/random",
            get(|RawQuery(q): RawQuery| async move {
                if q.unwrap_or_default().contains("tag=nothing") { r#"{"data":[]}"#.to_owned() } else { format!(r#"{{"data":{GIF}}}"#) }
            }),
        )
        .route(
            "/v1/gifs/{id}",
            get(|Path(id): Path<String>| async move {
                if id == "xT9IgG50Fb7Mi0prBC" {
                    (StatusCode::OK, format!(r#"{{"data":{GIF}}}"#))
                } else {
                    (StatusCode::NOT_FOUND, r#"{"meta":{"msg":"Not Found"}}"#.to_owned())
                }
            }),
        )
        .route("/v1/gifs", get(|| async { format!(r#"{{"data":[{GIF}]}}"#) }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    format!("http://{addr}/v1")
}

#[tokio::test]
async fn search_trending_random_and_lookup() {
    let base = mock().await;
    let client = Client::new("key").base_url(&base);

    let page = client
        .search(&SearchParams::new("anime celebration").limit(99).rating(Rating::Pg13))
        .await
        .unwrap();
    assert_eq!(page.pagination.total_count, 900);
    assert_eq!(page.data[0].rating, Rating::Pg);
    assert_eq!(page.data[0].images.original.as_ref().unwrap().size, Some(123_456));

    assert_eq!(client.trending(&TrendingParams::default()).await.unwrap().data.len(), 2);
    assert!(client.random(Some("anime"), None).await.unwrap().is_some());
    assert!(client.random(Some("nothing"), None).await.unwrap().is_none());
    assert_eq!(client.gif("xT9IgG50Fb7Mi0prBC").await.unwrap().clean_title(), "Anime Celebration");
    assert!(matches!(client.gif("missing").await, Err(Error::NotFound)));
    assert!(matches!(client.gif("../etc").await, Err(Error::NotFound)), "ids are validated locally");
    assert_eq!(client.gifs(&["a", "b"]).await.unwrap().len(), 1);
}

#[tokio::test]
async fn maps_errors() {
    let base = mock().await;
    let bad = Client::new("bad").base_url(&base).search(&SearchParams::new("x")).await;
    assert!(matches!(bad, Err(Error::Unauthorized(m)) if m.contains("Invalid")));
    let spent = Client::new("spent").base_url(&base).search(&SearchParams::new("x")).await;
    assert!(matches!(spent, Err(Error::RateLimited)));
    assert!(!format!("{:?}", Client::new("supersecret")).contains("supersecret"));
}
