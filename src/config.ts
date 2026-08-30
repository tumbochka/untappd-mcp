import { Buffer } from 'node:buffer';

export type AppConfig = {
  port: number;
  publicBaseUrl: URL;
  allowedOriginHostnames: string[];
  allowedHostnames: string[];
  firebaseProjectId?: string;
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

function parseUrl(name: string, value: string): URL {
  try {
    return new URL(value);
  } catch {
    throw new Error(`${name} must be a valid URL`);
  }
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
    allowedOriginHostnames: originHostnames(environment.MCP_ALLOWED_ORIGINS),
    allowedHostnames: [publicBaseUrl.hostname, 'localhost', '127.0.0.1', '[::1]'],
    firebaseProjectId: environment.FIREBASE_PROJECT_ID?.trim() || undefined,
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
