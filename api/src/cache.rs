//! Stale-while-error, single-flight response cache.
//!
//! * Fresh entries are served straight from memory (`HIT`).
//! * On a miss or an expired entry, exactly one request per key goes upstream; concurrent
//!   callers for the same key wait on a per-key lock and then read the refreshed entry.
//! * If upstream fails, the last good copy is served (`STALE`) until `stale_ttl` evicts it.
//! * Capacity is bounded by total body bytes, not entry count.

use std::future::Future;
use std::hash::{DefaultHasher, Hash, Hasher};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use bytes::Bytes;
use serde::Serialize;
use tokio::sync::Mutex;

#[derive(Debug)]
pub struct CachedResponse {
    pub body: Bytes,
    pub content_type: String,
    pub etag: String,
    pub fetched_at: Instant,
}

impl CachedResponse {
    pub fn new(body: Bytes, content_type: String) -> Self {
        let mut hasher = DefaultHasher::new();
        body.hash(&mut hasher);
        let etag = format!("W/\"{:016x}-{:x}\"", hasher.finish(), body.len());
        Self { body, content_type, etag, fetched_at: Instant::now() }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CacheStatus {
    Hit,
    Miss,
    Stale,
}

impl CacheStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            CacheStatus::Hit => "HIT",
            CacheStatus::Miss => "MISS",
            CacheStatus::Stale => "STALE",
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct CacheConfig {
    pub fresh_ttl: Duration,
    pub stale_ttl: Duration,
    pub max_bytes: u64,
}

#[derive(Default)]
struct Counters {
    hits: AtomicU64,
    misses: AtomicU64,
    stale: AtomicU64,
    upstream_errors: AtomicU64,
}

#[derive(Debug, Serialize)]
pub struct CacheStats {
    pub entries: u64,
    pub bytes: u64,
    pub max_bytes: u64,
    pub fresh_ttl_secs: u64,
    pub hits: u64,
    pub misses: u64,
    pub stale: u64,
    pub upstream_errors: u64,
}

pub struct ResponseCache {
    entries: moka::future::Cache<String, Arc<CachedResponse>>,
    locks: moka::sync::Cache<String, Arc<Mutex<()>>>,
    config: CacheConfig,
    counters: Counters,
}

impl ResponseCache {
    pub fn new(config: CacheConfig) -> Self {
        let entries = moka::future::Cache::builder()
            .max_capacity(config.max_bytes)
            .weigher(|key: &String, value: &Arc<CachedResponse>| {
                (key.len() + value.body.len()).try_into().unwrap_or(u32::MAX)
            })
            .time_to_live(config.stale_ttl.max(config.fresh_ttl))
            .build();
        let locks = moka::sync::Cache::builder()
            .max_capacity(10_000)
            .time_to_idle(Duration::from_secs(60))
            .build();
        Self { entries, locks, config, counters: Counters::default() }
    }

    fn is_fresh(&self, entry: &CachedResponse) -> bool {
        entry.fetched_at.elapsed() < self.config.fresh_ttl
    }

    /// Returns the cached response for `key`, calling `fetch` at most once across concurrent
    /// callers when the entry is missing or expired.
    pub async fn get_or_fetch<F, Fut, E>(
        &self,
        key: &str,
        fetch: F,
    ) -> Result<(Arc<CachedResponse>, CacheStatus), E>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<CachedResponse, E>>,
    {
        if let Some(entry) = self.entries.get(key).await
            && self.is_fresh(&entry)
        {
            self.counters.hits.fetch_add(1, Ordering::Relaxed);
            return Ok((entry, CacheStatus::Hit));
        }

        let lock = self.locks.get_with(key.to_owned(), || Arc::new(Mutex::new(())));
        let _guard = lock.lock().await;

        // Someone else may have refreshed it while we waited.
        let existing = self.entries.get(key).await;
        if let Some(entry) = &existing
            && self.is_fresh(entry)
        {
            self.counters.hits.fetch_add(1, Ordering::Relaxed);
            return Ok((entry.clone(), CacheStatus::Hit));
        }

        match fetch().await {
            Ok(response) => {
                let response = Arc::new(response);
                self.entries.insert(key.to_owned(), response.clone()).await;
                self.counters.misses.fetch_add(1, Ordering::Relaxed);
                Ok((response, CacheStatus::Miss))
            }
            Err(err) => {
                self.counters.upstream_errors.fetch_add(1, Ordering::Relaxed);
                match existing {
                    Some(stale) => {
                        self.counters.stale.fetch_add(1, Ordering::Relaxed);
                        Ok((stale, CacheStatus::Stale))
                    }
                    None => Err(err),
                }
            }
        }
    }

    pub fn fresh_ttl(&self) -> Duration {
        self.config.fresh_ttl
    }

    pub async fn purge(&self) {
        self.entries.invalidate_all();
        self.entries.run_pending_tasks().await;
    }

    pub async fn stats(&self) -> CacheStats {
        self.entries.run_pending_tasks().await;
        CacheStats {
            entries: self.entries.entry_count(),
            bytes: self.entries.weighted_size(),
            max_bytes: self.config.max_bytes,
            fresh_ttl_secs: self.config.fresh_ttl.as_secs(),
            hits: self.counters.hits.load(Ordering::Relaxed),
            misses: self.counters.misses.load(Ordering::Relaxed),
            stale: self.counters.stale.load(Ordering::Relaxed),
            upstream_errors: self.counters.upstream_errors.load(Ordering::Relaxed),
        }
    }
}
