import { createHash, timingSafeEqual } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import {
  hashOAuthValue,
  randomOAuthValue,
  type AccessToken,
  type AuthorizationTransaction,
  type OAuthClient,
  type OAuthStore,
  type RefreshToken,
} from './store.js';

export const MCP_SCOPES = ['untappd:read', 'untappd:write'] as const;
export type McpScope = (typeof MCP_SCOPES)[number];

const supportedScopes = new Set<string>(MCP_SCOPES);
const claudeClientMetadataUrl = 'https://claude.ai/oauth/mcp-oauth-client-metadata';
const claudeCallbackUrl = 'https://claude.ai/api/mcp/auth_callback';
const chatGptClientMetadataUrl = 'https://chatgpt.com/oauth/client.json';
const chatGptCallbackUrl = 'https://chatgpt.com/connector_platform_oauth_redirect';
const chatGptJwksUrl = 'https://chatgpt.com/oauth/jwks.json';
const clientAssertionType = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';
const chatGptJwks = createRemoteJWKSet(new URL(chatGptJwksUrl));
export const CLAUDE_PRE_REGISTERED_CLIENT_ID = 'untappd-mcp-claude';

const claudePreRegisteredClient: OAuthClient = {
  clientId: CLAUDE_PRE_REGISTERED_CLIENT_ID,
  clientName: 'Claude',
  redirectUris: [claudeCallbackUrl],
  createdAt: 0,
};

export class OAuthProtocolError extends Error {
  constructor(
    readonly error: string,
    message: string,
    readonly status = 400
  ) {
    super(message);
    this.name = 'OAuthProtocolError';
  }
}

export type OAuthAuthorizationRequest = {
  client: OAuthClient;
  redirectUri: string;
  state?: string;
  scopes: McpScope[];
  resource: string;
  codeChallenge: string;
};

export type McpOAuthPrincipal = {
  firebaseUid: string;
  clientId: string;
  scopes: McpScope[];
  expiresAt: number;
  accessToken: string;
};

export type TokenResponse = {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token: string;
  scope: string;
};

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function required(value: string | null, name: string): string {
  if (!value) {
    throw new OAuthProtocolError('invalid_request', `Missing ${name}`);
  }
  return value;
}

function parseScopes(value: string | null): McpScope[] {
  const scopes = (value ?? 'untappd:read')
    .split(/\s+/)
    .filter(Boolean);
  if (!scopes.length || scopes.some(scope => !supportedScopes.has(scope))) {
    throw new OAuthProtocolError('invalid_scope', 'Requested scope is not supported');
  }
  return Array.from(new Set(scopes)) as McpScope[];
}

function parseRedirectUri(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new OAuthProtocolError('invalid_request', 'redirect_uri must be an absolute URL');
  }
  const isLoopback = url.protocol === 'http:' && ['127.0.0.1', '::1', 'localhost'].includes(url.hostname);
  if ((!isLoopback && url.protocol !== 'https:') || url.hash || url.username || url.password) {
    throw new OAuthProtocolError('invalid_request', 'redirect_uri must use HTTPS or a loopback HTTP address');
  }
  return url.toString();
}

function requirePkceChallenge(value: string | null): string {
  const challenge = required(value, 'code_challenge');
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(challenge)) {
    throw new OAuthProtocolError('invalid_request', 'code_challenge is invalid');
  }
  return challenge;
}

function verifyPkce(verifier: string, challenge: string): boolean {
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) {
    return false;
  }
  const calculated = createHash('sha256').update(verifier).digest('base64url');
  const expected = Buffer.from(challenge);
  const actual = Buffer.from(calculated);
  return expected.byteLength === actual.byteLength && timingSafeEqual(expected, actual);
}

function asMcpScopes(scopes: string[]): McpScope[] {
  if (scopes.some(scope => !supportedScopes.has(scope))) {
    throw new Error('Stored OAuth token contains an unsupported scope');
  }
  return scopes as McpScope[];
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string');
}

type TrustedClientMetadata = {
  clientId: string;
  redirectUri: string;
  fallbackName: string;
};

const trustedClientMetadata = new Map<string, TrustedClientMetadata>([
  [
    claudeClientMetadataUrl,
    {
      clientId: claudeClientMetadataUrl,
      redirectUri: claudeCallbackUrl,
      fallbackName: 'Claude',
    },
  ],
  [
    chatGptClientMetadataUrl,
    {
      clientId: chatGptClientMetadataUrl,
      redirectUri: chatGptCallbackUrl,
      fallbackName: 'ChatGPT',
    },
  ],
]);

function chatGptCallbackSpecificMetadata(clientId: string): TrustedClientMetadata | null {
  let url: URL;
  try {
    url = new URL(clientId);
  } catch {
    return null;
  }

  // Without authorization-response issuer identification, ChatGPT uses a
  // callback-specific CIMD URL and a matching callback URL. Accept only that
  // exact, HTTPS-only ChatGPT URL shape so client metadata cannot become an
  // arbitrary outbound fetch target.
  if (url.origin !== 'https://chatgpt.com' || url.search || url.hash) {
    return null;
  }
  const match = url.pathname.match(/^\/oauth\/([A-Za-z0-9._~-]+)\/client\.json$/);
  if (!match) {
    return null;
  }

  const callbackId = match[1];
  return {
    clientId: url.toString(),
    redirectUri: `https://chatgpt.com/connector/oauth/${callbackId}`,
    fallbackName: 'ChatGPT',
  };
}

function trustedClientMetadataFor(clientId: string): TrustedClientMetadata | null {
  return trustedClientMetadata.get(clientId) ?? chatGptCallbackSpecificMetadata(clientId);
}

function isChatGptCimdClient(clientId: string): boolean {
  return clientId === chatGptClientMetadataUrl || chatGptCallbackSpecificMetadata(clientId) !== null;
}

async function verifyChatGptClientAssertion(
  clientId: string,
  clientAssertion: string,
  tokenEndpoint: string,
  issuer: string
): Promise<void> {
  if (!isChatGptCimdClient(clientId)) {
    throw new OAuthProtocolError('invalid_client', 'This client cannot use private_key_jwt', 401);
  }
  try {
    await jwtVerify(clientAssertion, chatGptJwks, {
      algorithms: ['RS256'],
      audience: [tokenEndpoint, issuer],
      issuer: clientId,
      subject: clientId,
      requiredClaims: ['iss', 'sub', 'aud', 'exp', 'jti'],
    });
  } catch {
    throw new OAuthProtocolError('invalid_client', 'Client assertion is invalid', 401);
  }
}

async function resolveTrustedClientMetadata(clientId: string): Promise<OAuthClient | null> {
  const expected = trustedClientMetadataFor(clientId);
  if (!expected) {
    return null;
  }

  let response: Response;
  try {
    response = await fetch(expected.clientId, {
      headers: { accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    throw new OAuthProtocolError('temporarily_unavailable', 'Could not retrieve MCP client metadata', 503);
  }
  if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) {
    throw new OAuthProtocolError('temporarily_unavailable', 'MCP client metadata is unavailable', 503);
  }

  let metadata: unknown;
  try {
    metadata = await response.json();
  } catch {
    throw new OAuthProtocolError('invalid_client_metadata', 'MCP client metadata is malformed');
  }
  if (!metadata || typeof metadata !== 'object') {
    throw new OAuthProtocolError('invalid_client_metadata', 'MCP client metadata is malformed');
  }
  const data = metadata as Record<string, unknown>;
  const tokenEndpointMethods = isStringArray(data.token_endpoint_auth_methods_supported)
    ? data.token_endpoint_auth_methods_supported
    : typeof data.token_endpoint_auth_method === 'string'
      ? [data.token_endpoint_auth_method]
      : [];
  if (
    data.client_id !== expected.clientId ||
    !isStringArray(data.redirect_uris) ||
    !data.redirect_uris.includes(expected.redirectUri) ||
    !isStringArray(data.grant_types) ||
    !data.grant_types.includes('authorization_code') ||
    !isStringArray(data.response_types) ||
    !data.response_types.includes('code') ||
    !tokenEndpointMethods.includes('none')
  ) {
    throw new OAuthProtocolError('invalid_client_metadata', 'MCP client metadata is not compatible with this server');
  }

  return {
    clientId,
    clientName:
      typeof data.client_name === 'string' && data.client_name.trim()
        ? data.client_name.trim().slice(0, 120)
        : expected.fallbackName,
    redirectUris: [expected.redirectUri],
    createdAt: nowSeconds(),
  };
}

function verifyResource(value: string, expected: string): void {
  let normalized: string;
  try {
    const resource = new URL(value);
    if (resource.hash || resource.search) {
      throw new Error();
    }
    normalized = resource.toString();
  } catch {
    throw new OAuthProtocolError('invalid_target', 'resource must be the canonical MCP URL');
  }
  if (normalized !== expected) {
    throw new OAuthProtocolError('invalid_target', 'resource does not identify this MCP server');
  }
}

export class McpOAuthService {
  readonly resource: string;
  readonly issuer: string;

  constructor(
    private readonly store: OAuthStore,
    publicBaseUrl: URL,
    private readonly accessTokenTtlSeconds: number,
    private readonly refreshTokenTtlSeconds: number,
    private readonly resolveClientMetadata: (clientId: string) => Promise<OAuthClient | null> = resolveTrustedClientMetadata,
    private readonly verifyClientAssertion: (
      clientId: string,
      clientAssertion: string,
      tokenEndpoint: string,
      issuer: string
    ) => Promise<void> = verifyChatGptClientAssertion
  ) {
    this.resource = new URL('/mcp', publicBaseUrl).toString();
    this.issuer = publicBaseUrl.origin;
  }

  async registerClient(input: unknown): Promise<OAuthClient> {
    if (!input || typeof input !== 'object') {
      throw new OAuthProtocolError('invalid_client_metadata', 'Client metadata must be a JSON object');
    }
    const data = input as Record<string, unknown>;
    if (!Array.isArray(data.redirect_uris) || data.redirect_uris.length < 1 || data.redirect_uris.length > 10) {
      throw new OAuthProtocolError('invalid_redirect_uri', 'redirect_uris must contain between one and ten URLs');
    }
    const redirectUris = Array.from(
      new Set(data.redirect_uris.map(uri => parseRedirectUri(typeof uri === 'string' ? uri : '')))
    );
    const clientName = typeof data.client_name === 'string' && data.client_name.trim()
      ? data.client_name.trim().slice(0, 120)
      : 'MCP client';
    const authenticationMethod = data.token_endpoint_auth_method;
    if (authenticationMethod !== undefined && authenticationMethod !== 'none') {
      throw new OAuthProtocolError('invalid_client_metadata', 'Only public OAuth clients are supported');
    }
    const client: OAuthClient = {
      clientId: randomOAuthValue('mcp_'),
      clientName,
      redirectUris,
      createdAt: nowSeconds(),
    };
    await this.store.createClient(client);
    return client;
  }

  async validateAuthorizationRequest(parameters: URLSearchParams): Promise<OAuthAuthorizationRequest> {
    if (parameters.get('response_type') !== 'code') {
      throw new OAuthProtocolError('unsupported_response_type', 'Only response_type=code is supported');
    }
    if (parameters.get('code_challenge_method') !== 'S256') {
      throw new OAuthProtocolError('invalid_request', 'PKCE S256 is required');
    }
    const clientId = required(parameters.get('client_id'), 'client_id');
    const metadataClient = await this.resolveClientMetadata(clientId);
    const client =
      metadataClient ??
      (clientId === CLAUDE_PRE_REGISTERED_CLIENT_ID
        ? claudePreRegisteredClient
        : await this.store.getClient(clientId));
    if (!client) {
      throw new OAuthProtocolError('unauthorized_client', 'Unknown client_id');
    }
    const redirectUri = parseRedirectUri(required(parameters.get('redirect_uri'), 'redirect_uri'));
    if (!client.redirectUris.includes(redirectUri)) {
      throw new OAuthProtocolError('invalid_request', 'redirect_uri is not registered for this client');
    }
    const resource = required(parameters.get('resource'), 'resource');
    verifyResource(resource, this.resource);
    const state = parameters.get('state') ?? undefined;
    if (state && state.length > 2048) {
      throw new OAuthProtocolError('invalid_request', 'state is too long');
    }
    return {
      client,
      redirectUri,
      state,
      scopes: parseScopes(parameters.get('scope')),
      resource: this.resource,
      codeChallenge: requirePkceChallenge(parameters.get('code_challenge')),
    };
  }

  async createAuthorizationTransaction(
    request: OAuthAuthorizationRequest,
    firebaseUid: string
  ): Promise<AuthorizationTransaction> {
    const transaction: AuthorizationTransaction = {
      id: randomOAuthValue('txn_'),
      firebaseUid,
      clientId: request.client.clientId,
      redirectUri: request.redirectUri,
      state: request.state,
      scopes: request.scopes,
      resource: request.resource,
      codeChallenge: request.codeChallenge,
      expiresAt: nowSeconds() + 300,
    };
    await this.store.createAuthorizationTransaction(transaction);
    return transaction;
  }

  async approveAuthorizationTransaction(transactionId: string, firebaseUid: string): Promise<{
    redirectUri: string;
    state?: string;
    code: string;
  }> {
    const transaction = await this.store.consumeAuthorizationTransaction(transactionId, nowSeconds());
    if (!transaction || transaction.firebaseUid !== firebaseUid) {
      throw new OAuthProtocolError('invalid_request', 'Authorization request has expired');
    }
    const code = randomOAuthValue('code_');
    await this.store.createAuthorizationCode(hashOAuthValue(code), {
      firebaseUid: transaction.firebaseUid,
      clientId: transaction.clientId,
      redirectUri: transaction.redirectUri,
      scopes: transaction.scopes,
      resource: transaction.resource,
      codeChallenge: transaction.codeChallenge,
      expiresAt: nowSeconds() + 60,
    });
    return { redirectUri: transaction.redirectUri, state: transaction.state, code };
  }

  async denyAuthorizationTransaction(transactionId: string, firebaseUid: string): Promise<{
    redirectUri: string;
    state?: string;
  }> {
    const transaction = await this.store.consumeAuthorizationTransaction(transactionId, nowSeconds());
    if (!transaction || transaction.firebaseUid !== firebaseUid) {
      throw new OAuthProtocolError('invalid_request', 'Authorization request has expired');
    }
    return { redirectUri: transaction.redirectUri, state: transaction.state };
  }

  async exchangeAuthorizationCode(parameters: URLSearchParams): Promise<TokenResponse> {
    const clientId = required(parameters.get('client_id'), 'client_id');
    await this.validateTokenEndpointClient(parameters, clientId);
    const redirectUri = parseRedirectUri(required(parameters.get('redirect_uri'), 'redirect_uri'));
    const resource = required(parameters.get('resource'), 'resource');
    verifyResource(resource, this.resource);
    const codeVerifier = required(parameters.get('code_verifier'), 'code_verifier');
    const code = required(parameters.get('code'), 'code');
    const stored = await this.store.consumeAuthorizationCode(hashOAuthValue(code), nowSeconds());
    if (
      !stored ||
      stored.clientId !== clientId ||
      stored.redirectUri !== redirectUri ||
      stored.resource !== this.resource ||
      !verifyPkce(codeVerifier, stored.codeChallenge)
    ) {
      throw new OAuthProtocolError('invalid_grant', 'Authorization code is invalid, expired, or already used');
    }
    return this.issueTokens(stored, randomOAuthValue('family_'));
  }

  private async validateTokenEndpointClient(parameters: URLSearchParams, clientId: string): Promise<void> {
    const assertion = parameters.get('client_assertion');
    const assertionType = parameters.get('client_assertion_type');
    if (!assertion) {
      if (assertionType) {
        throw new OAuthProtocolError('invalid_client', 'client_assertion is required when its type is supplied', 401);
      }
      return;
    }
    if (assertionType !== clientAssertionType) {
      throw new OAuthProtocolError('invalid_client', 'Unsupported client assertion type', 401);
    }
    await this.verifyClientAssertion(clientId, assertion, `${this.issuer}/oauth/token`, this.issuer);
  }

  async refresh(parameters: URLSearchParams): Promise<TokenResponse> {
    const clientId = required(parameters.get('client_id'), 'client_id');
    const resource = required(parameters.get('resource'), 'resource');
    verifyResource(resource, this.resource);
    const refreshToken = required(parameters.get('refresh_token'), 'refresh_token');
    const consumed = await this.store.consumeRefreshToken(
      hashOAuthValue(refreshToken),
      clientId,
      this.resource,
      nowSeconds()
    );
    if (!consumed) {
      throw new OAuthProtocolError('invalid_grant', 'Refresh token is invalid or expired');
    }
    if (consumed.status === 'reused') {
      await this.store.revokeRefreshTokenFamily(consumed.token.familyId);
      throw new OAuthProtocolError('invalid_grant', 'Refresh token reuse detected; reconnect the MCP client');
    }
    return this.issueTokens(consumed.token, consumed.token.familyId);
  }

  async authenticate(authorizationHeader: string | undefined): Promise<McpOAuthPrincipal> {
    const [scheme, accessToken] = authorizationHeader?.split(/\s+/, 2) ?? [];
    if (scheme !== 'Bearer' || !accessToken) {
      throw new OAuthProtocolError('invalid_token', 'A valid MCP access token is required', 401);
    }
    const stored = await this.store.getAccessToken(hashOAuthValue(accessToken), nowSeconds());
    if (!stored || stored.resource !== this.resource) {
      throw new OAuthProtocolError('invalid_token', 'MCP access token is invalid or expired', 401);
    }
    return {
      firebaseUid: stored.firebaseUid,
      clientId: stored.clientId,
      scopes: asMcpScopes(stored.scopes),
      expiresAt: stored.expiresAt,
      accessToken,
    };
  }

  private async issueTokens(subject: AccessToken, familyId: string): Promise<TokenResponse> {
    const issuedAt = nowSeconds();
    const accessToken = randomOAuthValue('at_');
    const refreshToken = randomOAuthValue('rt_');
    const accessTokenRecord: AccessToken = {
      firebaseUid: subject.firebaseUid,
      clientId: subject.clientId,
      scopes: subject.scopes,
      resource: subject.resource,
      expiresAt: issuedAt + this.accessTokenTtlSeconds,
    };
    const refreshTokenRecord: RefreshToken = {
      ...accessTokenRecord,
      familyId,
      expiresAt: issuedAt + this.refreshTokenTtlSeconds,
    };
    await Promise.all([
      this.store.createAccessToken(hashOAuthValue(accessToken), accessTokenRecord),
      this.store.createRefreshToken(hashOAuthValue(refreshToken), refreshTokenRecord),
    ]);
    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: this.accessTokenTtlSeconds,
      refresh_token: refreshToken,
      scope: accessTokenRecord.scopes.join(' '),
    };
  }
}
