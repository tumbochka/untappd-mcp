import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { CredentialStore, UntappdCredential } from '../credentials/credentialStore.js';
import { UntappdApiError, UntappdClient } from '../untappd/client.js';

type UntappdMcpDependencies = {
  firebaseUid: string | undefined;
  scopes: string[];
  untappdConnectUrl: string;
  credentialStore: CredentialStore;
  untappd: UntappdClient;
};

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
        'Search Untappd by brewery name and beer name. Use the returned beer ID with get_beer or check_in.',
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

  server.registerTool(
    'check_in',
    {
      title: 'Check in a beer on Untappd',
      description:
        'Create a check-in for the connected Untappd account. Ask the user to confirm the beer and rating before calling.',
      inputSchema: z.object({
        beerId: z.number().int().positive(),
        rating: z.number().min(1).max(5).multipleOf(0.5).optional(),
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
