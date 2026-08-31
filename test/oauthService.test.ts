import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CLAUDE_PRE_REGISTERED_CLIENT_ID,
  McpOAuthService,
  OAuthProtocolError,
  type OAuthAuthorizationRequest,
} from '../src/oauth/service.js';
import {
  type AccessToken,
  type AuthorizationCode,
  type AuthorizationTransaction,
  type ConsumedRefreshToken,
  type OAuthClient,
  type OAuthStore,
  type RefreshToken,
} from '../src/oauth/store.js';

class MemoryOAuthStore implements OAuthStore {
  clients = new Map<string, OAuthClient>();
  transactions = new Map<string, AuthorizationTransaction>();
  codes = new Map<string, AuthorizationCode>();
  accessTokens = new Map<string, AccessToken>();
  refreshTokens = new Map<string, RefreshToken & { used?: boolean; revoked?: boolean }>();

  async createClient(client: OAuthClient): Promise<void> {
    this.clients.set(client.clientId, client);
  }

  async getClient(clientId: string): Promise<OAuthClient | null> {
    return this.clients.get(clientId) ?? null;
  }

  async createAuthorizationTransaction(transaction: AuthorizationTransaction): Promise<void> {
    this.transactions.set(transaction.id, transaction);
  }

  async consumeAuthorizationTransaction(id: string, now: number): Promise<AuthorizationTransaction | null> {
    const transaction = this.transactions.get(id) ?? null;
    this.transactions.delete(id);
    return transaction && transaction.expiresAt > now ? transaction : null;
  }

  async createAuthorizationCode(codeHash: string, code: AuthorizationCode): Promise<void> {
    this.codes.set(codeHash, code);
  }

  async consumeAuthorizationCode(codeHash: string, now: number): Promise<AuthorizationCode | null> {
    const code = this.codes.get(codeHash) ?? null;
    this.codes.delete(codeHash);
    return code && code.expiresAt > now ? code : null;
  }

  async createAccessToken(tokenHash: string, token: AccessToken): Promise<void> {
    this.accessTokens.set(tokenHash, token);
  }

  async getAccessToken(tokenHash: string, now: number): Promise<AccessToken | null> {
    const token = this.accessTokens.get(tokenHash) ?? null;
    return token && token.expiresAt > now ? token : null;
  }

  async createRefreshToken(tokenHash: string, token: RefreshToken): Promise<void> {
    this.refreshTokens.set(tokenHash, { ...token });
  }

  async consumeRefreshToken(
    tokenHash: string,
    clientId: string,
    resource: string,
    now: number
  ): Promise<ConsumedRefreshToken | null> {
    const token = this.refreshTokens.get(tokenHash);
    if (!token || token.expiresAt <= now || token.clientId !== clientId || token.resource !== resource || token.revoked) {
      return null;
    }
    if (token.used) {
      return { status: 'reused', token };
    }
    token.used = true;
    return { status: 'valid', token };
  }

  async revokeRefreshTokenFamily(familyId: string): Promise<void> {
    for (const token of this.refreshTokens.values()) {
      if (token.familyId === familyId) {
        token.revoked = true;
      }
    }
  }
}

function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

async function createAuthorizationRequest(
  oauth: McpOAuthService,
  clientId: string,
  verifier: string
): Promise<OAuthAuthorizationRequest> {
  return oauth.validateAuthorizationRequest(
    new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: 'http://127.0.0.1:4815/callback',
      resource: oauth.resource,
      scope: 'untappd:read untappd:write',
      state: 'client-state',
      code_challenge: pkceChallenge(verifier),
      code_challenge_method: 'S256',
    })
  );
}

test('OAuth code grant is PKCE-bound, resource-bound, and refreshes with rotation', async () => {
  const store = new MemoryOAuthStore();
  const oauth = new McpOAuthService(store, new URL('https://untappd-mcp.example.com'), 900, 3600);
  const client = await oauth.registerClient({
    client_name: 'MCP Inspector',
    redirect_uris: ['http://127.0.0.1:4815/callback'],
    token_endpoint_auth_method: 'none',
  });
  const verifier = 'a'.repeat(64);
  const request = await createAuthorizationRequest(oauth, client.clientId, verifier);
  const transaction = await oauth.createAuthorizationTransaction(request, 'firebase-user-123');
  const approved = await oauth.approveAuthorizationTransaction(transaction.id, 'firebase-user-123');

  const token = await oauth.exchangeAuthorizationCode(
    new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: client.clientId,
      code: approved.code,
      redirect_uri: approved.redirectUri,
      resource: oauth.resource,
      code_verifier: verifier,
    })
  );
  assert.equal(token.token_type, 'Bearer');
  assert.equal(token.scope, 'untappd:read untappd:write');
  assert.equal((await oauth.authenticate(`Bearer ${token.access_token}`)).firebaseUid, 'firebase-user-123');

  const refreshed = await oauth.refresh(
    new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: client.clientId,
      resource: oauth.resource,
      refresh_token: token.refresh_token,
    })
  );
  assert.notEqual(refreshed.refresh_token, token.refresh_token);
  assert.equal((await oauth.authenticate(`Bearer ${refreshed.access_token}`)).clientId, client.clientId);

  await assert.rejects(
    () =>
      oauth.refresh(
        new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: client.clientId,
          resource: oauth.resource,
          refresh_token: token.refresh_token,
        })
      ),
    (error: unknown) => error instanceof OAuthProtocolError && error.error === 'invalid_grant'
  );
});

test('OAuth grant refuses a code with the wrong PKCE verifier', async () => {
  const store = new MemoryOAuthStore();
  const oauth = new McpOAuthService(store, new URL('https://untappd-mcp.example.com'), 900, 3600);
  const client = await oauth.registerClient({ redirect_uris: ['http://127.0.0.1:4815/callback'] });
  const request = await createAuthorizationRequest(oauth, client.clientId, 'b'.repeat(64));
  const transaction = await oauth.createAuthorizationTransaction(request, 'firebase-user-123');
  const approved = await oauth.approveAuthorizationTransaction(transaction.id, 'firebase-user-123');

  await assert.rejects(
    () =>
      oauth.exchangeAuthorizationCode(
        new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: client.clientId,
          code: approved.code,
          redirect_uri: approved.redirectUri,
          resource: oauth.resource,
          code_verifier: 'c'.repeat(64),
        })
      ),
    (error: unknown) => error instanceof OAuthProtocolError && error.error === 'invalid_grant'
  );
});

test('OAuth accepts the validated Claude client metadata document', async () => {
  const store = new MemoryOAuthStore();
  const claudeClientId = 'https://claude.ai/oauth/mcp-oauth-client-metadata';
  const claudeClient: OAuthClient = {
    clientId: claudeClientId,
    clientName: 'Claude',
    redirectUris: ['https://claude.ai/api/mcp/auth_callback'],
    createdAt: 0,
  };
  const oauth = new McpOAuthService(
    store,
    new URL('https://untappd-mcp.example.com'),
    900,
    3600,
    async clientId => (clientId === claudeClientId ? claudeClient : null)
  );
  const verifier = 'd'.repeat(64);
  const request = await oauth.validateAuthorizationRequest(
    new URLSearchParams({
      response_type: 'code',
      client_id: claudeClientId,
      redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
      resource: oauth.resource,
      scope: 'untappd:read',
      code_challenge: pkceChallenge(verifier),
      code_challenge_method: 'S256',
    })
  );

  assert.equal(request.client.clientId, claudeClientId);
  assert.equal(request.redirectUri, 'https://claude.ai/api/mcp/auth_callback');
});

test('OAuth accepts the validated ChatGPT client metadata document with public token exchange', async () => {
  const store = new MemoryOAuthStore();
  const chatGptClientId = 'https://chatgpt.com/oauth/client.json';
  const chatGptClient: OAuthClient = {
    clientId: chatGptClientId,
    clientName: 'ChatGPT',
    redirectUris: ['https://chatgpt.com/connector_platform_oauth_redirect'],
    createdAt: 0,
  };
  const oauth = new McpOAuthService(
    store,
    new URL('https://untappd-mcp.example.com'),
    900,
    3600,
    async clientId => (clientId === chatGptClientId ? chatGptClient : null)
  );
  const verifier = 'f'.repeat(64);
  const request = await oauth.validateAuthorizationRequest(
    new URLSearchParams({
      response_type: 'code',
      client_id: chatGptClientId,
      redirect_uri: 'https://chatgpt.com/connector_platform_oauth_redirect',
      resource: oauth.resource,
      scope: 'untappd:read',
      code_challenge: pkceChallenge(verifier),
      code_challenge_method: 'S256',
    })
  );

  assert.equal(request.client.clientId, chatGptClientId);
  assert.equal(request.redirectUri, 'https://chatgpt.com/connector_platform_oauth_redirect');
});

test('OAuth accepts the pre-registered public Claude client', async () => {
  const oauth = new McpOAuthService(new MemoryOAuthStore(), new URL('https://untappd-mcp.example.com'), 900, 3600);
  const request = await oauth.validateAuthorizationRequest(
    new URLSearchParams({
      response_type: 'code',
      client_id: CLAUDE_PRE_REGISTERED_CLIENT_ID,
      redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
      resource: oauth.resource,
      scope: 'untappd:read',
      code_challenge: pkceChallenge('e'.repeat(64)),
      code_challenge_method: 'S256',
    })
  );

  assert.equal(request.client.clientId, CLAUDE_PRE_REGISTERED_CLIENT_ID);
  assert.equal(request.redirectUri, 'https://claude.ai/api/mcp/auth_callback');
});
