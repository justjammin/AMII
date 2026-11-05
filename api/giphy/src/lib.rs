//! A small, typed async client for the [GIPHY API](https://developers.giphy.com/docs/api/endpoint).
//!
//! ```no_run
//! # async fn demo() -> Result<(), giphy::Error> {
//! let client = giphy::Client::new("YOUR_API_KEY");
//! let page = client
//!     .search(&giphy::SearchParams::new("anime celebration").limit(10).rating(giphy::Rating::Pg13))
//!     .await?;
//! for gif in &page.data {
//!     if let Some(r) = gif.best_rendition(2 * 1024 * 1024) {
//!         println!("{} -> {}", gif.title, r.url);
//!     }
//! }
//! # Ok(()) }
//! ```
//!
//! GIPHY's terms require "Powered By GIPHY" attribution wherever results are shown.

use std::fmt;
use std::time::Duration;

use serde::de::{self, Deserializer};
use serde::{Deserialize, Serialize};

pub const DEFAULT_BASE_URL: &str = "https://api.giphy.com/v1/";
/// GIPHY rejects `limit` above 50 and `offset` above 4999 on search.
pub const MAX_LIMIT: u32 = 50;
pub const MAX_OFFSET: u32 = 4999;

// ------------------------------------------------------------------ errors

#[derive(Debug)]
pub enum Error {
    /// Network / TLS / timeout.
    Transport(reqwest::Error),
    /// 401/403: missing or invalid API key.
    Unauthorized(String),
    /// 429: the key's rate limit is exhausted.
    RateLimited,
    /// 404: no GIF with that id.
    NotFound,
    /// Any other non-success status.
    Api { status: u16, message: String },
    /// Response body didn't match the documented shape.
    Decode(String),
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::Transport(e) => write!(f, "giphy request failed: {e}"),
            Error::Unauthorized(m) => write!(f, "giphy rejected the API key: {m}"),
            Error::RateLimited => write!(f, "giphy rate limit exceeded"),
            Error::NotFound => write!(f, "giphy: not found"),
            Error::Api { status, message } => write!(f, "giphy responded {status}: {message}"),
            Error::Decode(m) => write!(f, "unexpected giphy response: {m}"),
        }
    }
}

impl std::error::Error for Error {}

impl From<reqwest::Error> for Error {
    fn from(e: reqwest::Error) -> Self {
        Error::Transport(e)
    }
}

// ------------------------------------------------------------------- types

/// Content rating. Ordered from most to least family friendly.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, Default)]
#[serde(rename_all = "kebab-case")]
pub enum Rating {
    #[default]
    G,
    Pg,
    #[serde(rename = "pg-13")]
    Pg13,
    R,
    /// GIPHY occasionally returns empty or unknown ratings.
    #[serde(other)]
    Unrated,
}

impl Rating {
    pub fn as_str(self) -> &'static str {
        match self {
            Rating::G => "g",
            Rating::Pg => "pg",
            Rating::Pg13 => "pg-13",
            Rating::R => "r",
            Rating::Unrated => "",
        }
    }
}

impl std::str::FromStr for Rating {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.to_ascii_lowercase().as_str() {
            "g" => Ok(Rating::G),
            "pg" => Ok(Rating::Pg),
            "pg-13" | "pg13" => Ok(Rating::Pg13),
            "r" => Ok(Rating::R),
            other => Err(format!("unknown rating {other:?} (expected g, pg, pg-13 or r)")),
        }
    }
}

/// One encoding of a GIF (GIPHY sends numbers as strings; they're parsed here).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct Rendition {
    #[serde(default)]
    pub url: String,
    #[serde(default, deserialize_with = "lenient_u32")]
    pub width: Option<u32>,
    #[serde(default, deserialize_with = "lenient_u32")]
    pub height: Option<u32>,
    /// Bytes of the GIF encoding.
    #[serde(default, deserialize_with = "lenient_u32")]
    pub size: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mp4: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub webp: Option<String>,
    #[serde(default, deserialize_with = "lenient_u32", skip_serializing_if = "Option::is_none")]
    pub webp_size: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct Images {
    pub original: Option<Rendition>,
    pub downsized: Option<Rendition>,
    pub downsized_medium: Option<Rendition>,
    pub downsized_large: Option<Rendition>,
    pub fixed_height: Option<Rendition>,
    pub fixed_width: Option<Rendition>,
    pub fixed_height_small: Option<Rendition>,
    pub preview_gif: Option<Rendition>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Gif {
    pub id: String,
    #[serde(default)]
    pub title: String,
    /// GIPHY page for the GIF (use for attribution links).
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub rating: Rating,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub source: String,
    #[serde(default)]
    pub images: Images,
}

impl Gif {
    /// Largest GIF rendition that fits in `max_bytes` (unknown sizes count as fitting),
    /// preferring quality: original, downsized_large, downsized_medium, downsized, fixed_height.
    pub fn best_rendition(&self, max_bytes: u32) -> Option<&Rendition> {
        let i = &self.images;
        [&i.original, &i.downsized_large, &i.downsized_medium, &i.downsized, &i.fixed_height, &i.fixed_width]
            .into_iter()
            .flatten()
            .filter(|r| !r.url.is_empty())
            .find(|r| r.size.is_none_or(|s| s <= max_bytes))
            .or(i.fixed_height_small.as_ref().filter(|r| !r.url.is_empty()))
    }

    /// Human readable title without GIPHY's trailing " GIF by user" / " GIF".
    pub fn clean_title(&self) -> String {
        let t = self.title.trim();
        let t = t.split(" GIF by ").next().unwrap_or(t);
        t.strip_suffix(" GIF").unwrap_or(t).trim().to_owned()
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct Pagination {
    #[serde(default)]
    pub total_count: u32,
    #[serde(default)]
    pub count: u32,
    #[serde(default)]
    pub offset: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Page {
    pub data: Vec<Gif>,
    #[serde(default)]
    pub pagination: Pagination,
}

#[derive(Deserialize)]
struct Envelope<T> {
    data: T,
    #[serde(default)]
    pagination: Option<Pagination>,
}

#[derive(Deserialize, Default)]
struct ErrorBody {
    #[serde(default)]
    meta: Option<Meta>,
    #[serde(default)]
    message: Option<String>,
}

#[derive(Deserialize, Default)]
struct Meta {
    #[serde(default)]
    msg: String,
}

fn lenient_u32<'de, D: Deserializer<'de>>(d: D) -> Result<Option<u32>, D::Error> {
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Raw {
        N(u64),
        S(String),
        Null,
    }
    Ok(match Raw::deserialize(d)? {
        Raw::N(n) => u32::try_from(n).ok(),
        Raw::S(s) if s.is_empty() => None,
        Raw::S(s) => Some(s.parse().map_err(de::Error::custom)?),
        Raw::Null => None,
    })
}

// ----------------------------------------------------------------- params

#[derive(Debug, Clone)]
pub struct SearchParams {
    pub query: String,
    pub limit: u32,
    pub offset: u32,
    pub rating: Option<Rating>,
    pub lang: Option<String>,
}

impl SearchParams {
    pub fn new(query: impl Into<String>) -> Self {
        Self { query: query.into(), limit: 25, offset: 0, rating: None, lang: None }
    }
    pub fn limit(mut self, limit: u32) -> Self {
        self.limit = limit.clamp(1, MAX_LIMIT);
        self
    }
    pub fn offset(mut self, offset: u32) -> Self {
        self.offset = offset.min(MAX_OFFSET);
        self
    }
    pub fn rating(mut self, rating: Rating) -> Self {
        self.rating = Some(rating);
        self
    }
    pub fn lang(mut self, lang: impl Into<String>) -> Self {
        self.lang = Some(lang.into());
        self
    }
}

#[derive(Debug, Clone, Default)]
pub struct TrendingParams {
    pub limit: u32,
    pub offset: u32,
    pub rating: Option<Rating>,
}

// ----------------------------------------------------------------- client

#[derive(Clone)]
pub struct Client {
    http: reqwest::Client,
    api_key: String,
    base_url: String,
}

impl fmt::Debug for Client {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        // Never print the key.
        f.debug_struct("Client").field("base_url", &self.base_url).finish_non_exhaustive()
    }
}

impl Client {
    pub fn new(api_key: impl Into<String>) -> Self {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(10))
            .user_agent(concat!("giphy-rs/", env!("CARGO_PKG_VERSION")))
            .build()
            .expect("http client");
        Self::with_http(http, api_key)
    }

    pub fn with_http(http: reqwest::Client, api_key: impl Into<String>) -> Self {
        Self { http, api_key: api_key.into(), base_url: DEFAULT_BASE_URL.to_owned() }
    }

    /// Point at a different host (tests, proxies). A trailing slash is added if missing.
    pub fn base_url(mut self, url: impl Into<String>) -> Self {
        let mut url = url.into();
        if !url.ends_with('/') {
            url.push('/');
        }
        self.base_url = url;
        self
    }

    pub async fn search(&self, p: &SearchParams) -> Result<Page, Error> {
        let mut q = vec![
            ("q", p.query.clone()),
            ("limit", p.limit.clamp(1, MAX_LIMIT).to_string()),
            ("offset", p.offset.min(MAX_OFFSET).to_string()),
        ];
        if let Some(r) = p.rating {
            q.push(("rating", r.as_str().to_owned()));
        }
        if let Some(l) = &p.lang {
            q.push(("lang", l.clone()));
        }
        self.page("gifs/search", &q).await
    }

    pub async fn trending(&self, p: &TrendingParams) -> Result<Page, Error> {
        let limit = if p.limit == 0 { 25 } else { p.limit.min(MAX_LIMIT) };
        let mut q = vec![("limit", limit.to_string()), ("offset", p.offset.min(MAX_OFFSET).to_string())];
        if let Some(r) = p.rating {
            q.push(("rating", r.as_str().to_owned()));
        }
        self.page("gifs/trending", &q).await
    }

    /// A random GIF, optionally tagged. `Ok(None)` when nothing matches.
    pub async fn random(&self, tag: Option<&str>, rating: Option<Rating>) -> Result<Option<Gif>, Error> {
        let mut q = Vec::new();
        if let Some(t) = tag {
            q.push(("tag", t.to_owned()));
        }
        if let Some(r) = rating {
            q.push(("rating", r.as_str().to_owned()));
        }
        // GIPHY sends `"data": []` instead of an object when there is no match.
        let env: Envelope<serde_json::Value> = self.get("gifs/random", &q).await?;
        match env.data {
            serde_json::Value::Object(_) => serde_json::from_value(env.data).map(Some).map_err(|e| Error::Decode(e.to_string())),
            _ => Ok(None),
        }
    }

    pub async fn gif(&self, id: &str) -> Result<Gif, Error> {
        if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric()) {
            return Err(Error::NotFound);
        }
        let env: Envelope<Gif> = self.get(&format!("gifs/{id}"), &[]).await?;
        Ok(env.data)
    }

    pub async fn gifs(&self, ids: &[&str]) -> Result<Vec<Gif>, Error> {
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        let env: Envelope<Vec<Gif>> = self.get("gifs", &[("ids", ids.join(","))]).await?;
        Ok(env.data)
    }

    async fn page(&self, path: &str, q: &[(&str, String)]) -> Result<Page, Error> {
        let env: Envelope<Vec<Gif>> = self.get(path, q).await?;
        Ok(Page { data: env.data, pagination: env.pagination.unwrap_or_default() })
    }

    async fn get<T: serde::de::DeserializeOwned>(&self, path: &str, q: &[(&str, String)]) -> Result<T, Error> {
        let res = self
            .http
            .get(format!("{}{path}", self.base_url))
            .query(&[("api_key", self.api_key.as_str())])
            .query(q)
            .send()
            .await?;
        let status = res.status().as_u16();
        let bytes = res.bytes().await?;
        if (200..300).contains(&status) {
            return serde_json::from_slice(&bytes).map_err(|e| Error::Decode(e.to_string()));
        }
        let body: ErrorBody = serde_json::from_slice(&bytes).unwrap_or_default();
        let message = body.meta.map(|m| m.msg).filter(|m| !m.is_empty()).or(body.message).unwrap_or_default();
        Err(match status {
            401 | 403 => Error::Unauthorized(message),
            404 => Error::NotFound,
            429 => Error::RateLimited,
            _ => Error::Api { status, message },
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_string_numbers_and_unknown_ratings() {
        let gif: Gif = serde_json::from_str(
            r#"{"id":"abc","title":"Happy Anime GIF by Crunchyroll","rating":"weird",
                "images":{"original":{"url":"https://media.giphy.com/a.gif","width":"480","height":"270","size":"4000000"},
                          "downsized":{"url":"https://media.giphy.com/d.gif","size":"900000"},
                          "fixed_height":{"url":"https://media.giphy.com/f.gif","size":""}}}"#,
        )
        .unwrap();
        assert_eq!(gif.rating, Rating::Unrated);
        assert_eq!(gif.images.original.as_ref().unwrap().width, Some(480));
        assert_eq!(gif.clean_title(), "Happy Anime");
        assert_eq!(gif.best_rendition(5_000_000).unwrap().url, "https://media.giphy.com/a.gif");
        assert_eq!(gif.best_rendition(1_000_000).unwrap().url, "https://media.giphy.com/d.gif");
        assert_eq!(gif.best_rendition(10).unwrap().url, "https://media.giphy.com/f.gif");
    }

    #[test]
    fn ratings_order_and_parse() {
        assert!(Rating::G < Rating::Pg13 && Rating::Pg13 < Rating::R);
        assert_eq!("PG-13".parse::<Rating>().unwrap(), Rating::Pg13);
        assert!("nc-17".parse::<Rating>().is_err());
    }

    #[test]
    fn params_clamp() {
        let p = SearchParams::new("x").limit(500).offset(99_999);
        assert_eq!((p.limit, p.offset), (MAX_LIMIT, MAX_OFFSET));
    }
}
