import assert from 'node:assert/strict';
import test from 'node:test';
import { UntappdClient } from '../src/untappd/client.js';

const config = {
  clientId: 'client-id',
  clientSecret: 'client-secret',
  redirectUri: 'https://example.com/callback',
  userAgent: 'untappd-mcp-test/0',
};

function jsonResponse(body: unknown, extraHeaders: Record<string, string> = {}, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...extraHeaders },
  });
}

function algoliaResponse(hits: unknown[], status = 200): Response {
  return new Response(JSON.stringify({ hits }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const algoliaHit = {
  bid: 4473,
  beer_name: 'Guinness Draught',
  beer_abv: 4.2,
  beer_ibu: 45,
  brewery_name: 'Guinness',
  brewery_id: 49,
  type_name: 'Stout - Irish Dry',
  rating_score: 3.77,
  rating_count: 993_774,
  beer_slug: 'guinness-guinness-draught',
  beer_label: 'https://assets.untappd.com/site/beer_logos/beer-4473_1cbe8_sm.jpeg',
  alias_alt: ['guinness draft', 'guines'],
  brewery_alias: ['guiness'],
};

function userBeersPage(items: Array<{ bid: number; rating?: number; count?: number }>, totalCount: number) {
  return {
    meta: { code: 200 },
    response: {
      total_count: totalCount,
      beers: {
        count: items.length,
        items: items.map(item => ({
          first_checkin_id: item.bid * 10,
          first_created_at: 'Mon, 01 Jan 2024 12:00:00 +0000',
          recent_created_at: 'Tue, 02 Jan 2024 12:00:00 +0000',
          rating_score: item.rating ?? 0,
          count: item.count ?? 1,
          beer: { bid: item.bid, beer_name: `Beer ${item.bid}` },
          brewery: { brewery_name: `Brewery ${item.bid}` },
        })),
      },
    },
  };
}

test('findUserBeer returns a match with the queried user rating and dates', async () => {
  const calls: string[] = [];
  const fetchImpl = (async (input: string | URL) => {
    const url = new URL(input);
    calls.push(url.searchParams.get('offset') ?? '');
    const offset = Number(url.searchParams.get('offset'));
    if (offset === 0) {
      return jsonResponse(userBeersPage([{ bid: 111 }, { bid: 222, rating: 4.5, count: 3 }], 4));
    }
    return jsonResponse(userBeersPage([{ bid: 333 }, { bid: 444 }], 4));
  }) as unknown as typeof fetch;

  const client = new UntappdClient(config, fetchImpl);
  const result = await client.findUserBeer('someone', 222);

  assert.equal(result.found, true);
  assert.equal(result.locked, false);
  assert.equal(result.match?.beerName, 'Beer 222');
  assert.equal(result.match?.breweryName, 'Brewery 222');
  assert.equal(result.match?.userRating, 4.5);
  assert.equal(result.match?.checkinCount, 3);
  assert.equal(result.match?.firstCheckinId, 2220);
  assert.equal(result.scannedDistinctBeers, 2);
  assert.equal(result.requestsUsed, 1);
  assert.deepEqual(calls, ['0']);
});

test('findUserBeer pages until the distinct list is exhausted', async () => {
  let requests = 0;
  const fetchImpl = (async (input: string | URL) => {
    const offset = Number(new URL(input).searchParams.get('offset'));
    requests += 1;
    const bids =
      offset === 0
        ? Array.from({ length: 50 }, (_, i) => ({ bid: i + 1 }))
        : Array.from({ length: 10 }, (_, i) => ({ bid: i + 51 }));
    return jsonResponse(userBeersPage(bids, 60));
  }) as unknown as typeof fetch;

  const client = new UntappdClient(config, fetchImpl);
  const result = await client.findUserBeer('someone', 999, { maxRequests: 10 });

  assert.equal(result.found, false);
  assert.equal(result.exhausted, true);
  assert.equal(result.scannedDistinctBeers, 60);
  assert.equal(result.totalDistinctBeers, 60);
  assert.equal(requests, 2);
});

test('findUserBeer stops at maxRequests and reports an inconclusive result', async () => {
  const fetchImpl = (async () =>
    jsonResponse(
      userBeersPage(
        Array.from({ length: 50 }, (_, index) => ({ bid: index + 1 })),
        5000
      )
    )) as unknown as typeof fetch;

  const client = new UntappdClient(config, fetchImpl);
  const result = await client.findUserBeer('someone', 999999, { maxRequests: 3 });

  assert.equal(result.found, false);
  assert.equal(result.exhausted, false);
  assert.equal(result.requestsUsed, 3);
  assert.equal(result.scannedDistinctBeers, 150);
});

test('getUserBeers passes username, date window, and sort through to the API', async () => {
  let requested: URL | undefined;
  const fetchImpl = (async (input: string | URL) => {
    requested = new URL(input);
    return jsonResponse({ meta: { code: 200 }, response: { beers: { items: [] } } });
  }) as unknown as typeof fetch;

  const client = new UntappdClient(config, fetchImpl);
  await client.getUserBeers(
    'a.user-name',
    { limit: 50, offset: 100, sort: 'highest_rated', startDate: '2023-01-01', endDate: '2023-12-31' },
    'user-token'
  );

  assert.equal(requested?.pathname, '/v4/user/beers/a.user-name');
  assert.equal(requested?.searchParams.get('limit'), '50');
  assert.equal(requested?.searchParams.get('offset'), '100');
  assert.equal(requested?.searchParams.get('sort'), 'highest_rated');
  assert.equal(requested?.searchParams.get('start_date'), '2023-01-01');
  assert.equal(requested?.searchParams.get('end_date'), '2023-12-31');
  assert.equal(requested?.searchParams.get('access_token'), 'user-token');
});

test('getUserInfo falls back to client credentials when no token is supplied', async () => {
  let requested: URL | undefined;
  const fetchImpl = (async (input: string | URL) => {
    requested = new URL(input);
    return jsonResponse({ meta: { code: 200 }, response: { user: {} } });
  }) as unknown as typeof fetch;

  const client = new UntappdClient(config, fetchImpl);
  await client.getUserInfo('someone');

  assert.equal(requested?.pathname, '/v4/user/info/someone');
  assert.equal(requested?.searchParams.get('client_id'), 'client-id');
  assert.equal(requested?.searchParams.get('client_secret'), 'client-secret');
  assert.equal(requested?.searchParams.get('access_token'), null);
});

test('searchBeers queries the public Algolia index and normalizes hits', async () => {
  let request: { url: URL; init: RequestInit } | undefined;
  const fetchImpl = (async (input: string | URL, init: RequestInit) => {
    request = { url: new URL(input), init };
    return algoliaResponse([algoliaHit, { beer_name: 'no bid, dropped' }]);
  }) as unknown as typeof fetch;

  const client = new UntappdClient(config, fetchImpl);
  const results = await client.searchBeers('Guinness Draught', 5);

  assert.equal(request?.url.host, '9wbo4rq3ho-dsn.algolia.net');
  assert.equal(request?.url.pathname, '/1/indexes/beer/query');
  assert.equal(request?.init.method, 'POST');
  const headers = new Headers(request?.init.headers);
  assert.equal(headers.get('x-algolia-application-id'), '9WBO4RQ3HO');
  assert.equal(headers.get('x-algolia-api-key'), '1d347324d67ec472bb7132c66aead485');
  assert.deepEqual(JSON.parse(String(request?.init.body)), { query: 'Guinness Draught', hitsPerPage: 5 });

  assert.equal(results.length, 1);
  assert.deepEqual(results[0], {
    bid: 4473,
    beerName: 'Guinness Draught',
    brewery: { id: 49, name: 'Guinness' },
    style: 'Stout - Irish Dry',
    abv: 4.2,
    ibu: 45,
    globalRating: 3.77,
    ratingCount: 993_774,
    slug: 'guinness-guinness-draught',
    labelUrl: 'https://assets.untappd.com/site/beer_logos/beer-4473_1cbe8_sm.jpeg',
    aliases: ['guinness draft', 'guines', 'guiness'],
    source: 'algolia',
  });
});

test('searchBeers does not call the Untappd API on the Algolia happy path', async () => {
  const hosts: string[] = [];
  const fetchImpl = (async (input: string | URL) => {
    hosts.push(new URL(input).host);
    return algoliaResponse([algoliaHit]);
  }) as unknown as typeof fetch;

  await new UntappdClient(config, fetchImpl).searchBeers('stout', 10);

  assert.ok(!hosts.includes('api.untappd.com'));
});

for (const failure of [401, 403, 500] as const) {
  test(`searchBeers falls back to the Untappd search API on Algolia HTTP ${failure}`, async () => {
    const hosts: string[] = [];
    const fetchImpl = (async (input: string | URL) => {
      const url = new URL(input);
      hosts.push(url.host);
      if (url.host.endsWith('algolia.net')) {
        return algoliaResponse([], failure);
      }
      return jsonResponse({
        meta: { code: 200 },
        response: {
          beers: {
            items: [
              {
                beer: {
                  bid: 5,
                  beer_name: 'Fallback Stout',
                  beer_style: 'Stout',
                  beer_abv: 6,
                  beer_slug: 'fallback-stout',
                },
                brewery: { brewery_id: 9, brewery_name: 'Fallback Brewery' },
              },
            ],
          },
        },
      });
    }) as unknown as typeof fetch;

    const results = await new UntappdClient(config, fetchImpl).searchBeers('stout', 10);

    assert.ok(hosts.includes('api.untappd.com'));
    assert.equal(results.length, 1);
    assert.equal(results[0].bid, 5);
    assert.equal(results[0].source, 'untappd-api');
    assert.equal(results[0].style, 'Stout');
    assert.deepEqual(results[0].aliases, []);
  });
}

test('searchBeers falls back when the Algolia request throws', async () => {
  let untappdCalled = false;
  const fetchImpl = (async (input: string | URL) => {
    const url = new URL(input);
    if (url.host.endsWith('algolia.net')) {
      throw new Error('network down');
    }
    untappdCalled = true;
    return jsonResponse({ meta: { code: 200 }, response: { beers: { items: [] } } });
  }) as unknown as typeof fetch;

  const results = await new UntappdClient(config, fetchImpl).searchBeers('stout', 10);

  assert.ok(untappdCalled);
  assert.deepEqual(results, []);
});

test('searchBeers surfaces a genuine Untappd error from the fallback path', async () => {
  const fetchImpl = (async (input: string | URL) => {
    const url = new URL(input);
    if (url.host.endsWith('algolia.net')) {
      return algoliaResponse([], 503);
    }
    return jsonResponse({ meta: { code: 500, error_detail: 'boom' } }, {}, 500);
  }) as unknown as typeof fetch;

  await assert.rejects(new UntappdClient(config, fetchImpl).searchBeers('stout', 10), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { endpoint?: string }).endpoint, 'search/beer');
    return true;
  });
});

test('searchBeers honours configured Algolia key overrides', async () => {
  let host: string | undefined;
  let key: string | null | undefined;
  const fetchImpl = (async (input: string | URL, init: RequestInit) => {
    host = new URL(input).host;
    key = new Headers(init.headers).get('x-algolia-api-key');
    return algoliaResponse([algoliaHit]);
  }) as unknown as typeof fetch;

  const client = new UntappdClient(
    { ...config, algolia: { appId: 'TESTAPP', searchKey: 'testkey' } },
    fetchImpl
  );
  await client.searchBeers('stout', 5);

  assert.equal(host, 'testapp-dsn.algolia.net');
  assert.equal(key, 'testkey');
});

test('checkIn snaps ratings to the quarter grid and drops float artefacts', async () => {
  const sent: string[] = [];
  const fetchImpl = (async (input: string | URL, init: RequestInit) => {
    sent.push(String(new URLSearchParams(init.body as string).get('rating')));
    return jsonResponse({ meta: { code: 200 }, response: { checkin_id: 1 } });
  }) as unknown as typeof fetch;

  const client = new UntappdClient(config, fetchImpl);
  const base = { accessToken: 't', beerId: 1, timezone: 'EST', gmtOffset: -5 };
  await client.checkIn({ ...base, rating: 3.25 });
  await client.checkIn({ ...base, rating: 3.75 });
  await client.checkIn({ ...base, rating: 0.25 * 3 + 3 });

  assert.deepEqual(sent, ['3.25', '3.75', '3.75']);
});

test('checkIn omits the rating when none is given', async () => {
  let body: URLSearchParams | undefined;
  const fetchImpl = (async (_input: string | URL, init: RequestInit) => {
    body = new URLSearchParams(init.body as string);
    return jsonResponse({ meta: { code: 200 }, response: {} });
  }) as unknown as typeof fetch;

  await new UntappdClient(config, fetchImpl).checkIn({
    accessToken: 't',
    beerId: 1,
    timezone: 'EST',
    gmtOffset: -5,
  });

  assert.equal(body?.has('rating'), false);
});

test('rate-limit headers are captured from successful and error responses', async () => {
  const client = new UntappdClient(config, (async (input: string | URL) => {
    const remaining = new URL(input).pathname.endsWith('/1') ? '97' : '0';
    return jsonResponse(
      { meta: { code: 200 }, response: {} },
      { 'x-ratelimit-limit': '100', 'x-ratelimit-remaining': remaining }
    );
  }) as unknown as typeof fetch);

  assert.equal(client.getUsageSnapshot().lastSeen, null);

  await client.getBeer(1);
  let snapshot = client.getUsageSnapshot();
  assert.equal(snapshot.lastSeen?.limit, 100);
  assert.equal(snapshot.lastSeen?.remaining, 97);
  assert.equal(snapshot.lastSeen?.endpoint, 'beer/info/1');
  assert.equal(snapshot.instance.callsSinceStart, 1);

  const erroring = new UntappdClient(config, (async () =>
    jsonResponse({ meta: { code: 429, error_detail: 'slow down' } }, {
      'x-ratelimit-limit': '100',
      'x-ratelimit-remaining': '0',
    }, 429)) as unknown as typeof fetch);
  await assert.rejects(erroring.getBeer(2));
  assert.equal(erroring.getUsageSnapshot().lastSeen?.remaining, 0);
  assert.equal(erroring.getUsageSnapshot().instance.callsSinceStart, 1);
});

test('getUsageSnapshot tolerates responses without rate-limit headers', async () => {
  const client = new UntappdClient(config, (async () =>
    jsonResponse({ meta: { code: 200 }, response: {} })) as unknown as typeof fetch);

  await client.getBeer(1);
  const snapshot = client.getUsageSnapshot();
  assert.equal(snapshot.lastSeen, null);
  assert.equal(snapshot.instance.callsSinceStart, 0);
});

test('findUserBeer stops early when the shared quota runs low', async () => {
  let requests = 0;
  const fetchImpl = (async (input: string | URL) => {
    requests += 1;
    const offset = Number(new URL(input).searchParams.get('offset'));
    return jsonResponse(
      userBeersPage(
        Array.from({ length: 50 }, (_, i) => ({ bid: offset + i + 1 })),
        100_000
      ),
      { 'x-ratelimit-limit': '100', 'x-ratelimit-remaining': '4' }
    );
  }) as unknown as typeof fetch;

  const result = await new UntappdClient(config, fetchImpl).findUserBeer('someone', 999999, {
    maxRequests: 20,
  });

  assert.equal(result.found, false);
  assert.equal(result.exhausted, false);
  assert.equal(result.stoppedForRateLimit, true);
  assert.equal(result.requestsUsed, 1);
  assert.equal(requests, 1);
});

test('findUserBeer keeps paging while the quota is healthy', async () => {
  const fetchImpl = (async (input: string | URL) => {
    const offset = Number(new URL(input).searchParams.get('offset'));
    const bids =
      offset === 0
        ? Array.from({ length: 50 }, (_, i) => ({ bid: i + 1 }))
        : Array.from({ length: 5 }, (_, i) => ({ bid: i + 51 }));
    return jsonResponse(userBeersPage(bids, 55), {
      'x-ratelimit-limit': '100',
      'x-ratelimit-remaining': '80',
    });
  }) as unknown as typeof fetch;

  const result = await new UntappdClient(config, fetchImpl).findUserBeer('someone', 999, {
    maxRequests: 20,
  });

  assert.equal(result.exhausted, true);
  assert.equal(result.stoppedForRateLimit, false);
  assert.equal(result.scannedDistinctBeers, 55);
});

test('checkIn attaches a venue when foursquareId and coordinates are given', async () => {
  let body: URLSearchParams | undefined;
  const fetchImpl = (async (_input: string | URL, init: RequestInit) => {
    body = new URLSearchParams(init.body as string);
    return jsonResponse({ meta: { code: 200 }, response: { checkin_id: 1 } });
  }) as unknown as typeof fetch;

  await new UntappdClient(config, fetchImpl).checkIn({
    accessToken: 't',
    beerId: 5,
    timezone: 'Europe/Kyiv',
    gmtOffset: 3,
    foursquareId: '4c345f93452620a1e6f3240f',
    geolat: 46.4659424,
    geolng: 30.7313004,
  });

  assert.equal(body?.get('foursquare_id'), '4c345f93452620a1e6f3240f');
  assert.equal(body?.get('geolat'), '46.4659424');
  assert.equal(body?.get('geolng'), '30.7313004');
});

test('checkIn omits venue params when foursquareId is not given', async () => {
  let body: URLSearchParams | undefined;
  const fetchImpl = (async (_input: string | URL, init: RequestInit) => {
    body = new URLSearchParams(init.body as string);
    return jsonResponse({ meta: { code: 200 }, response: {} });
  }) as unknown as typeof fetch;

  await new UntappdClient(config, fetchImpl).checkIn({ accessToken: 't', beerId: 5, timezone: 'EST', gmtOffset: -5 });

  assert.equal(body?.has('foursquare_id'), false);
  assert.equal(body?.has('geolat'), false);
});

function checkinFeedPage(
  venues: Array<{ id: number; name: string; fsq?: string } | null>,
  maxId: number | false
) {
  return {
    meta: { code: 200 },
    response: {
      pagination: { max_id: maxId },
      checkins: {
        items: venues.map((v, i) => ({
          created_at: `day-${i}`,
          venue: v
            ? {
                venue_id: v.id,
                venue_name: v.name,
                foursquare: v.fsq ? { foursquare_id: v.fsq } : undefined,
                location: { venue_city: 'Kyiv', venue_country: 'Ukraine', lat: 50.4, lng: 30.5 },
              }
            : [],
        })),
      },
    },
  };
}

test('listRecentVenues dedupes venues, counts repeats, and skips venueless check-ins', async () => {
  const fetchImpl = (async (input: string | URL) => {
    const maxId = new URL(input).searchParams.get('max_id');
    if (!maxId) {
      return jsonResponse(
        checkinFeedPage(
          [
            { id: 1, name: 'The Pub', fsq: 'a'.repeat(24) },
            null,
            { id: 1, name: 'The Pub', fsq: 'a'.repeat(24) },
            { id: 2, name: 'Taproom', fsq: 'b'.repeat(24) },
            ...Array.from({ length: 21 }, () => null),
          ],
          999
        )
      );
    }
    return jsonResponse(checkinFeedPage([{ id: 3, name: 'Bar', fsq: 'c'.repeat(24) }], false));
  }) as unknown as typeof fetch;

  const result = await new UntappdClient(config, fetchImpl).listRecentVenues('token', { maxRequests: 5 });

  assert.equal(result.venues.length, 3);
  assert.equal(result.requestsUsed, 2);
  assert.equal(result.scannedCheckins, 26);
  const pub = result.venues.find(v => v.untappdVenueId === 1);
  assert.equal(pub?.checkinCount, 2);
  assert.equal(pub?.foursquareId, 'a'.repeat(24));
  assert.equal(pub?.lastCheckinAt, 'day-0');
});

test('listRecentVenues stops once it has enough distinct venues', async () => {
  let requests = 0;
  const fetchImpl = (async () => {
    requests += 1;
    return jsonResponse(
      checkinFeedPage(
        Array.from({ length: 25 }, (_, i) => ({ id: requests * 100 + i, name: `V${i}`, fsq: 'd'.repeat(24) })),
        999
      )
    );
  }) as unknown as typeof fetch;

  const result = await new UntappdClient(config, fetchImpl).listRecentVenues('token', { limit: 10, maxRequests: 5 });

  assert.equal(result.venues.length, 10);
  assert.equal(requests, 1);
});

test('checkOwnBeer reports a had beer with the token owner rating and count', async () => {
  let requested: URL | undefined;
  const fetchImpl = (async (input: string | URL) => {
    requested = new URL(input);
    return jsonResponse({
      meta: { code: 200 },
      response: {
        beer: {
          bid: 4473,
          beer_name: 'Guinness Draught',
          brewery: { brewery_name: 'Guinness' },
          auth_rating: 3.5,
          wish_list: true,
          stats: { total_user_count: 1107460, user_count: 2 },
        },
      },
    });
  }) as unknown as typeof fetch;

  const result = await new UntappdClient(config, fetchImpl).checkOwnBeer(4473, 'user-token');

  assert.equal(requested?.pathname, '/v4/beer/info/4473');
  assert.equal(requested?.searchParams.get('access_token'), 'user-token');
  assert.deepEqual(result, {
    beerId: 4473,
    beerName: 'Guinness Draught',
    breweryName: 'Guinness',
    hadIt: true,
    userRating: 3.5,
    userCheckinCount: 2,
    onWishlist: true,
  });
});

test('checkOwnBeer reports a not-had beer', async () => {
  const fetchImpl = (async () =>
    jsonResponse({
      meta: { code: 200 },
      response: {
        beer: { bid: 131332, beer_name: 'Kentucky Brunch', auth_rating: 0, wish_list: false, stats: { user_count: 0 } },
      },
    })) as unknown as typeof fetch;

  const result = await new UntappdClient(config, fetchImpl).checkOwnBeer(131332, 't');

  assert.equal(result.hadIt, false);
  assert.equal(result.userRating, null);
  assert.equal(result.userCheckinCount, 0);
  assert.equal(result.onWishlist, false);
});

test('checkOwnBeer treats a rating with no stats block as had', async () => {
  const fetchImpl = (async () =>
    jsonResponse({
      meta: { code: 200 },
      response: { beer: { bid: 1, beer_name: 'X', auth_rating: 4 } },
    })) as unknown as typeof fetch;

  const result = await new UntappdClient(config, fetchImpl).checkOwnBeer(1, 't');
  assert.equal(result.hadIt, true);
  assert.equal(result.userRating, 4);
});

test('getUserFriends passes username, limit and offset to user/friends', async () => {
  let requested: URL | undefined;
  const fetchImpl = (async (input: string | URL) => {
    requested = new URL(input);
    return jsonResponse({ meta: { code: 200 }, response: { count: 0, items: [] } });
  }) as unknown as typeof fetch;

  await new UntappdClient(config, fetchImpl).getUserFriends('a.user', { limit: 25, offset: 50 }, 'tok');

  assert.equal(requested?.pathname, '/v4/user/friends/a.user');
  assert.equal(requested?.searchParams.get('limit'), '25');
  assert.equal(requested?.searchParams.get('offset'), '50');
  assert.equal(requested?.searchParams.get('access_token'), 'tok');
});

test('getUserFriends targets the authenticated user when username is empty', async () => {
  let requested: URL | undefined;
  const fetchImpl = (async (input: string | URL) => {
    requested = new URL(input);
    return jsonResponse({ meta: { code: 200 }, response: { count: 0, items: [] } });
  }) as unknown as typeof fetch;

  await new UntappdClient(config, fetchImpl).getUserFriends('', { limit: 10, offset: 0 }, 'tok');

  assert.equal(requested?.pathname, '/v4/user/friends/');
  assert.equal(requested?.searchParams.get('access_token'), 'tok');
});
