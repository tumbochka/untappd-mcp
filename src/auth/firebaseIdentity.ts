import { applicationDefault, getApps, initializeApp, type App } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';

export type FirebasePrincipal = {
  uid: string;
  accessToken: string;
  expiresAt: number;
  scopes: string[];
};

function firebaseApp(projectId?: string): App {
  return getApps()[0] ?? initializeApp({ credential: applicationDefault(), projectId });
}

function bearerToken(authorizationHeader: string | undefined): string {
  const [scheme, token] = authorizationHeader?.split(/\s+/, 2) ?? [];
  if (scheme !== 'Bearer' || !token) {
    throw new Error('A Firebase ID token must be provided as a Bearer token');
  }
  return token;
}

export class FirebaseIdentityVerifier {
  private readonly auth;

  constructor(projectId?: string) {
    this.auth = getAuth(firebaseApp(projectId));
  }

  async verify(authorizationHeader: string | undefined): Promise<FirebasePrincipal> {
    const accessToken = bearerToken(authorizationHeader);
    const decoded = await this.auth.verifyIdToken(accessToken, true);
    const scopes = Array.isArray(decoded.mcpScopes)
      ? decoded.mcpScopes.filter((scope): scope is string => typeof scope === 'string')
      : ['untappd:read', 'untappd:write'];

    return {
      uid: decoded.uid,
      accessToken,
      expiresAt: decoded.exp,
      scopes,
    };
  }
}
