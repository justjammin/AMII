# giphy

A small, typed async Rust client for the [GIPHY API](https://developers.giphy.com/docs/api/endpoint),
built on `reqwest` (rustls).

```rust
let client = giphy::Client::new(std::env::var("GIPHY_API_KEY")?);

let page = client
    .search(&giphy::SearchParams::new("anime celebration").limit(10).rating(giphy::Rating::Pg13))
    .await?;
for gif in &page.data {
    // Largest GIF rendition under 2 MB (falls back through downsized → fixed_height → small).
    if let Some(r) = gif.best_rendition(2 * 1024 * 1024) {
        println!("{} -> {}", gif.clean_title(), r.url);
    }
}

let trending = client.trending(&giphy::TrendingParams::default()).await?;
let random = client.random(Some("anime smug"), Some(giphy::Rating::G)).await?; // Option<Gif>
let one = client.gif("xT9IgG50Fb7Mi0prBC").await?;
let many = client.gifs(&["id1", "id2"]).await?;
```

- **Endpoints:** search, trending, random, get by id, and get by several ids.
- **Typed responses:** `Gif`, `Images`, `Rendition` and `Pagination`. GIPHY sends sizes as strings; the client parses them into numbers.
- **`Rating`:** ordered `G < Pg < Pg13 < R`, so you can cap it with `min`. Unknown ratings become `Unrated`.
- **Errors:** `Unauthorized` (bad key), `RateLimited` (429), `NotFound`, `Api { status, message }`, `Transport` and `Decode`.
- **Limits:** `limit` is clamped to 50 and `offset` to 4999, GIPHY's maximums. Ids are validated before a request is sent.
- **Key safety:** the API key never appears in `Debug` output.
- **Testing:** `Client::base_url(..)` points the client at a mock server.

GIPHY's terms require "Powered By GIPHY" attribution wherever you show results.
Beta keys are limited to about 100 calls an hour, so cache in front of the client (amii-api does).

```bash
cargo test -p giphy
```
