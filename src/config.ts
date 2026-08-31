import { Buffer } from 'node:buffer';

export type AppConfig = {
  port: number;
  publicBaseUrl: URL;
  allowedOriginHostnames: string[];
  allowedHostnames: string[];
  firebaseProjectId: string;
  firebaseWeb: {
    apiKey: string;
    authDomain: string;
    appId: string;
  };
  auth0?: {
    issuer: string;
    audience: string;
    emailClaim: string;
    emailVerifiedClaim: string;
  };
  oauth: {
    accessTokenTtlSeconds: number;
    refreshTokenTtlSeconds: number;
    sessionTtlSeconds: number;
    personalAccessTokenTtlSeconds: number;
  };
  untappd: {
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    userAgent: string;
  };
  tokenEncryptionKey: Buffer;
  connectStateSecret: string;
};

function required(name: string, environment: NodeJS.ProcessEnv): string {
  const value = environment[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function parsePort(value: string | undefined): number {
  const port = Number(value ?? '8080');
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535');
  }
  return port;
}

function parseSeconds(name: string, value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

function parseUrl(name: string, value: string): URL {
  try {
    return new URL(value);
  } catch {
    throw new Error(`${name} must be a valid URL`);
  }
}

function optionalAuth0Config(environment: NodeJS.ProcessEnv, publicBaseUrl: URL): AppConfig['auth0'] {
  const issuerValue = environment.AUTH0_ISSUER?.trim();
  if (!issuerValue) {
    return undefined;
  }
  const issuer = parseUrl('AUTH0_ISSUER', issuerValue);
  if (issuer.protocol !== 'https:' || issuer.search || issuer.hash || issuer.username || issuer.password) {
    throw new Error('AUTH0_ISSUER must be an HTTPS issuer URL without credentials, query, or fragment');
  }
  const audience = new URL('/chatgpt/mcp', publicBaseUrl).toString();
  const claimNamespace = new URL('/auth0', publicBaseUrl).toString();
  return {
    issuer: issuer.toString(),
    audience,
    emailClaim: `${claimNamespace}/email`,
    emailVerifiedClaim: `${claimNamespace}/email_verified`,
  };
}

function originHostnames(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  return value
    .split(',')
    .map(origin => parseUrl('MCP_ALLOWED_ORIGINS', origin.trim()).hostname)
    .filter(Boolean);
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const publicBaseUrl = parseUrl('PUBLIC_BASE_URL', required('PUBLIC_BASE_URL', environment));
  const tokenEncryptionKey = Buffer.from(
    required('UNTAPPD_TOKEN_ENCRYPTION_KEY', environment),
    'base64'
  );

  if (tokenEncryptionKey.byteLength !== 32) {
    throw new Error('UNTAPPD_TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes');
  }

  return {
    port: parsePort(environment.PORT),
    publicBaseUrl,
    allowedOriginHostnames: Array.from(
      new Set([publicBaseUrl.hostname, ...originHostnames(environment.MCP_ALLOWED_ORIGINS)])
    ),
    allowedHostnames: [publicBaseUrl.hostname, 'localhost', '127.0.0.1', '[::1]'],
    firebaseProjectId: required('FIREBASE_PROJECT_ID', environment),
    firebaseWeb: {
      apiKey: required('FIREBASE_WEB_API_KEY', environment),
      authDomain: required('FIREBASE_AUTH_DOMAIN', environment),
      appId: required('FIREBASE_WEB_APP_ID', environment),
    },
    auth0: optionalAuth0Config(environment, publicBaseUrl),
    oauth: {
      accessTokenTtlSeconds: parseSeconds('MCP_ACCESS_TOKEN_TTL_SECONDS', environment.MCP_ACCESS_TOKEN_TTL_SECONDS, 900, 60, 3600),
      refreshTokenTtlSeconds: parseSeconds(
        'MCP_REFRESH_TOKEN_TTL_SECONDS',
        environment.MCP_REFRESH_TOKEN_TTL_SECONDS,
        60 * 60 * 24 * 30,
        60 * 60,
        60 * 60 * 24 * 90
      ),
      sessionTtlSeconds: parseSeconds(
        'MCP_SESSION_TTL_SECONDS',
        environment.MCP_SESSION_TTL_SECONDS,
        60 * 60 * 24 * 7,
        60 * 60,
        60 * 60 * 24 * 14
      ),
      personalAccessTokenTtlSeconds: parseSeconds(
        'MCP_PERSONAL_ACCESS_TOKEN_TTL_SECONDS',
        environment.MCP_PERSONAL_ACCESS_TOKEN_TTL_SECONDS,
        60 * 60 * 24 * 180,
        60 * 60 * 24,
        60 * 60 * 24 * 365
      ),
    },
    untappd: {
      clientId: required('UNTAPPD_CLIENT_ID', environment),
      clientSecret: required('UNTAPPD_CLIENT_SECRET', environment),
      redirectUri: required('UNTAPPD_REDIRECT_URI', environment),
      userAgent: required('UNTAPPD_USER_AGENT', environment),
    },
    tokenEncryptionKey,
    connectStateSecret: required('CONNECT_STATE_SECRET', environment),
  };
}
