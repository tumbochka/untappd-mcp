import { createHash, randomBytes } from 'node:crypto';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';

export type OAuthClient = {
  clientId: string;
  clientName: string;
  redirectUris: string[];
  createdAt: number;
};

export type AuthorizationTransaction = {
  id: string;
  firebaseUid: string;
  clientId: string;
  redirectUri: string;
  state?: string;
  scopes: string[];
  resource: string;
  codeChallenge: string;
  expiresAt: number;
};

export type AuthorizationCode = Omit<AuthorizationTransaction, 'id' | 'state'> & {
  clientId: string;
};

export type AccessToken = {
  firebaseUid: string;
  clientId: string;
  scopes: string[];
  resource: string;
  expiresAt: number;
};

export type RefreshToken = AccessToken & {
  familyId: string;
  expiresAt: number;
};

export type ConsumedRefreshToken =
  | { status: 'valid'; token: RefreshToken }
  | { status: 'reused'; token: RefreshToken };

export interface OAuthStore {
  createClient(client: OAuthClient): Promise<void>;
  upsertClient(client: OAuthClient): Promise<void>;
  getClient(clientId: string): Promise<OAuthClient | null>;
  createAuthorizationTransaction(transaction: AuthorizationTransaction): Promise<void>;
  consumeAuthorizationTransaction(id: string, nowSeconds: number): Promise<AuthorizationTransaction | null>;
  createAuthorizationCode(codeHash: string, code: AuthorizationCode): Promise<void>;
  consumeAuthorizationCode(codeHash: string, nowSeconds: number): Promise<AuthorizationCode | null>;
  createAccessToken(tokenHash: string, token: AccessToken): Promise<void>;
  getAccessToken(tokenHash: string, nowSeconds: number): Promise<AccessToken | null>;
  createRefreshToken(tokenHash: string, token: RefreshToken): Promise<void>;
  consumeRefreshToken(
    tokenHash: string,
    clientId: string,
    resource: string,
    nowSeconds: number
  ): Promise<ConsumedRefreshToken | null>;
  revokeRefreshTokenFamily(familyId: string): Promise<void>;
}

type TimestampLike = { toMillis: () => number };

function asSeconds(value: unknown): number {
  if (value && typeof value === 'object' && 'toMillis' in value) {
    return Math.floor((value as TimestampLike).toMillis() / 1000);
  }
  throw new Error('Invalid OAuth timestamp in Firestore');
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    throw new Error('Invalid OAuth string array in Firestore');
  }
  return value;
}

function nonEmptyString(value: unknown): string {
  if (typeof value !== 'string' || !value) {
    throw new Error('Invalid OAuth value in Firestore');
  }
  return value;
}

function clientFromData(data: Record<string, unknown>): OAuthClient {
  return {
    clientId: nonEmptyString(data.clientId),
    clientName: nonEmptyString(data.clientName),
    redirectUris: stringArray(data.redirectUris),
    createdAt: asSeconds(data.createdAt),
  };
}

function transactionFromData(data: Record<string, unknown>): AuthorizationTransaction {
  const state = data.state;
  if (state !== undefined && typeof state !== 'string') {
    throw new Error('Invalid OAuth state in Firestore');
  }
  return {
    id: nonEmptyString(data.id),
    firebaseUid: nonEmptyString(data.firebaseUid),
    clientId: nonEmptyString(data.clientId),
    redirectUri: nonEmptyString(data.redirectUri),
    state,
    scopes: stringArray(data.scopes),
    resource: nonEmptyString(data.resource),
    codeChallenge: nonEmptyString(data.codeChallenge),
    expiresAt: asSeconds(data.expiresAt),
  };
}

function authorizationCodeFromData(data: Record<string, unknown>): AuthorizationCode {
  return {
    firebaseUid: nonEmptyString(data.firebaseUid),
    clientId: nonEmptyString(data.clientId),
    redirectUri: nonEmptyString(data.redirectUri),
    scopes: stringArray(data.scopes),
    resource: nonEmptyString(data.resource),
    codeChallenge: nonEmptyString(data.codeChallenge),
    expiresAt: asSeconds(data.expiresAt),
  };
}

function accessTokenFromData(data: Record<string, unknown>): AccessToken {
  return {
    firebaseUid: nonEmptyString(data.firebaseUid),
    clientId: nonEmptyString(data.clientId),
    scopes: stringArray(data.scopes),
    resource: nonEmptyString(data.resource),
    expiresAt: asSeconds(data.expiresAt),
  };
}

function refreshTokenFromData(data: Record<string, unknown>): RefreshToken {
  return { ...accessTokenFromData(data), familyId: nonEmptyString(data.familyId) };
}

function timestamp(seconds: number): Timestamp {
  return Timestamp.fromMillis(seconds * 1000);
}

export function randomOAuthValue(prefix = ''): string {
  return `${prefix}${randomBytes(32).toString('base64url')}`;
}

export function hashOAuthValue(value: string): string {
  return createHash('sha256').update(value).digest('base64url');
}

export class FirestoreOAuthStore implements OAuthStore {
  private readonly firestore = getFirestore();

  // Dynamically-registered client ids are `mcp_<base64url>` and are safe as
  // Firestore document ids. CIMD client ids are URLs (they contain "/", which
  // doc() reads as a nested path), so those are stored under a hash instead.
  private clientDocId(clientId: string): string {
    return /^mcp_[A-Za-z0-9_-]+$/.test(clientId) ? clientId : hashOAuthValue(clientId);
  }

  async createClient(client: OAuthClient): Promise<void> {
    await this.clients().doc(this.clientDocId(client.clientId)).create({
      ...client,
      createdAt: timestamp(client.createdAt),
    });
  }

  async upsertClient(client: OAuthClient): Promise<void> {
    await this.clients().doc(this.clientDocId(client.clientId)).set({
      ...client,
      createdAt: timestamp(client.createdAt),
    });
  }

  async getClient(clientId: string): Promise<OAuthClient | null> {
    if (!clientId) {
      return null;
    }
    const snapshot = await this.clients().doc(this.clientDocId(clientId)).get();
    return snapshot.exists ? clientFromData(snapshot.data() as Record<string, unknown>) : null;
  }

  async createAuthorizationTransaction(transaction: AuthorizationTransaction): Promise<void> {
    await this.transactions().doc(transaction.id).create({
      ...transaction,
      expiresAt: timestamp(transaction.expiresAt),
    });
  }

  async consumeAuthorizationTransaction(id: string, nowSeconds: number): Promise<AuthorizationTransaction | null> {
    let result: AuthorizationTransaction | null = null;
    const reference = this.transactions().doc(id);
    await this.firestore.runTransaction(async transaction => {
      const snapshot = await transaction.get(reference);
      if (!snapshot.exists) {
        return;
      }
      transaction.delete(reference);
      const value = transactionFromData(snapshot.data() as Record<string, unknown>);
      if (value.expiresAt > nowSeconds) {
        result = value;
      }
    });
    return result;
  }

  async createAuthorizationCode(codeHash: string, code: AuthorizationCode): Promise<void> {
    await this.authorizationCodes().doc(codeHash).create({ ...code, expiresAt: timestamp(code.expiresAt) });
  }

  async consumeAuthorizationCode(codeHash: string, nowSeconds: number): Promise<AuthorizationCode | null> {
    let result: AuthorizationCode | null = null;
    const reference = this.authorizationCodes().doc(codeHash);
    await this.firestore.runTransaction(async transaction => {
      const snapshot = await transaction.get(reference);
      if (!snapshot.exists) {
        return;
      }
      transaction.delete(reference);
      const value = authorizationCodeFromData(snapshot.data() as Record<string, unknown>);
      if (value.expiresAt > nowSeconds) {
        result = value;
      }
    });
    return result;
  }

  async createAccessToken(tokenHash: string, token: AccessToken): Promise<void> {
    await this.accessTokens().doc(tokenHash).create({ ...token, expiresAt: timestamp(token.expiresAt) });
  }

  async getAccessToken(tokenHash: string, nowSeconds: number): Promise<AccessToken | null> {
    const snapshot = await this.accessTokens().doc(tokenHash).get();
    if (!snapshot.exists) {
      return null;
    }
    const value = accessTokenFromData(snapshot.data() as Record<string, unknown>);
    return value.expiresAt > nowSeconds ? value : null;
  }

  async createRefreshToken(tokenHash: string, token: RefreshToken): Promise<void> {
    await this.refreshTokens().doc(tokenHash).create({
      ...token,
      expiresAt: timestamp(token.expiresAt),
      usedAt: null,
      revokedAt: null,
    });
  }

  async consumeRefreshToken(
    tokenHash: string,
    clientId: string,
    resource: string,
    nowSeconds: number
  ): Promise<ConsumedRefreshToken | null> {
    let result: ConsumedRefreshToken | null = null;
    const reference = this.refreshTokens().doc(tokenHash);
    await this.firestore.runTransaction(async transaction => {
      const snapshot = await transaction.get(reference);
      if (!snapshot.exists) {
        return;
      }
      const data = snapshot.data() as Record<string, unknown>;
      const value = refreshTokenFromData(data);
      if (
        value.expiresAt <= nowSeconds ||
        value.clientId !== clientId ||
        value.resource !== resource ||
        data.revokedAt !== null
      ) {
        return;
      }
      if (data.usedAt !== null) {
        result = { status: 'reused', token: value };
        return;
      }
      transaction.update(reference, { usedAt: timestamp(nowSeconds) });
      result = { status: 'valid', token: value };
    });
    return result;
  }

  async revokeRefreshTokenFamily(familyId: string): Promise<void> {
    const snapshots = await this.refreshTokens().where('familyId', '==', familyId).get();
    const batch = this.firestore.batch();
    for (const document of snapshots.docs) {
      batch.update(document.ref, { revokedAt: Timestamp.now() });
    }
    if (!snapshots.empty) {
      await batch.commit();
    }
  }

  private clients() {
    return this.firestore.collection('mcp_oauth_clients');
  }

  private transactions() {
    return this.firestore.collection('mcp_oauth_transactions');
  }

  private authorizationCodes() {
    return this.firestore.collection('mcp_oauth_authorization_codes');
  }

  private accessTokens() {
    return this.firestore.collection('mcp_oauth_access_tokens');
  }

  private refreshTokens() {
    return this.firestore.collection('mcp_oauth_refresh_tokens');
  }
}
