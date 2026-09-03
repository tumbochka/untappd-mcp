import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { CredentialStore, UntappdCredential } from '../credentials/credentialStore.js';
import { UntappdApiError, UntappdClient } from '../untappd/client.js';
import { checkInRatingSchema } from '../untappd/rating.js';

type UntappdMcpDependencies = {
  firebaseUid: string | undefined;
  scopes: string[];
  untappdConnectUrl: string;
  credentialStore: CredentialStore;
  untappd: UntappdClient;
};

const untappdUsername = z
  .string()
  .min(1)
  .max(51)
  .regex(/^@?[A-Za-z0-9_.-]{1,50}$/, 'Enter a valid Untappd username, e.g. "esodin".')
  .describe('Untappd username of the person to look up (not their display name).');

function normalizeUsername(value: string): string {
  return value.replace(/^@/, '');
}

function jsonResult(data: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
  };
}

function errorResult(code: string, message: string) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ error: code, message }) }],
    isError: true,
  };
}

function hasScope(dependencies: UntappdMcpDependencies, scope: string): boolean {
  return dependencies.scopes.includes(scope);
}

function scopeError(scope: string) {
  return errorResult('MCP_INSUFFICIENT_SCOPE', `Authorize this MCP client with the ${scope} scope.`);
}

function untappdNotConnected(dependencies: UntappdMcpDependencies) {
  return errorResult('UNTAPPD_NOT_CONNECTED', `Connect your Untappd account at ${dependencies.untappdConnectUrl}.`);
}

function handleUntappdError(error: unknown) {
  if (error instanceof UntappdApiError) {
    return errorResult('UNTAPPD_API_ERROR', `${error.endpoint}: ${error.message}`);
  }
  console.error('Unexpected Untappd tool error', error);
  return errorResult('INTERNAL_ERROR', 'The Untappd request could not be completed');
}

async function withCredential<T>(
  dependencies: UntappdMcpDependencies,
  operation: (credential: UntappdCredential) => Promise<T>
) {
  if (!dependencies.firebaseUid) {
    throw new Error('MCP request did not include an authenticated Firebase principal');
  }
  const credential = await dependencies.credentialStore.get(dependencies.firebaseUid);
  if (!credential) {
    return null;
  }
  return operation(credential);
}

export function createUntappdMcpServer(dependencies: UntappdMcpDependencies): McpServer {
  const server = new McpServer({
    name: 'untappd-mcp',
    version: '0.1.0',
    description: 'Find beers and use Untappd as the authenticated caller.',
  });

  server.registerTool(
    'search_beers',
    {
      title: 'Search Untappd beers',
      description:
        'Search Untappd beers by brewery and beer name. Served from Untappd’s public search index, so it does ' +
        'not spend the shared hourly Untappd API quota (it falls back to the Untappd API only if that index is ' +
        'unavailable). Returns { bid, beerName, brewery, style, abv, ibu, globalRating, ratingCount, slug, ' +
        'labelUrl, aliases, source }. Use bid with get_beer, check_in, or check_user_had_beer.',
      inputSchema: z.object({
        query: z.string().min(2).max(200).describe('Prefer “Brewery Name + Beer Name”.'),
        limit: z.number().int().min(1).max(50).default(10),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ query, limit }) => {
      if (!hasScope(dependencies, 'untappd:read')) {
        return scopeError('untappd:read');
      }
      try {
        const credential = dependencies.firebaseUid
          ? await dependencies.credentialStore.get(dependencies.firebaseUid)
          : null;
        return jsonResult(await dependencies.untappd.searchBeers(query, limit, credential?.accessToken));
      } catch (error) {
        return handleUntappdError(error);
      }
    }
  );

  server.registerTool(
    'get_beer',
    {
      title: 'Get beer details',
      description: 'Get extended Untappd information for a beer ID.',
      inputSchema: z.object({ beerId: z.number().int().positive() }),
      annotations: { readOnlyHint: true },
    },
    async ({ beerId }) => {
      if (!hasScope(dependencies, 'untappd:read')) {
        return scopeError('untappd:read');
      }
      try {
        const credential = dependencies.firebaseUid
          ? await dependencies.credentialStore.get(dependencies.firebaseUid)
          : null;
        return jsonResult(await dependencies.untappd.getBeer(beerId, credential?.accessToken));
      } catch (error) {
        return handleUntappdError(error);
      }
    }
  );

  server.registerTool(
    'get_my_profile',
    {
      title: 'Get my Untappd profile',
      description: 'Get the profile for the Untappd account connected to the authenticated MCP user.',
      annotations: { readOnlyHint: true },
    },
    async () => {
      if (!hasScope(dependencies, 'untappd:read')) {
        return scopeError('untappd:read');
      }
      try {
        const profile = await withCredential(dependencies, credential =>
          dependencies.untappd.getCurrentUser(credential.accessToken)
        );
        return profile === null
          ? untappdNotConnected(dependencies)
          : jsonResult(profile);
      } catch (error) {
        return handleUntappdError(error);
      }
    }
  );

  server.registerTool(
    'get_my_wishlist',
    {
      title: 'Get my Untappd wishlist',
      description: 'List beers on the connected Untappd account wishlist.',
      inputSchema: z.object({
        limit: z.number().int().min(1).max(50).default(25),
        offset: z.number().int().min(0).default(0),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ limit, offset }) => {
      if (!hasScope(dependencies, 'untappd:read')) {
        return scopeError('untappd:read');
      }
      try {
        const wishlist = await withCredential(dependencies, credential =>
          dependencies.untappd.getWishlist(credential.accessToken, limit, offset)
        );
        return wishlist === null
          ? untappdNotConnected(dependencies)
          : jsonResult(wishlist);
      } catch (error) {
        return handleUntappdError(error);
      }
    }
  );

  server.registerTool(
    'get_my_beers',
    {
      title: 'Get my distinct beers',
      description: 'List distinct beers checked in by the connected Untappd account.',
      inputSchema: z.object({
        limit: z.number().int().min(1).max(50).default(25),
        offset: z.number().int().min(0).default(0),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ limit, offset }) => {
      if (!hasScope(dependencies, 'untappd:read')) {
        return scopeError('untappd:read');
      }
      try {
        const beers = await withCredential(dependencies, credential =>
          dependencies.untappd.getDistinctBeers(credential.accessToken, limit, offset)
        );
        return beers === null
          ? untappdNotConnected(dependencies)
          : jsonResult(beers);
      } catch (error) {
        return handleUntappdError(error);
      }
    }
  );

  const callerAccessToken = async (): Promise<string | undefined> => {
    if (!dependencies.firebaseUid) {
      return undefined;
    }
    const credential = await dependencies.credentialStore.get(dependencies.firebaseUid);
    return credential?.accessToken;
  };

  server.registerTool(
    'get_user_profile',
    {
      title: 'Get an Untappd user profile',
      description:
        'Get the public Untappd profile and stats (total beers, check-ins, badges) for any username.',
      inputSchema: z.object({ username: untappdUsername }),
      annotations: { readOnlyHint: true },
    },
    async ({ username }) => {
      if (!hasScope(dependencies, 'untappd:read')) {
        return scopeError('untappd:read');
      }
      try {
        return jsonResult(
          await dependencies.untappd.getUserInfo(normalizeUsername(username), await callerAccessToken())
        );
      } catch (error) {
        return handleUntappdError(error);
      }
    }
  );

  server.registerTool(
    'get_user_beers',
    {
      title: 'Get another user’s distinct beers',
      description:
        'List the distinct beers a given Untappd user has checked in, newest first by default. Paginate with offset. Optionally restrict to a date range (YYYY-MM-DD).',
      inputSchema: z.object({
        username: untappdUsername,
        limit: z.number().int().min(1).max(50).default(25),
        offset: z.number().int().min(0).default(0),
        sort: z
          .enum(['date', 'checkin', 'highest_rated', 'lowest_rated', 'highest_rated_you', 'lowest_rated_you'])
          .default('date'),
        startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('YYYY-MM-DD; use together with endDate.'),
        endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('YYYY-MM-DD; use together with startDate.'),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ username, limit, offset, sort, startDate, endDate }) => {
      if (!hasScope(dependencies, 'untappd:read')) {
        return scopeError('untappd:read');
      }
      try {
        return jsonResult(
          await dependencies.untappd.getUserBeers(
            normalizeUsername(username),
            { limit, offset, sort, startDate, endDate },
            await callerAccessToken()
          )
        );
      } catch (error) {
        return handleUntappdError(error);
      }
    }
  );

  server.registerTool(
    'get_user_checkins',
    {
      title: 'Get another user’s recent check-ins',
      description:
        'Return a given Untappd user’s recent check-in activity feed. Page backwards with maxId (the last checkin_id seen).',
      inputSchema: z.object({
        username: untappdUsername,
        limit: z.number().int().min(1).max(25).default(25),
        maxId: z.number().int().positive().optional().describe('Return check-ins older than this checkin_id.'),
        minId: z.number().int().positive().optional().describe('Return check-ins newer than this checkin_id.'),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ username, limit, maxId, minId }) => {
      if (!hasScope(dependencies, 'untappd:read')) {
        return scopeError('untappd:read');
      }
      try {
        return jsonResult(
          await dependencies.untappd.getUserCheckins(
            normalizeUsername(username),
            { limit, maxId, minId },
            await callerAccessToken()
          )
        );
      } catch (error) {
        return handleUntappdError(error);
      }
    }
  );

  server.registerTool(
    'check_user_had_beer',
    {
      title: 'Check whether a user has had a beer',
      description:
        'Answer "has USERNAME ever checked in this beer?" for a specific beer ID (get the ID from search_beers). ' +
        'Returns their rating, how many times, and first/last dates when found. Untappd has no direct lookup, so this ' +
        'pages through the user’s distinct beers: if found is false and exhausted is false the answer is inconclusive — ' +
        'raise maxRequests or narrow with a date range. stoppedForRateLimit: true means the scan was cut short to ' +
        'protect the shared hourly Untappd quota (check get_untappd_api_usage, then retry later). Locked profiles ' +
        'that are not your Untappd friend return locked: true.',
      inputSchema: z.object({
        username: untappdUsername,
        beerId: z.number().int().positive().describe('Untappd beer ID from search_beers or get_beer.'),
        maxRequests: z
          .number()
          .int()
          .min(1)
          .max(40)
          .default(12)
          .describe('Max Untappd API calls to spend paging (50 distinct beers each). Higher = more thorough, more quota.'),
        startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('YYYY-MM-DD; only scan check-ins in this window (with endDate).'),
        endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('YYYY-MM-DD; only scan check-ins in this window (with startDate).'),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ username, beerId, maxRequests, startDate, endDate }) => {
      if (!hasScope(dependencies, 'untappd:read')) {
        return scopeError('untappd:read');
      }
      try {
        return jsonResult(
          await dependencies.untappd.findUserBeer(normalizeUsername(username), beerId, {
            accessToken: await callerAccessToken(),
            maxRequests,
            startDate,
            endDate,
          })
        );
      } catch (error) {
        return handleUntappdError(error);
      }
    }
  );

  server.registerTool(
    'get_untappd_api_usage',
    {
      title: 'Get Untappd API rate-limit usage',
      description:
        'Report the shared Untappd API rate limit (100 requests per rolling hour, shared by every user of this ' +
        'server) and how many remain. Makes no Untappd API call — it reads the rate-limit headers from the most ' +
        'recent Untappd response. lastSeen.remaining is Untappd’s own account-wide figure as of lastSeen.observedAt; ' +
        'instance.* counts only this server process. Check this before a large check_user_had_beer scan.',
      annotations: { readOnlyHint: true },
    },
    async () => {
      if (!hasScope(dependencies, 'untappd:read')) {
        return scopeError('untappd:read');
      }
      return jsonResult(dependencies.untappd.getUsageSnapshot());
    }
  );

  server.registerTool(
    'check_in',
    {
      title: 'Check in a beer on Untappd',
      description:
        'Create a check-in for the connected Untappd account. Ask the user to confirm the beer and rating before ' +
        'calling. rating is 1–5 in steps of 0.1, plus .25 and .75 values (e.g. 3.7 or 3.75).',
      inputSchema: z.object({
        beerId: z.number().int().positive(),
        rating: checkInRatingSchema,
        shout: z.string().max(140).optional(),
        timezone: z.string().min(1).max(64),
        gmtOffset: z.number().min(-12).max(14),
      }),
      annotations: { destructiveHint: false, idempotentHint: false },
    },
    async ({ beerId, rating, shout, timezone, gmtOffset }) => {
      if (!hasScope(dependencies, 'untappd:write')) {
        return scopeError('untappd:write');
      }
      try {
        const checkin = await withCredential(dependencies, credential =>
          dependencies.untappd.checkIn({
            accessToken: credential.accessToken,
            beerId,
            rating,
            shout,
            timezone,
            gmtOffset,
          })
        );
        return checkin === null
          ? untappdNotConnected(dependencies)
          : jsonResult(checkin);
      } catch (error) {
        return handleUntappdError(error);
      }
    }
  );

  return server;
}
