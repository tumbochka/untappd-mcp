import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { URL } from 'node:url';
import { toNodeHandler, hostHeaderValidation, originValidation } from '@modelcontextprotocol/node';
import { createMcpHandler, type AuthInfo } from '@modelcontextprotocol/server';
import { ConnectStateSigner } from './auth/connectState.js';
import { FirebaseIdentityVerifier, type FirebasePrincipal } from './auth/firebaseIdentity.js';
import { loadConfig } from './config.js';
import { FirestoreCredentialStore } from './credentials/credentialStore.js';
import { TokenCipher } from './credentials/tokenCipher.js';
import { createUntappdMcpServer } from './mcp/server.js';
import { UntappdClient } from './untappd/client.js';

type AuthenticatedRequest = IncomingMessage & { auth?: AuthInfo };

const config = loadConfig();
const identityVerifier = new FirebaseIdentityVerifier(config.firebaseProjectId);
const credentialStore = new FirestoreCredentialStore(new TokenCipher(config.tokenEncryptionKey));
const untappd = new UntappdClient(config.untappd);
const stateSigner = new ConnectStateSigner(config.connectStateSecret);

const mcpHandler = createMcpHandler(
  ({ authInfo }) =>
    createUntappdMcpServer({
      firebaseUid: authInfo?.clientId,
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

function writeJson(response: ServerResponse, status: number, data: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(data));
}

function writeHtml(response: ServerResponse, status: number, html: string): void {
  response.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
  response.end(html);
}

async function authenticate(request: IncomingMessage, response: ServerResponse): Promise<FirebasePrincipal | null> {
  try {
    return await identityVerifier.verify(request.headers.authorization);
  } catch (error) {
    console.warn('Rejected unauthenticated request', error instanceof Error ? error.message : error);
    response.writeHead(401, {
      'content-type': 'application/json; charset=utf-8',
      'www-authenticate': 'Bearer realm="untappd-mcp"',
    });
    response.end(JSON.stringify({ error: 'unauthorized', message: 'A valid Firebase ID token is required.' }));
    return null;
  }
}

function asMcpAuthInfo(principal: FirebasePrincipal): AuthInfo {
  return {
    token: principal.accessToken,
    clientId: principal.uid,
    scopes: principal.scopes,
    expiresAt: principal.expiresAt,
    resource: new URL('/mcp', config.publicBaseUrl),
    extra: { firebaseUid: principal.uid, identityProvider: 'firebase' },
  };
}

function requestUrl(request: IncomingMessage): URL {
  return new URL(request.url ?? '/', config.publicBaseUrl);
}

async function handleUntappdConnect(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const principal = await authenticate(request, response);
  if (!principal) {
    return;
  }
  const state = stateSigner.sign({
    firebaseUid: principal.uid,
    expiresAt: Math.floor(Date.now() / 1000) + 10 * 60,
  });
  response.writeHead(302, { location: untappd.authorizationUrl(state), 'cache-control': 'no-store' });
  response.end();
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
    const profile = (await untappd.getCurrentUser(accessToken)) as {
      user?: { user_name?: string };
    };
    await credentialStore.save(firebaseUid, {
      accessToken,
      untappdUserName: profile.user?.user_name,
    });
    writeHtml(
      response,
      200,
      '<!doctype html><title>Untappd connected</title><p>Untappd is connected. You can close this window.</p>'
    );
  } catch (error) {
    console.error('Untappd OAuth callback failed', error);
    writeJson(response, 400, { error: 'untappd_connect_failed', message: 'Could not connect Untappd.' });
  }
}

const httpServer = createServer(async (request, response) => {
  if (!validateHost(request, response) || !validateOrigin(request, response)) {
    return;
  }

  const url = requestUrl(request);
  if (request.method === 'GET' && url.pathname === '/healthz') {
    writeJson(response, 200, { status: 'ok' });
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
    const principal = await authenticate(request, response);
    if (!principal) {
      return;
    }
    (request as AuthenticatedRequest).auth = asMcpAuthInfo(principal);
    await nodeMcpHandler(request as AuthenticatedRequest, response);
    return;
  }
  writeJson(response, 404, { error: 'not_found' });
});

httpServer.listen(config.port, () => {
  console.log(`Untappd MCP listening on ${config.publicBaseUrl.origin}/mcp`);
});

async function shutdown(signal: string): Promise<void> {
  console.log(`Received ${signal}; shutting down`);
  await mcpHandler.close();
  httpServer.close();
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));
