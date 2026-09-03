import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { URL } from 'node:url';
import { hostHeaderValidation, originValidation, toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler, type AuthInfo } from '@modelcontextprotocol/server';
import { Auth0IdentityVerifier } from './auth/auth0Identity.js';
import { ConnectStateSigner } from './auth/connectState.js';
import { FirebaseIdentityVerifier, type FirebaseSession } from './auth/firebaseIdentity.js';
import { FormTokenSigner } from './auth/formToken.js';
import { FirestorePersonalAccessTokenStore, PersonalAccessTokenService } from './auth/personalAccessToken.js';
import { loadConfig } from './config.js';
import { FirestoreCredentialStore } from './credentials/credentialStore.js';
import {
  FirestoreLegacyCredentialSource,
  LegacyCredentialMigrationService,
  type LegacyMigrationResult,
} from './credentials/legacyCredentialMigration.js';
import { TokenCipher } from './credentials/tokenCipher.js';
import { cookieValue, expiredCookie, HttpRequestError, readForm, readJson, sessionCookie } from './http.js';
import { createUntappdMcpServer } from './mcp/server.js';
import {
  authorizationConsentPage,
  firebaseLoginPage,
  personalAccessTokenCreatedPage,
  personalAccessTokenPage,
} from './oauth/html.js';
import { McpOAuthService, MCP_SCOPES, OAuthProtocolError } from './oauth/service.js';
import { FirestoreOAuthStore } from './oauth/store.js';
import { UntappdClient } from './untappd/client.js';

type AuthenticatedRequest = IncomingMessage & { auth?: AuthInfo };

const sessionCookieName = '__Host-untappd-mcp-session';
const config = loadConfig();
const firebaseIdentity = new FirebaseIdentityVerifier(config.firebaseProjectId);
const credentialStore = new FirestoreCredentialStore(new TokenCipher(config.tokenEncryptionKey));
const untappd = new UntappdClient(config.untappd);
const legacyCredentialMigration = new LegacyCredentialMigrationService(
  credentialStore,
  new FirestoreLegacyCredentialSource(),
  untappd
);
const stateSigner = new ConnectStateSigner(config.connectStateSecret);
const formTokenSigner = new FormTokenSigner(config.connectStateSecret);
const oauth = new McpOAuthService(
  new FirestoreOAuthStore(),
  config.publicBaseUrl,
  config.oauth.accessTokenTtlSeconds,
  config.oauth.refreshTokenTtlSeconds
);
const chatGptMcpResource = new URL('/chatgpt/mcp', config.publicBaseUrl).toString();
const auth0Identity = config.auth0
  ? new Auth0IdentityVerifier(config.auth0, email => firebaseIdentity.firebaseUidByVerifiedEmail(email))
  : null;
const personalAccessTokens = new PersonalAccessTokenService(
  new FirestorePersonalAccessTokenStore(),
  config.oauth.personalAccessTokenTtlSeconds
);

const mcpHandler = createMcpHandler(
  ({ authInfo }) =>
    createUntappdMcpServer({
      firebaseUid: typeof authInfo?.extra?.firebaseUid === 'string' ? authInfo.extra.firebaseUid : undefined,
      scopes: authInfo?.scopes ?? [],
      untappdConnectUrl: new URL('/connect/untappd', config.publicBaseUrl).toString(),
      credentialStore,
      untappd,
    }),
  { responseMode: 'json' }
);
const nodeMcpHandler = toNodeHandler(mcpHandler, {
  onerror: error => console.error('MCP request failed', error),
});
const validateHost = hostHeaderValidation(config.allowedHostnames);
const validateOrigin = originValidation(config.allowedOriginHostnames);

function writeJson(
  response: ServerResponse,
  status: number,
  data: unknown,
  headers: Record<string, string> = {}
): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  response.end(JSON.stringify(data));
}

function nonce(): string {
  return randomBytes(16).toString('base64');
}

function writeHtml(
  response: ServerResponse,
  status: number,
  html: string,
  pageNonce: string,
  formActionExtra: string[] = []
): void {
  response.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    'content-security-policy': [
      "default-src 'none'",
      `style-src 'nonce-${pageNonce}'`,
      `script-src 'nonce-${pageNonce}' https://www.gstatic.com https://apis.google.com`,
      "connect-src 'self' https://identitytoolkit.googleapis.com https://securetoken.googleapis.com https://www.googleapis.com",
      'frame-src https://accounts.google.com https://*.firebaseapp.com',
      "base-uri 'none'",
      ["form-action 'self'", ...formActionExtra].join(' '),
    ].join('; '),
  });
  response.end(html);
}

function writeRedirect(response: ServerResponse, location: string): void {
  response.writeHead(302, { location, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
  response.end();
}

function writeOAuthError(response: ServerResponse, error: unknown): void {
  if (error instanceof OAuthProtocolError) {
    writeJson(response, error.status, { error: error.error, error_description: error.message });
    return;
  }
  if (error instanceof HttpRequestError) {
    writeJson(response, error.status, { error: 'invalid_request', error_description: error.message });
    return;
  }
  console.error('OAuth request failed', error);
  writeJson(response, 500, { error: 'server_error', error_description: 'OAuth request could not be completed' });
}

function requestUrl(request: IncomingMessage): URL {
  return new URL(request.url ?? '/', config.publicBaseUrl);
}

function appendParameters(location: string, parameters: Record<string, string | undefined>): string {
  const url = new URL(location);
  for (const [key, value] of Object.entries(parameters)) {
    if (value !== undefined) {
      url.searchParams.set(key, value);
    }
  }
  return url.toString();
}

function sessionContinuation(value: string | null): string {
  if (!value) {
    throw new OAuthProtocolError('invalid_request', 'Missing continuation URL');
  }
  let url: URL;
  try {
    url = new URL(value, config.publicBaseUrl);
  } catch {
    throw new OAuthProtocolError('invalid_request', 'Invalid continuation URL');
  }
  if (
    url.origin !== config.publicBaseUrl.origin ||
    !['/oauth/authorize', '/connect/untappd', '/tokens'].includes(url.pathname)
  ) {
    throw new OAuthProtocolError('invalid_request', 'Invalid continuation URL');
  }
  return `${url.pathname}${url.search}`;
}

async function firebaseSession(request: IncomingMessage): Promise<FirebaseSession | null> {
  const value = cookieValue(request.headers.cookie, sessionCookieName);
  if (!value) {
    return null;
  }
  try {
    return await firebaseIdentity.verifySessionCookie(value);
  } catch {
    return null;
  }
}

async function connectFirebaseUid(request: IncomingMessage): Promise<string | null> {
  const session = await firebaseSession(request);
  if (session) {
    return session.uid;
  }
  try {
    return (await firebaseIdentity.verify(request.headers.authorization)).uid;
  } catch {
    return null;
  }
}

function asMcpAuthInfo(
  principal: {
    firebaseUid: string;
    clientId: string;
    scopes: string[];
    expiresAt: number;
    accessToken: string;
  },
  resource = oauth.resource,
  authorizationServer = oauth.issuer
): AuthInfo {
  return {
    token: principal.accessToken,
    clientId: principal.clientId,
    scopes: principal.scopes,
    expiresAt: principal.expiresAt,
    resource: new URL(resource),
    extra: { firebaseUid: principal.firebaseUid, authorizationServer },
  };
}

function bearerToken(authorizationHeader: string | undefined): string | null {
  const [scheme, token] = authorizationHeader?.split(/\s+/, 2) ?? [];
  return scheme === 'Bearer' && token ? token : null;
}

async function migrateLegacyCredential(session: FirebaseSession): Promise<LegacyMigrationResult> {
  try {
    return await legacyCredentialMigration.migrate({
      firebaseUid: session.uid,
      email: session.email,
      emailVerified: session.emailVerified,
    });
  } catch (error) {
    console.warn('Legacy Untappd credential migration failed', error);
    return 'unavailable';
  }
}

function migrationMessage(result: LegacyMigrationResult): string | undefined {
  if (result === 'imported') {
    return 'Your existing Untappd connection was imported from the legacy degustation app.';
  }
  if (result === 'invalid_token') {
    return 'A saved legacy Untappd connection was found, but it is no longer valid. Connect Untappd again to continue.';
  }
  return undefined;
}

function resourceMetadata(): Record<string, unknown> {
  return {
    resource: oauth.resource,
    authorization_servers: [oauth.issuer],
    scopes_supported: MCP_SCOPES,
    bearer_methods_supported: ['header'],
  };
}

function chatGptResourceMetadata(): Record<string, unknown> | null {
  if (!config.auth0) {
    return null;
  }
  return {
    resource: chatGptMcpResource,
    authorization_servers: [config.auth0.issuer],
    scopes_supported: MCP_SCOPES,
    bearer_methods_supported: ['header'],
  };
}

function authorizationServerMetadata(): Record<string, unknown> {
  return {
    issuer: oauth.issuer,
    authorization_endpoint: `${oauth.issuer}/oauth/authorize`,
    token_endpoint: `${oauth.issuer}/oauth/token`,
    registration_endpoint: `${oauth.issuer}/oauth/register`,
    client_id_metadata_document_supported: true,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['none', 'private_key_jwt'],
    code_challenge_methods_supported: ['S256'],
    authorization_response_iss_parameter_supported: true,
    scopes_supported: MCP_SCOPES,
  };
}

function mcpUnauthorized(
  response: ServerResponse,
  message: string,
  options: { tokenPresented?: boolean } = {}
): void {
  const challenge = [
    `Bearer resource_metadata="${config.publicBaseUrl.origin}/.well-known/oauth-protected-resource"`,
  ];
  if (options.tokenPresented) {
    // RFC 6750 §3: an expired or otherwise invalid bearer token gets an explicit
    // error code so the client refreshes instead of restarting discovery.
    challenge.push('error="invalid_token"', `error_description="${message.replace(/["\\]/g, '')}"`);
  }
  writeJson(
    response,
    401,
    { error: 'unauthorized', message },
    { 'www-authenticate': challenge.join(', ') }
  );
}

function chatGptMcpUnauthorized(response: ServerResponse, message: string): void {
  if (!config.auth0) {
    writeJson(response, 503, {
      error: 'auth0_not_configured',
      message: 'The separate ChatGPT OAuth endpoint is not configured yet.',
    });
    return;
  }
  writeJson(
    response,
    401,
    { error: 'unauthorized', message },
    {
      'www-authenticate': `Bearer resource_metadata="${config.publicBaseUrl.origin}/.well-known/oauth-protected-resource/chatgpt/mcp"`,
    }
  );
}

async function handleFirebaseSession(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const [scheme, idToken] = request.headers.authorization?.split(/\s+/, 2) ?? [];
  if (scheme !== 'Bearer' || !idToken) {
    writeJson(response, 401, { error: 'unauthorized', message: 'A Firebase ID token is required.' });
    return;
  }
  try {
    const cookie = await firebaseIdentity.createSessionCookie(idToken, config.oauth.sessionTtlSeconds * 1000);
    response.writeHead(204, {
      'set-cookie': sessionCookie(sessionCookieName, cookie, config.oauth.sessionTtlSeconds),
      'cache-control': 'no-store',
    });
    response.end();
  } catch (error) {
    console.warn('Rejected Firebase browser session', error);
    writeJson(response, 401, { error: 'unauthorized', message: 'Firebase sign-in could not be verified.' });
  }
}

async function handleLogin(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const continueTo = sessionContinuation(requestUrl(request).searchParams.get('continue'));
  const pageNonce = nonce();
  writeHtml(
    response,
    200,
    firebaseLoginPage({
      firebase: {
        apiKey: config.firebaseWeb.apiKey,
        authDomain: config.firebaseWeb.authDomain,
        appId: config.firebaseWeb.appId,
        projectId: config.firebaseProjectId,
      },
      continueTo,
      nonce: pageNonce,
    }),
    pageNonce
  );
}

async function handleAuthorize(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = requestUrl(request);
  const authorizationRequest = await oauth.validateAuthorizationRequest(url.searchParams);
  const session = await firebaseSession(request);
  if (!session) {
    writeRedirect(response, `/oauth/login?continue=${encodeURIComponent(`${url.pathname}${url.search}`)}`);
    return;
  }
  const transaction = await oauth.createAuthorizationTransaction(authorizationRequest, session.uid);
  const pageNonce = nonce();
  writeHtml(
    response,
    200,
    authorizationConsentPage({
      clientName: authorizationRequest.client.clientName,
      redirectUri: authorizationRequest.redirectUri,
      scopes: authorizationRequest.scopes,
      transactionId: transaction.id,
      nonce: pageNonce,
    }),
    pageNonce,
    // Approving the consent form issues a 302 to the client's validated
    // redirect_uri. Browsers enforce form-action across that redirect, so the
    // client origin must be allowed or the authorization code never leaves here.
    [new URL(authorizationRequest.redirectUri).origin]
  );
}

async function handleConsent(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const session = await firebaseSession(request);
  if (!session) {
    writeJson(response, 401, { error: 'login_required', message: 'Sign in again before authorizing this client.' });
    return;
  }
  const form = await readForm(request);
  const transactionId = form.get('transaction_id');
  if (!transactionId || transactionId.length > 256) {
    throw new OAuthProtocolError('invalid_request', 'Invalid authorization transaction');
  }
  if (form.get('decision') === 'deny') {
    const denied = await oauth.denyAuthorizationTransaction(transactionId, session.uid);
    writeRedirect(
      response,
      appendParameters(denied.redirectUri, {
        error: 'access_denied',
        error_description: 'The resource owner denied access',
        state: denied.state,
        iss: oauth.issuer,
      })
    );
    return;
  }
  if (form.get('decision') !== 'approve') {
    throw new OAuthProtocolError('invalid_request', 'Invalid authorization decision');
  }
  const approved = await oauth.approveAuthorizationTransaction(transactionId, session.uid);
  writeRedirect(
    response,
    appendParameters(approved.redirectUri, { code: approved.code, state: approved.state, iss: oauth.issuer })
  );
}

async function handleToken(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const form = await readForm(request);
  const grantType = form.get('grant_type');
  let token;
  if (grantType === 'authorization_code') {
    token = await oauth.exchangeAuthorizationCode(form);
  } else if (grantType === 'refresh_token') {
    token = await oauth.refresh(form);
  } else {
    throw new OAuthProtocolError('unsupported_grant_type', 'Supported grants are authorization_code and refresh_token');
  }
  writeJson(response, 200, token);
}

async function handleRegister(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const client = await oauth.registerClient(await readJson(request));
  writeJson(response, 201, {
    client_id: client.clientId,
    client_id_issued_at: client.createdAt,
    client_name: client.clientName,
    redirect_uris: client.redirectUris,
    token_endpoint_auth_method: 'none',
  });
}

async function handleUntappdConnect(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const firebaseUid = await connectFirebaseUid(request);
  if (!firebaseUid) {
    writeRedirect(response, '/oauth/login?continue=%2Fconnect%2Funtappd');
    return;
  }
  const state = stateSigner.sign({
    firebaseUid,
    expiresAt: Math.floor(Date.now() / 1000) + 10 * 60,
  });
  writeRedirect(response, untappd.authorizationUrl(state));
}

async function handleUntappdCallback(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = requestUrl(request);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (!code || !state) {
    writeJson(response, 400, { error: 'invalid_callback', message: 'Untappd code and state are required.' });
    return;
  }
  try {
    const { firebaseUid } = stateSigner.verify(state);
    const accessToken = await untappd.exchangeAuthorizationCode(code);
    const profile = (await untappd.getCurrentUser(accessToken)) as { user?: { user_name?: string } };
    await credentialStore.save(firebaseUid, {
      accessToken,
      untappdUserName: profile.user?.user_name,
    });
    const pageNonce = nonce();
    writeHtml(
      response,
      200,
      '<!doctype html><title>Untappd connected</title><p>Untappd is connected. You can close this window.</p>',
      pageNonce
    );
  } catch (error) {
    console.error('Untappd OAuth callback failed', error);
    writeJson(response, 400, { error: 'untappd_connect_failed', message: 'Could not connect Untappd.' });
  }
}

async function handlePersonalAccessTokensPage(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const session = await firebaseSession(request);
  if (!session) {
    writeRedirect(response, '/oauth/login?continue=%2Ftokens');
    return;
  }
  const legacyMigration = await migrateLegacyCredential(session);
  const pageNonce = nonce();
  writeHtml(
    response,
    200,
    personalAccessTokenPage({
      tokens: await personalAccessTokens.list(session.uid),
      createCsrfToken: formTokenSigner.sign(session.uid, 'create', Math.floor(Date.now() / 1000) + 10 * 60),
      revokeCsrfToken: formTokenSigner.sign(session.uid, 'revoke', Math.floor(Date.now() / 1000) + 10 * 60),
      migrationMessage: migrationMessage(legacyMigration),
      nonce: pageNonce,
    }),
    pageNonce
  );
}

async function handlePersonalAccessTokenCreate(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const session = await firebaseSession(request);
  if (!session) {
    writeJson(response, 401, { error: 'login_required', message: 'Sign in again before creating a token.' });
    return;
  }
  await migrateLegacyCredential(session);
  const form = await readForm(request);
  try {
    formTokenSigner.verify(form.get('csrf_token'), session.uid, 'create', Math.floor(Date.now() / 1000));
  } catch {
    throw new OAuthProtocolError('invalid_request', 'The token creation form has expired. Reload the page and try again.');
  }
  const issued = await personalAccessTokens.issue(session.uid);
  const pageNonce = nonce();
  writeHtml(
    response,
    201,
    personalAccessTokenCreatedPage({ token: issued.token, expiresAt: issued.record.expiresAt, nonce: pageNonce }),
    pageNonce
  );
}

async function handlePersonalAccessTokenRevoke(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const session = await firebaseSession(request);
  if (!session) {
    writeJson(response, 401, { error: 'login_required', message: 'Sign in again before revoking a token.' });
    return;
  }
  const form = await readForm(request);
  try {
    formTokenSigner.verify(form.get('csrf_token'), session.uid, 'revoke', Math.floor(Date.now() / 1000));
  } catch {
    throw new OAuthProtocolError('invalid_request', 'The token revocation form has expired. Reload the page and try again.');
  }
  const tokenId = form.get('token_id');
  if (!tokenId || !/^[A-Za-z0-9_-]{43}$/.test(tokenId)) {
    throw new OAuthProtocolError('invalid_request', 'Invalid personal access token');
  }
  await personalAccessTokens.revoke(tokenId, session.uid);
  writeRedirect(response, '/tokens');
}

async function handleMcp(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const token = bearerToken(request.headers.authorization);
  try {
    const principal = token?.startsWith('pat_')
      ? await personalAccessTokens.authenticate(token)
      : await oauth.authenticate(request.headers.authorization);
    (request as AuthenticatedRequest).auth = asMcpAuthInfo(principal);
    await nodeMcpHandler(request as AuthenticatedRequest, response);
  } catch (error) {
    const tokenPresented = Boolean(token);
    if (error instanceof OAuthProtocolError) {
      mcpUnauthorized(response, error.message, { tokenPresented });
      return;
    }
    console.error('MCP authentication failed', error);
    mcpUnauthorized(response, 'MCP authentication could not be completed.', { tokenPresented });
  }
}

async function handleChatGptMcp(request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (!auth0Identity || !config.auth0) {
    chatGptMcpUnauthorized(response, 'ChatGPT OAuth is not configured.');
    return;
  }
  try {
    const principal = await auth0Identity.verify(request.headers.authorization);
    (request as AuthenticatedRequest).auth = asMcpAuthInfo(
      { ...principal, clientId: 'auth0' },
      chatGptMcpResource,
      config.auth0.issuer
    );
    await nodeMcpHandler(request as AuthenticatedRequest, response);
  } catch (error) {
    console.warn('ChatGPT Auth0 MCP authentication failed', error instanceof Error ? error.message : error);
    chatGptMcpUnauthorized(response, 'A valid Auth0 access token is required.');
  }
}

const httpServer = createServer(async (request, response) => {
  if (!validateHost(request, response)) {
    return;
  }
  const url = requestUrl(request);
  // OAuth browser navigation and form posts may legitimately omit Origin. The
  // MCP transport is the only cross-origin endpoint, so apply its strict
  // Origin policy there rather than to the OAuth authorization flow.
  if (['/mcp', '/chatgpt/mcp'].includes(url.pathname) && !validateOrigin(request, response)) {
    return;
  }
  try {
    if (request.method === 'GET' && (url.pathname === '/health' || url.pathname === '/healthz')) {
      writeJson(response, 200, { status: 'ok' });
      return;
    }
    if (
      request.method === 'GET' &&
      (url.pathname === '/.well-known/oauth-protected-resource' ||
        url.pathname === '/.well-known/oauth-protected-resource/mcp')
    ) {
      writeJson(response, 200, resourceMetadata());
      return;
    }
    if (
      request.method === 'GET' &&
      url.pathname === '/.well-known/oauth-protected-resource/chatgpt/mcp'
    ) {
      const metadata = chatGptResourceMetadata();
      if (!metadata) {
        writeJson(response, 404, { error: 'not_found' });
        return;
      }
      writeJson(response, 200, metadata);
      return;
    }
    if (
      request.method === 'GET' &&
      (url.pathname === '/.well-known/oauth-authorization-server' ||
        url.pathname === '/.well-known/oauth-authorization-server/mcp')
    ) {
      writeJson(response, 200, authorizationServerMetadata());
      return;
    }
    if (request.method === 'GET' && url.pathname === '/oauth/login') {
      await handleLogin(request, response);
      return;
    }
    if (request.method === 'POST' && url.pathname === '/oauth/firebase/session') {
      await handleFirebaseSession(request, response);
      return;
    }
    if (request.method === 'POST' && url.pathname === '/oauth/logout') {
      response.writeHead(204, { 'set-cookie': expiredCookie(sessionCookieName), 'cache-control': 'no-store' });
      response.end();
      return;
    }
    if (request.method === 'GET' && url.pathname === '/oauth/authorize') {
      await handleAuthorize(request, response);
      return;
    }
    if (request.method === 'POST' && url.pathname === '/oauth/authorize/consent') {
      await handleConsent(request, response);
      return;
    }
    if (request.method === 'POST' && url.pathname === '/oauth/token') {
      await handleToken(request, response);
      return;
    }
    if (request.method === 'POST' && url.pathname === '/oauth/register') {
      await handleRegister(request, response);
      return;
    }
    if (request.method === 'GET' && url.pathname === '/tokens') {
      await handlePersonalAccessTokensPage(request, response);
      return;
    }
    if (request.method === 'POST' && url.pathname === '/tokens') {
      await handlePersonalAccessTokenCreate(request, response);
      return;
    }
    if (request.method === 'POST' && url.pathname === '/tokens/revoke') {
      await handlePersonalAccessTokenRevoke(request, response);
      return;
    }
    if (request.method === 'GET' && url.pathname === '/connect/untappd') {
      await handleUntappdConnect(request, response);
      return;
    }
    if (request.method === 'GET' && url.pathname === '/connect/untappd/callback') {
      await handleUntappdCallback(request, response);
      return;
    }
    if (url.pathname === '/mcp') {
      await handleMcp(request, response);
      return;
    }
    if (url.pathname === '/chatgpt/mcp') {
      await handleChatGptMcp(request, response);
      return;
    }
    writeJson(response, 404, { error: 'not_found' });
  } catch (error) {
    writeOAuthError(response, error);
  }
});

httpServer.listen(config.port, () => {
  console.log(`Untappd MCP listening on ${oauth.resource}`);
});

async function shutdown(signal: string): Promise<void> {
  console.log(`Received ${signal}; shutting down`);
  await mcpHandler.close();
  httpServer.close();
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));
