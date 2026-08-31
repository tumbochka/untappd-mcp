import { createHash, randomBytes } from 'node:crypto';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import { MCP_SCOPES, OAuthProtocolError, type McpOAuthPrincipal, type McpScope } from '../oauth/service.js';

export type PersonalAccessToken = {
  id: string;
  firebaseUid: string;
  label: string;
  scopes: McpScope[];
  createdAt: number;
  expiresAt: number;
  revokedAt?: number;
};

export interface PersonalAccessTokenStore {
  create(token: PersonalAccessToken): Promise<void>;
  get(id: string): Promise<PersonalAccessToken | null>;
  list(firebaseUid: string): Promise<PersonalAccessToken[]>;
  revoke(id: string, firebaseUid: string, revokedAt: number): Promise<boolean>;
}

type TimestampLike = { toMillis: () => number };

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('base64url');
}

function asSeconds(value: unknown, name: string): number {
  if (value && typeof value === 'object' && 'toMillis' in value) {
    return Math.floor((value as TimestampLike).toMillis() / 1000);
  }
  throw new Error(`Invalid personal access token ${name}`);
}

function nonEmptyString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value) {
    throw new Error(`Invalid personal access token ${name}`);
  }
  return value;
}

function asScopes(value: unknown): McpScope[] {
  if (!Array.isArray(value) || value.some(scope => !MCP_SCOPES.includes(scope as McpScope))) {
    throw new Error('Invalid personal access token scopes');
  }
  return value as McpScope[];
}

function fromData(id: string, data: Record<string, unknown>): PersonalAccessToken {
  const revokedAt = data.revokedAt;
  if (revokedAt !== null && revokedAt !== undefined && (!revokedAt || typeof revokedAt !== 'object')) {
    throw new Error('Invalid personal access token revokedAt');
  }
  return {
    id,
    firebaseUid: nonEmptyString(data.firebaseUid, 'firebaseUid'),
    label: nonEmptyString(data.label, 'label'),
    scopes: asScopes(data.scopes),
    createdAt: asSeconds(data.createdAt, 'createdAt'),
    expiresAt: asSeconds(data.expiresAt, 'expiresAt'),
    ...(revokedAt ? { revokedAt: asSeconds(revokedAt, 'revokedAt') } : {}),
  };
}

function timestamp(seconds: number): Timestamp {
  return Timestamp.fromMillis(seconds * 1000);
}

export class FirestorePersonalAccessTokenStore implements PersonalAccessTokenStore {
  private readonly firestore = getFirestore();

  async create(token: PersonalAccessToken): Promise<void> {
    await this.tokens().doc(token.id).create({
      firebaseUid: token.firebaseUid,
      label: token.label,
      scopes: token.scopes,
      createdAt: timestamp(token.createdAt),
      expiresAt: timestamp(token.expiresAt),
      revokedAt: null,
    });
  }

  async get(id: string): Promise<PersonalAccessToken | null> {
    const snapshot = await this.tokens().doc(id).get();
    return snapshot.exists ? fromData(snapshot.id, snapshot.data() as Record<string, unknown>) : null;
  }

  async list(firebaseUid: string): Promise<PersonalAccessToken[]> {
    const snapshots = await this.tokens().where('firebaseUid', '==', firebaseUid).limit(50).get();
    return snapshots.docs
      .map(snapshot => fromData(snapshot.id, snapshot.data() as Record<string, unknown>))
      .sort((left, right) => right.createdAt - left.createdAt);
  }

  async revoke(id: string, firebaseUid: string, revokedAt: number): Promise<boolean> {
    let revoked = false;
    const reference = this.tokens().doc(id);
    await this.firestore.runTransaction(async transaction => {
      const snapshot = await transaction.get(reference);
      if (!snapshot.exists) {
        return;
      }
      const token = fromData(snapshot.id, snapshot.data() as Record<string, unknown>);
      if (token.firebaseUid !== firebaseUid || token.revokedAt !== undefined) {
        return;
      }
      transaction.update(reference, { revokedAt: timestamp(revokedAt) });
      revoked = true;
    });
    return revoked;
  }

  private tokens() {
    return this.firestore.collection('mcp_personal_access_tokens');
  }
}

export class PersonalAccessTokenService {
  constructor(
    private readonly store: PersonalAccessTokenStore,
    private readonly ttlSeconds: number,
    private readonly currentSeconds: () => number = nowSeconds
  ) {}

  async issue(firebaseUid: string, label = 'Claude'): Promise<{ token: string; record: PersonalAccessToken }> {
    const issuedAt = this.currentSeconds();
    const token = `pat_${randomBytes(32).toString('base64url')}`;
    const record: PersonalAccessToken = {
      id: hashToken(token),
      firebaseUid,
      label,
      scopes: [...MCP_SCOPES],
      createdAt: issuedAt,
      expiresAt: issuedAt + this.ttlSeconds,
    };
    await this.store.create(record);
    return { token, record };
  }

  async authenticate(token: string): Promise<McpOAuthPrincipal> {
    if (!token.startsWith('pat_')) {
      throw new OAuthProtocolError('invalid_token', 'A valid personal access token is required', 401);
    }
    const record = await this.store.get(hashToken(token));
    if (!record || record.revokedAt !== undefined || record.expiresAt <= this.currentSeconds()) {
      throw new OAuthProtocolError('invalid_token', 'MCP access token is invalid or expired', 401);
    }
    return {
      firebaseUid: record.firebaseUid,
      clientId: 'personal-access-token',
      scopes: record.scopes,
      expiresAt: record.expiresAt,
      accessToken: token,
    };
  }

  async list(firebaseUid: string): Promise<PersonalAccessToken[]> {
    return this.store.list(firebaseUid);
  }

  async revoke(id: string, firebaseUid: string): Promise<boolean> {
    return this.store.revoke(id, firebaseUid, this.currentSeconds());
  }
}
