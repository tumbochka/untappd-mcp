import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import type { AppConfig } from '../config.js';

export type Auth0Principal = {
  firebaseUid: string;
  accessToken: string;
  expiresAt: number;
  scopes: string[];
};

type Auth0Config = NonNullable<AppConfig['auth0']>;
type JwtPayloadVerifier = (accessToken: string) => Promise<JWTPayload>;
type FirebaseUidResolver = (email: string) => Promise<string>;

const supportedScopes = new Set(['untappd:read', 'untappd:write']);

function bearerToken(authorizationHeader: string | undefined): string {
  const [scheme, token] = authorizationHeader?.split(/\s+/, 2) ?? [];
  if (scheme !== 'Bearer' || !token) {
    throw new Error('A valid Auth0 access token is required');
  }
  return token;
}

function claimedScopes(payload: JWTPayload): string[] {
  const values = [
    ...(typeof payload.scope === 'string' ? payload.scope.split(/\s+/) : []),
    ...(Array.isArray(payload.permissions) ? payload.permissions.filter((value): value is string => typeof value === 'string') : []),
  ];
  return Array.from(new Set(values.filter(scope => supportedScopes.has(scope))));
}

function requiredVerifiedEmail(payload: JWTPayload, config: Auth0Config): string {
  const email = payload[config.emailClaim];
  const emailVerified = payload[config.emailVerifiedClaim];
  if (typeof email !== 'string' || !email.trim() || emailVerified !== true) {
    throw new Error('Auth0 access token does not contain a verified email identity');
  }
  return email.trim().toLowerCase();
}

function defaultJwtPayloadVerifier(config: Auth0Config): JwtPayloadVerifier {
  const jwks = createRemoteJWKSet(new URL('/.well-known/jwks.json', config.issuer));
  return async accessToken => {
    const { payload } = await jwtVerify(accessToken, jwks, {
      algorithms: ['RS256'],
      audience: config.audience,
      issuer: config.issuer,
      requiredClaims: ['sub', 'aud', 'iss', 'exp'],
    });
    return payload;
  };
}

export class Auth0IdentityVerifier {
  private readonly verifyJwt: JwtPayloadVerifier;

  constructor(
    private readonly config: Auth0Config,
    private readonly resolveFirebaseUid: FirebaseUidResolver,
    verifyJwt: JwtPayloadVerifier = defaultJwtPayloadVerifier(config)
  ) {
    this.verifyJwt = verifyJwt;
  }

  async verify(authorizationHeader: string | undefined): Promise<Auth0Principal> {
    const accessToken = bearerToken(authorizationHeader);
    const payload = await this.verifyJwt(accessToken);
    const firebaseUid = await this.resolveFirebaseUid(requiredVerifiedEmail(payload, this.config));
    if (!payload.exp) {
      throw new Error('Auth0 access token is missing its expiration');
    }
    return {
      firebaseUid,
      accessToken,
      expiresAt: payload.exp,
      scopes: claimedScopes(payload),
    };
  }
}
