import { promises as fs } from 'fs';
import * as crypto from 'crypto';
import * as path from 'path';
import {
  DefinitionCategory,
  Definitions,
  DEFINITION_CATEGORIES,
  GiphyVisualRepresentation,
  mergeDefinitions,
  Representation,
} from './models';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface StoreOptions {
  /** e.g. https://amii.api.unthrottled.io/public/ or your own AMII API. */
  apiUrl: string;
  /** e.g. https://amii.assets.unthrottled.io */
  assetSource: string;
  storageDir: string;
  /** How long definitions are trusted before a `changedSince` refresh. */
  refreshIntervalMs?: number;
  log?: (message: string) => void;
  fetchImpl?: typeof fetch;
}

interface Meta {
  fetchedAt: number;
}

const withSlash = (url: string) => (url.endsWith('/') ? url : `${url}/`);

/** Safe join that refuses to escape the base directory (paths come from the network). */
function within(base: string, ...parts: string[]): string {
  const resolved = path.resolve(base, ...parts);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) {
    throw new Error(`Refusing path outside storage: ${parts.join('/')}`);
  }
  return resolved;
}

/**
 * Disk-backed cache of asset definitions and media, mirroring the IntelliJ
 * plugin's `~/.amii` layout: `api/assets/<category>` + `<category>/<path>`.
 */
export interface MediaResolver {
  resolveMedia(category: 'visuals' | 'audible', assetPath: string): Promise<string | undefined>;
  resolveUrl(url: string): Promise<string | undefined>;
}

/** Only GIPHY's CDN may be downloaded from by absolute URL. */
export function isAllowedMediaUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && (url.hostname === 'giphy.com' || url.hostname.endsWith('.giphy.com'));
  } catch {
    return false;
  }
}

export class AssetStore implements MediaResolver {
  private readonly fetchImpl: typeof fetch;
  private readonly inflight = new Map<string, Promise<string | undefined>>();

  constructor(private readonly opts: StoreOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private log(message: string) {
    this.opts.log?.(message);
  }

  private definitionFile(category: DefinitionCategory) {
    return within(path.resolve(this.opts.storageDir), 'api', 'assets', `${category}.json`);
  }

  async loadAll(force = false): Promise<Definitions> {
    const entries = await Promise.all(
      DEFINITION_CATEGORIES.map(async (c) => [c, await this.loadDefinitions(c, force)] as const),
    );
    return Object.fromEntries(entries) as unknown as Definitions;
  }

  async loadDefinitions<T extends Representation>(category: DefinitionCategory, force = false): Promise<T[]> {
    const file = this.definitionFile(category);
    const metaFile = `${file}.meta`;
    const existing = await readJson<T[]>(file);
    const meta = await readJson<Meta>(metaFile);
    const interval = this.opts.refreshIntervalMs ?? DAY_MS;
    const stale = !meta || Date.now() - meta.fetchedAt > interval;

    if (existing && !stale && !force) return existing;

    const url = new URL(`assets/${category}`, withSlash(this.opts.apiUrl));
    if (existing && meta && !force) url.searchParams.set('changedSince', String(Math.floor(meta.fetchedAt / 1000)));

    try {
      const res = await this.fetchImpl(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as T[];
      const next = existing && url.searchParams.has('changedSince') ? mergeDefinitions(existing, body) : body;
      await writeFileAtomic(file, JSON.stringify(next));
      await writeFileAtomic(metaFile, JSON.stringify({ fetchedAt: Date.now() } satisfies Meta));
      this.log(`Synced ${category}: ${next.length} definitions`);
      return next;
    } catch (err) {
      this.log(`Unable to sync ${category} from ${url}: ${String(err)}`);
      return existing ?? [];
    }
  }

  /**
   * GIPHY-sourced meme definitions served by your AMII API (`<apiUrl>/giphy/visuals`).
   * Cached on disk like the other definitions; returns [] if the API has GIPHY disabled.
   */
  async loadGiphy(force = false): Promise<GiphyVisualRepresentation[]> {
    const file = within(path.resolve(this.opts.storageDir), 'api', 'giphy', 'visuals.json');
    const metaFile = `${file}.meta`;
    const existing = await readJson<GiphyVisualRepresentation[]>(file);
    const meta = await readJson<Meta>(metaFile);
    const interval = this.opts.refreshIntervalMs ?? DAY_MS;
    if (existing && meta && Date.now() - meta.fetchedAt <= interval && !force) return existing;

    const url = new URL('giphy/visuals', withSlash(this.opts.apiUrl));
    try {
      const res = await this.fetchImpl(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = ((await res.json()) as GiphyVisualRepresentation[]).filter((v) => isAllowedMediaUrl(v.url));
      await writeFileAtomic(file, JSON.stringify(body));
      await writeFileAtomic(metaFile, JSON.stringify({ fetchedAt: Date.now() } satisfies Meta));
      this.log(`Synced GIPHY: ${body.length} memes`);
      return body;
    } catch (err) {
      this.log(`Unable to sync GIPHY memes from ${url}: ${String(err)}`);
      return existing ?? [];
    }
  }

  /** Downloads a GIF by absolute URL (GIPHY CDN only) into `giphy/<hash>`. */
  async resolveUrl(url: string): Promise<string | undefined> {
    if (!isAllowedMediaUrl(url)) {
      this.log(`Refusing to download from ${url}`);
      return undefined;
    }
    const hash = crypto.createHash('sha256').update(url).digest('hex').slice(0, 32);
    const ext = path.extname(new URL(url).pathname) || '.gif';
    const local = within(path.resolve(this.opts.storageDir), 'giphy', `${hash}${ext}`);
    if (await exists(local)) return local;
    let pending = this.inflight.get(local);
    if (!pending) {
      pending = this.download(url, local).finally(() => this.inflight.delete(local));
      this.inflight.set(local, pending);
    }
    return pending;
  }

  /**
   * Returns a local file path for a remote asset, downloading it once.
   * Concurrent requests for the same asset share one download.
   */
  async resolveMedia(category: 'visuals' | 'audible', assetPath: string): Promise<string | undefined> {
    const local = within(path.resolve(this.opts.storageDir), category, assetPath);
    if (await exists(local)) return local;

    const key = `${category}/${assetPath}`;
    let pending = this.inflight.get(key);
    if (!pending) {
      pending = this.download(`${withSlash(this.opts.assetSource)}${key}`, local).finally(() =>
        this.inflight.delete(key),
      );
      this.inflight.set(key, pending);
    }
    return pending;
  }

  private async download(url: string, dest: string): Promise<string | undefined> {
    try {
      const res = await this.fetchImpl(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await writeFileAtomic(dest, Buffer.from(await res.arrayBuffer()));
      return dest;
    } catch (err) {
      this.log(`Unable to download ${url}: ${String(err)}`);
      return undefined;
    }
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function readJson<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

async function writeFileAtomic(file: string, data: string | Buffer): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, data);
  await fs.rename(tmp, file);
}
