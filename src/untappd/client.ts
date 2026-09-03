import { formatRating } from './rating.js';

export type AlgoliaConfig = { appId: string; searchKey: string };

export type UntappdClientConfig = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  userAgent: string;
  algolia?: AlgoliaConfig;
};

type UntappdEnvelope<T> = {
  response: T;
  meta?: {
    code?: number;
    error_detail?: string;
    developer_friendly?: string;
  };
};

export class UntappdApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly endpoint: string
  ) {
    super(message);
    this.name = 'UntappdApiError';
  }
}

/**
 * Raised only inside the client to signal that the Algolia beer index could not
 * serve a search and the Untappd API fallback should run. It is never surfaced
 * to callers as an `UntappdApiError`.
 */
class AlgoliaSearchUnavailableError extends Error {
  constructor(
    readonly status: number | null,
    message: string
  ) {
    super(message);
    this.name = 'AlgoliaSearchUnavailableError';
  }
}

// Untappd's website searches beers through this public Algolia application. The
// keys are the same ones untappd.com ships to browsers; they can be rotated
// without notice, which is why searchBeers falls back to the Untappd API.
const ALGOLIA_DEFAULT_APP_ID = '9WBO4RQ3HO';
const ALGOLIA_DEFAULT_SEARCH_KEY = '1d347324d67ec472bb7132c66aead485';
const FIND_USER_BEER_RATE_FLOOR = 10;

function algoliaBeerIndexUrl(appId: string): string {
  return `https://${appId.toLowerCase()}-dsn.algolia.net/1/indexes/beer/query`;
}

export type BeerSearchResult = {
  bid: number;
  beerName: string | null;
  brewery: { id: number | null; name: string | null };
  style: string | null;
  abv: number | null;
  ibu: number | null;
  globalRating: number | null;
  ratingCount: number | null;
  slug: string | null;
  labelUrl: string | null;
  aliases: string[];
  source: 'algolia' | 'untappd-api';
};

type AlgoliaBeerHit = {
  bid?: number;
  beer_name?: string;
  beer_abv?: number;
  beer_ibu?: number;
  brewery_name?: string;
  brewery_id?: number;
  type_name?: string;
  rating_score?: number;
  rating_count?: number;
  beer_slug?: string;
  beer_label?: string;
  alias_alt?: unknown;
  brewery_alias?: unknown;
};

type UntappdSearchItem = {
  beer?: Record<string, unknown>;
  brewery?: Record<string, unknown>;
};

type UserBeerItem = {
  count?: number;
  first_had?: string;
  first_checkin_id?: number;
  first_created_at?: string;
  recent_created_at?: string;
  /** In user/beers/USERNAME this is the queried user's own rating (0 when unrated). */
  rating_score?: number;
  beer?: { bid?: number; beer_name?: string };
  brewery?: { brewery_name?: string };
};

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function ratingOrNull(value: unknown): number | null {
  return typeof value === 'number' && value > 0 ? value : null;
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];
}

function dedupe(values: string[]): string[] {
  return Array.from(new Set(values));
}

function isUsableBid(value: unknown): boolean {
  const bid = Number(value);
  return Number.isFinite(bid) && bid > 0;
}

function normalizeAlgoliaHit(hit: AlgoliaBeerHit): BeerSearchResult {
  return {
    bid: Number(hit.bid),
    beerName: stringOrNull(hit.beer_name),
    brewery: { id: numberOrNull(hit.brewery_id), name: stringOrNull(hit.brewery_name) },
    style: stringOrNull(hit.type_name),
    abv: numberOrNull(hit.beer_abv),
    ibu: numberOrNull(hit.beer_ibu),
    globalRating: ratingOrNull(hit.rating_score),
    ratingCount: numberOrNull(hit.rating_count),
    slug: stringOrNull(hit.beer_slug),
    labelUrl: stringOrNull(hit.beer_label),
    aliases: dedupe([...toStringArray(hit.alias_alt), ...toStringArray(hit.brewery_alias)]),
    source: 'algolia',
  };
}

function normalizeUntappdSearchItem(item: UntappdSearchItem): BeerSearchResult {
  const beer = item.beer ?? {};
  const brewery = item.brewery ?? {};
  return {
    bid: Number(beer.bid),
    beerName: stringOrNull(beer.beer_name),
    brewery: { id: numberOrNull(brewery.brewery_id), name: stringOrNull(brewery.brewery_name) },
    style: stringOrNull(beer.beer_style),
    abv: numberOrNull(beer.beer_abv),
    ibu: numberOrNull(beer.beer_ibu),
    globalRating: ratingOrNull(beer.rating_score),
    ratingCount: numberOrNull(beer.rating_count),
    slug: stringOrNull(beer.beer_slug),
    labelUrl: stringOrNull(beer.beer_label),
    aliases: [],
    source: 'untappd-api',
  };
}

export type UserBeersSort =
  | 'date'
  | 'checkin'
  | 'highest_rated'
  | 'lowest_rated'
  | 'highest_rated_you'
  | 'lowest_rated_you';

export type UserBeerLookup = {
  username: string;
  beerId: number;
  found: boolean;
  /** True when the user's full distinct-beer list (within any date window) was scanned without a match. */
  exhausted: boolean;
  /** True when the target profile is private / locked to this caller. */
  locked: boolean;
  /** True when the scan was cut short because the shared Untappd hourly quota is nearly exhausted. */
  stoppedForRateLimit: boolean;
  scannedDistinctBeers: number;
  totalDistinctBeers: number | null;
  requestsUsed: number;
  match: {
    beerId: number;
    beerName: string | null;
    breweryName: string | null;
    userRating: number | null;
    checkinCount: number | null;
    firstHadAt: string | null;
    lastHadAt: string | null;
    firstCheckinId: number | null;
  } | null;
};

type RateLimitSnapshot = {
  limit: number;
  remaining: number;
  observedAt: number;
  endpoint: string;
};

export type UntappdApiUsageSnapshot = {
  lastSeen: {
    limit: number;
    remaining: number;
    observedAt: string;
    ageSeconds: number;
    endpoint: string;
  } | null;
  instance: {
    callsLastHour: number;
    callsSinceStart: number;
    startedAt: string;
    uptimeSeconds: number;
  };
  note: string;
};

const USAGE_NOTE =
  'limit and remaining are Untappd account-wide values shared by every user of this server ' +
  '(100 per rolling hour, per Untappd app key). instance.* counters cover only this server ' +
  'process and reset on restart or scale events.';

export class UntappdClient {
  private static readonly apiBaseUrl = 'https://api.untappd.com/v4/';
  private static readonly oauthAuthenticateUrl = 'https://untappd.com/oauth/authenticate/';
  private static readonly oauthAuthorizeUrl = 'https://untappd.com/oauth/authorize/';
  private static readonly rateWindowMs = 3_600_000;

  private readonly algoliaAppId: string;
  private readonly algoliaSearchKey: string;

  private lastRateLimit: RateLimitSnapshot | null = null;
  private readonly callTimestamps: number[] = [];
  private totalCallsSinceStart = 0;
  private readonly startedAt = Date.now();

  constructor(
    private readonly config: UntappdClientConfig,
    private readonly fetchImpl: typeof fetch = fetch
  ) {
    this.algoliaAppId = config.algolia?.appId ?? ALGOLIA_DEFAULT_APP_ID;
    this.algoliaSearchKey = config.algolia?.searchKey ?? ALGOLIA_DEFAULT_SEARCH_KEY;
  }

  authorizationUrl(state: string): string {
    const url = new URL(UntappdClient.oauthAuthenticateUrl);
    url.searchParams.set('client_id', this.config.clientId);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('redirect_url', this.config.redirectUri);
    url.searchParams.set('state', state);
    return url.toString();
  }

  async exchangeAuthorizationCode(code: string): Promise<string> {
    const url = new URL(UntappdClient.oauthAuthorizeUrl);
    url.searchParams.set('client_id', this.config.clientId);
    url.searchParams.set('client_secret', this.config.clientSecret);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('redirect_url', this.config.redirectUri);
    url.searchParams.set('code', code);

    const payload = await this.fetchJson<{ access_token?: string }>(url, { method: 'GET' }, 'oauth/authorize');
    if (!payload.response.access_token) {
      throw new UntappdApiError('Untappd did not return an access token', 502, 'oauth/authorize');
    }
    return payload.response.access_token;
  }

  /**
   * Searches Untappd's public Algolia beer index (no Untappd API quota cost). On
   * any Algolia failure it falls back to the Untappd `search/beer` API, which
   * does consume the shared hourly quota. Both paths return the same shape.
   */
  async searchBeers(query: string, limit: number, accessToken?: string): Promise<BeerSearchResult[]> {
    try {
      return await this.searchBeersViaAlgolia(query, limit);
    } catch (error) {
      if (error instanceof AlgoliaSearchUnavailableError) {
        console.log(
          JSON.stringify({ message: 'algolia_search_fallback', status: error.status, detail: error.message })
        );
        return this.searchBeersViaApi(query, limit, accessToken);
      }
      throw error;
    }
  }

  private async searchBeersViaAlgolia(query: string, limit: number): Promise<BeerSearchResult[]> {
    let response: Response;
    try {
      response = await this.fetchImpl(algoliaBeerIndexUrl(this.algoliaAppId), {
        method: 'POST',
        headers: {
          'X-Algolia-Application-Id': this.algoliaAppId,
          'X-Algolia-API-Key': this.algoliaSearchKey,
          'Content-Type': 'application/json',
          'User-Agent': this.config.userAgent,
        },
        body: JSON.stringify({ query, hitsPerPage: limit }),
      });
    } catch (cause) {
      throw new AlgoliaSearchUnavailableError(
        null,
        `Algolia request failed: ${cause instanceof Error ? cause.message : 'unknown error'}`
      );
    }
    if (!response.ok) {
      throw new AlgoliaSearchUnavailableError(response.status, `Algolia returned HTTP ${response.status}`);
    }
    const payload = (await response.json().catch(() => null)) as { hits?: AlgoliaBeerHit[] } | null;
    if (!payload || !Array.isArray(payload.hits)) {
      throw new AlgoliaSearchUnavailableError(response.status, 'Algolia returned an unexpected body');
    }
    return payload.hits
      .filter(hit => isUsableBid(hit?.bid))
      .slice(0, limit)
      .map(normalizeAlgoliaHit);
  }

  private async searchBeersViaApi(
    query: string,
    limit: number,
    accessToken?: string
  ): Promise<BeerSearchResult[]> {
    const response = (await this.get('search/beer', { q: query, limit: String(limit) }, accessToken)) as {
      beers?: { items?: UntappdSearchItem[] };
    };
    return (response.beers?.items ?? [])
      .filter(item => isUsableBid(item?.beer?.bid))
      .map(normalizeUntappdSearchItem);
  }

  async getBeer(beerId: number, accessToken?: string): Promise<unknown> {
    return this.get(`beer/info/${beerId}`, {}, accessToken);
  }

  async getCurrentUser(accessToken: string): Promise<unknown> {
    return this.get('user/info/', {}, accessToken);
  }

  async getWishlist(accessToken: string, limit: number, offset: number): Promise<unknown> {
    return this.get('user/wishlist/', { limit: String(limit), offset: String(offset) }, accessToken);
  }

  async getDistinctBeers(accessToken: string, limit: number, offset: number): Promise<unknown> {
    return this.get('user/beers/', { limit: String(limit), offset: String(offset) }, accessToken);
  }

  async getUserInfo(username: string, accessToken?: string, compact = false): Promise<unknown> {
    return this.get(
      `user/info/${encodeURIComponent(username)}`,
      compact ? { compact: 'true' } : {},
      accessToken
    );
  }

  async getUserBeers(
    username: string,
    options: {
      limit: number;
      offset: number;
      sort?: UserBeersSort;
      startDate?: string;
      endDate?: string;
    },
    accessToken?: string
  ): Promise<unknown> {
    const query: Record<string, string> = {
      limit: String(options.limit),
      offset: String(options.offset),
    };
    if (options.sort) {
      query.sort = options.sort;
    }
    if (options.startDate) {
      query.start_date = options.startDate;
    }
    if (options.endDate) {
      query.end_date = options.endDate;
    }
    return this.get(`user/beers/${encodeURIComponent(username)}`, query, accessToken);
  }

  async getUserCheckins(
    username: string,
    options: { limit: number; maxId?: number; minId?: number },
    accessToken?: string
  ): Promise<unknown> {
    const query: Record<string, string> = { limit: String(options.limit) };
    if (options.maxId !== undefined) {
      query.max_id = String(options.maxId);
    }
    if (options.minId !== undefined) {
      query.min_id = String(options.minId);
    }
    return this.get(`user/checkins/${encodeURIComponent(username)}`, query, accessToken);
  }

  /**
   * Untappd exposes no "has user X had beer Y" endpoint, so page through the
   * user's distinct beers (newest first) until the beer id is found or the list
   * is exhausted. `maxRequests` caps the paging to protect the hourly API quota,
   * and the scan also stops early once the shared quota runs low.
   */
  async findUserBeer(
    username: string,
    beerId: number,
    options: {
      accessToken?: string;
      maxRequests?: number;
      startDate?: string;
      endDate?: string;
      sort?: UserBeersSort;
      rateLimitFloor?: number;
    } = {}
  ): Promise<UserBeerLookup> {
    const pageSize = 50;
    const maxRequests = Math.max(1, Math.min(options.maxRequests ?? 12, 40));
    const rateLimitFloor = options.rateLimitFloor ?? FIND_USER_BEER_RATE_FLOOR;
    let offset = 0;
    let scanned = 0;
    let requestsUsed = 0;
    let totalDistinctBeers: number | null = null;
    let locked = false;

    for (let page = 0; page < maxRequests; page += 1) {
      const response = (await this.getUserBeers(
        username,
        { limit: pageSize, offset, sort: options.sort, startDate: options.startDate, endDate: options.endDate },
        options.accessToken
      )) as {
        total_count?: number;
        is_locked?: number | boolean;
        beers?: { items?: UserBeerItem[] };
      };
      requestsUsed += 1;
      if (typeof response.total_count === 'number') {
        totalDistinctBeers = response.total_count;
      }
      locked = Boolean(response.is_locked);
      const items = response.beers?.items ?? [];

      const hit = items.find(item => item?.beer?.bid === beerId);
      if (hit) {
        return {
          username,
          beerId,
          found: true,
          exhausted: false,
          locked,
          stoppedForRateLimit: false,
          scannedDistinctBeers: scanned + items.indexOf(hit) + 1,
          totalDistinctBeers,
          requestsUsed,
          match: {
            beerId,
            beerName: hit.beer?.beer_name ?? null,
            breweryName: hit.brewery?.brewery_name ?? null,
            userRating: ratingOrNull(hit.rating_score),
            checkinCount: numberOrNull(hit.count),
            firstHadAt: hit.first_created_at ?? hit.first_had ?? null,
            lastHadAt: hit.recent_created_at ?? null,
            firstCheckinId: numberOrNull(hit.first_checkin_id),
          },
        };
      }

      scanned += items.length;
      offset += items.length;
      const reachedEnd =
        items.length < pageSize || (totalDistinctBeers !== null && offset >= totalDistinctBeers);
      if (reachedEnd) {
        return {
          username,
          beerId,
          found: false,
          exhausted: true,
          locked,
          stoppedForRateLimit: false,
          scannedDistinctBeers: scanned,
          totalDistinctBeers,
          requestsUsed,
          match: null,
        };
      }

      if (
        this.lastRateLimit &&
        this.lastRateLimit.remaining <= rateLimitFloor &&
        page < maxRequests - 1
      ) {
        return {
          username,
          beerId,
          found: false,
          exhausted: false,
          locked,
          stoppedForRateLimit: true,
          scannedDistinctBeers: scanned,
          totalDistinctBeers,
          requestsUsed,
          match: null,
        };
      }
    }

    return {
      username,
      beerId,
      found: false,
      exhausted: false,
      locked,
      stoppedForRateLimit: false,
      scannedDistinctBeers: scanned,
      totalDistinctBeers,
      requestsUsed,
      match: null,
    };
  }

  async checkIn(input: {
    accessToken: string;
    beerId: number;
    rating?: number;
    shout?: string;
    timezone: string;
    gmtOffset: number;
  }): Promise<unknown> {
    const url = new URL('checkin/add', UntappdClient.apiBaseUrl);
    url.searchParams.set('access_token', input.accessToken);
    const body = new URLSearchParams({
      bid: String(input.beerId),
      gmt_offset: String(input.gmtOffset),
      timezone: input.timezone,
    });
    if (input.rating !== undefined) {
      body.set('rating', formatRating(input.rating));
    }
    if (input.shout) {
      body.set('shout', input.shout);
    }
    const payload = await this.fetchJson<unknown>(
      url,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      },
      'checkin/add'
    );
    return payload.response;
  }

  /**
   * The latest Untappd rate-limit headers plus this process's own call counters.
   * Reads local state only — makes no Untappd request.
   */
  getUsageSnapshot(): UntappdApiUsageSnapshot {
    const now = Date.now();
    const cutoff = now - UntappdClient.rateWindowMs;
    return {
      lastSeen: this.lastRateLimit
        ? {
            limit: this.lastRateLimit.limit,
            remaining: this.lastRateLimit.remaining,
            observedAt: new Date(this.lastRateLimit.observedAt).toISOString(),
            ageSeconds: Math.round((now - this.lastRateLimit.observedAt) / 1000),
            endpoint: this.lastRateLimit.endpoint,
          }
        : null,
      instance: {
        callsLastHour: this.callTimestamps.filter(timestamp => timestamp >= cutoff).length,
        callsSinceStart: this.totalCallsSinceStart,
        startedAt: new Date(this.startedAt).toISOString(),
        uptimeSeconds: Math.round((now - this.startedAt) / 1000),
      },
      note: USAGE_NOTE,
    };
  }

  private async get(
    path: string,
    query: Record<string, string>,
    accessToken?: string
  ): Promise<unknown> {
    const url = new URL(path, UntappdClient.apiBaseUrl);
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, value);
    }
    if (accessToken) {
      url.searchParams.set('access_token', accessToken);
    } else {
      url.searchParams.set('client_id', this.config.clientId);
      url.searchParams.set('client_secret', this.config.clientSecret);
    }
    const payload = await this.fetchJson<unknown>(url, { method: 'GET' }, path);
    return payload.response;
  }

  private recordRateLimit(endpoint: string, headers: Headers): void {
    const limitRaw = headers.get('x-ratelimit-limit');
    const remainingRaw = headers.get('x-ratelimit-remaining');
    if (limitRaw === null || remainingRaw === null) {
      return;
    }
    const limit = Number(limitRaw);
    const remaining = Number(remainingRaw);
    if (!Number.isFinite(limit) || !Number.isFinite(remaining)) {
      return;
    }
    const now = Date.now();
    this.totalCallsSinceStart += 1;
    this.callTimestamps.push(now);
    const cutoff = now - UntappdClient.rateWindowMs;
    while (this.callTimestamps.length > 0 && this.callTimestamps[0] < cutoff) {
      this.callTimestamps.shift();
    }
    this.lastRateLimit = { limit, remaining, observedAt: now, endpoint };
    console.log(
      JSON.stringify({
        message: 'untappd_api_call',
        endpoint,
        rateLimit: limit,
        rateLimitRemaining: remaining,
        instanceCallsLastHour: this.callTimestamps.length,
        instanceCallsSinceStart: this.totalCallsSinceStart,
      })
    );
  }

  private async fetchJson<T>(url: URL, init: RequestInit, endpoint: string): Promise<UntappdEnvelope<T>> {
    const response = await this.fetchImpl(url, {
      ...init,
      headers: {
        'User-Agent': this.config.userAgent,
        Accept: 'application/json',
        ...init.headers,
      },
    });
    this.recordRateLimit(endpoint, response.headers);
    const payload = (await response.json().catch(() => null)) as UntappdEnvelope<T> | null;
    const apiCode = payload?.meta?.code;
    if (!response.ok || (apiCode !== undefined && apiCode >= 400)) {
      throw new UntappdApiError(
        payload?.meta?.developer_friendly ||
          payload?.meta?.error_detail ||
          `Untappd request failed with HTTP ${response.status}`,
        response.status,
        endpoint
      );
    }
    if (!payload) {
      throw new UntappdApiError('Untappd returned an invalid JSON response', 502, endpoint);
    }
    return payload;
  }
}
