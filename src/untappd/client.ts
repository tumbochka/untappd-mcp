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
