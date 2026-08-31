export type UntappdClientConfig = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  userAgent: string;
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

function ratingOrNull(value: unknown): number | null {
  return typeof value === 'number' && value > 0 ? value : null;
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

export class UntappdClient {
  private static readonly apiBaseUrl = 'https://api.untappd.com/v4/';
  private static readonly oauthAuthenticateUrl = 'https://untappd.com/oauth/authenticate/';
  private static readonly oauthAuthorizeUrl = 'https://untappd.com/oauth/authorize/';

  constructor(
    private readonly config: UntappdClientConfig,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

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

  async searchBeers(query: string, limit: number, accessToken?: string): Promise<unknown> {
    return this.get('search/beer', { q: query, limit: String(limit) }, accessToken);
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
   * is exhausted. `maxRequests` caps the paging to protect the hourly API quota.
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
    } = {}
  ): Promise<UserBeerLookup> {
    const pageSize = 50;
    const maxRequests = Math.max(1, Math.min(options.maxRequests ?? 12, 40));
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
      body.set('rating', String(input.rating));
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

  private async fetchJson<T>(url: URL, init: RequestInit, endpoint: string): Promise<UntappdEnvelope<T>> {
    const response = await this.fetchImpl(url, {
      ...init,
      headers: {
        'User-Agent': this.config.userAgent,
        Accept: 'application/json',
        ...init.headers,
      },
    });
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
