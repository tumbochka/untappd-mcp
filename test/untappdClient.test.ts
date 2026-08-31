import assert from 'node:assert/strict';
import test from 'node:test';
import { UntappdClient } from '../src/untappd/client.js';

const config = {
  clientId: 'client-id',
  clientSecret: 'client-secret',
  redirectUri: 'https://example.com/callback',
  userAgent: 'untappd-mcp-test/0',
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

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
