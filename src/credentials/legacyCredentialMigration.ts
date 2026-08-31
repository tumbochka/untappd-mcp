import { getFirestore } from 'firebase-admin/firestore';
import type { CredentialStore, UntappdCredential } from './credentialStore.js';
import { UntappdApiError, type UntappdClient } from '../untappd/client.js';

export type LegacyUntappdCredential = {
  sourceUid: string;
  accessToken: string;
  untappdUserName?: string;
};

export interface LegacyCredentialSource {
  getByFirebaseUid(firebaseUid: string): Promise<LegacyUntappdCredential | null>;
  getByEmail(email: string): Promise<LegacyUntappdCredential | null>;
}

export type LegacyMigrationInput = {
  firebaseUid: string;
  email?: string;
  emailVerified: boolean;
};

export type LegacyMigrationResult = 'already_connected' | 'imported' | 'not_found' | 'invalid_token' | 'unavailable';

function legacyCredential(sourceUid: string, data: Record<string, unknown>): LegacyUntappdCredential | null {
  const accessToken = data.untappdAccessToken;
  if (typeof accessToken !== 'string' || !accessToken.trim() || accessToken.length > 4096) {
    return null;
  }
  const untappdUserName = data.untappdName;
  return {
    sourceUid,
    accessToken: accessToken.trim(),
    ...(typeof untappdUserName === 'string' && untappdUserName.trim()
      ? { untappdUserName: untappdUserName.trim().slice(0, 120) }
      : {}),
  };
}

function profileUserName(profile: unknown): string | undefined {
  if (!profile || typeof profile !== 'object' || !('user' in profile)) {
    return undefined;
  }
  const user = (profile as { user?: unknown }).user;
  if (!user || typeof user !== 'object' || !('user_name' in user)) {
    return undefined;
  }
  const value = (user as { user_name?: unknown }).user_name;
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 120) : undefined;
}

function emailCandidates(email: string | undefined): string[] {
  if (!email) {
    return [];
  }
  const trimmed = email.trim();
  if (!trimmed || trimmed.length > 320) {
    return [];
  }
  return Array.from(new Set([trimmed, trimmed.toLowerCase()]));
}

export class FirestoreLegacyCredentialSource implements LegacyCredentialSource {
  private readonly firestore = getFirestore();

  async getByFirebaseUid(firebaseUid: string): Promise<LegacyUntappdCredential | null> {
    const snapshot = await this.users().doc(firebaseUid).get();
    return snapshot.exists ? legacyCredential(snapshot.id, snapshot.data() as Record<string, unknown>) : null;
  }

  async getByEmail(email: string): Promise<LegacyUntappdCredential | null> {
    const snapshots = await this.users().where('email', '==', email).limit(2).get();
    if (snapshots.size !== 1) {
      return null;
    }
    const snapshot = snapshots.docs[0];
    return legacyCredential(snapshot.id, snapshot.data() as Record<string, unknown>);
  }

  private users() {
    return this.firestore.collection('users');
  }
}

export class LegacyCredentialMigrationService {
  constructor(
    private readonly credentials: CredentialStore,
    private readonly legacy: LegacyCredentialSource,
    private readonly untappd: Pick<UntappdClient, 'getCurrentUser'>
  ) {}

  async migrate(input: LegacyMigrationInput): Promise<LegacyMigrationResult> {
    if (await this.credentials.get(input.firebaseUid)) {
      return 'already_connected';
    }

    let source = await this.legacy.getByFirebaseUid(input.firebaseUid);
    if (!source && input.emailVerified) {
      const matches = await Promise.all(emailCandidates(input.email).map(email => this.legacy.getByEmail(email)));
      const uniqueMatches = new Map(matches.filter((match): match is LegacyUntappdCredential => match !== null).map(match => [match.sourceUid, match]));
      if (uniqueMatches.size === 1) {
        source = uniqueMatches.values().next().value as LegacyUntappdCredential;
      }
    }
    if (!source) {
      return 'not_found';
    }

    let profile: unknown;
    try {
      profile = await this.untappd.getCurrentUser(source.accessToken);
    } catch (error) {
      if (error instanceof UntappdApiError && error.status >= 400 && error.status < 500 && error.status !== 429) {
        return 'invalid_token';
      }
      console.warn('Legacy Untappd credential validation was unavailable', error);
      return 'unavailable';
    }

    const credential: UntappdCredential = {
      accessToken: source.accessToken,
      untappdUserName: profileUserName(profile) ?? source.untappdUserName,
    };
    await this.credentials.save(input.firebaseUid, credential);
    return 'imported';
  }
}
