import { applicationDefault, getApps, initializeApp, type App } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';

export type FirebasePrincipal = {
  uid: string;
  accessToken: string;
  expiresAt: number;
  scopes: string[];
};

export type FirebaseSession = {
  uid: string;
  expiresAt: number;
  email?: string;
  emailVerified: boolean;
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

  async createSessionCookie(idToken: string, expiresInMilliseconds: number): Promise<string> {
    const decoded = await this.auth.verifyIdToken(idToken, true);
    const authTime = decoded.auth_time;
    if (!authTime || Date.now() / 1000 - authTime > 5 * 60) {
      throw new Error('Firebase sign-in is too old to create an OAuth browser session');
    }
    return this.auth.createSessionCookie(idToken, { expiresIn: expiresInMilliseconds });
  }

  async verifySessionCookie(cookie: string): Promise<FirebaseSession> {
    const decoded = await this.auth.verifySessionCookie(cookie, true);
    return {
      uid: decoded.uid,
      expiresAt: decoded.exp,
      ...(typeof decoded.email === 'string' && decoded.email.trim() ? { email: decoded.email.trim() } : {}),
      emailVerified: decoded.email_verified === true,
    };
  }

  async firebaseUidByVerifiedEmail(email: string): Promise<string> {
    const normalized = email.trim().toLowerCase();
    const user = await this.auth.getUserByEmail(normalized);
    if (!user.emailVerified || user.email?.trim().toLowerCase() !== normalized) {
      throw new Error('The Auth0 email does not identify a verified Firebase user');
    }
    return user.uid;
  }
}
