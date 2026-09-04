import assert from 'node:assert/strict';
import test from 'node:test';
import {
  LegacyCredentialMigrationService,
  type LegacyCredentialSource,
  type LegacyUntappdCredential,
} from '../src/credentials/legacyCredentialMigration.js';
import type { CredentialStore, UntappdCredential } from '../src/credentials/credentialStore.js';
import { UntappdApiError } from '../src/untappd/client.js';

class MemoryCredentials implements CredentialStore {
  values = new Map<string, UntappdCredential>();

  async get(firebaseUid: string): Promise<UntappdCredential | null> {
    return this.values.get(firebaseUid) ?? null;
  }

  async getByUntappdUserName(userName: string): Promise<UntappdCredential | null> {
    for (const credential of this.values.values()) {
      if (credential.untappdUserName?.toLowerCase() === userName.trim().toLowerCase()) {
        return credential;
      }
    }
    return null;
  }

  async save(firebaseUid: string, credential: UntappdCredential): Promise<void> {
    this.values.set(firebaseUid, credential);
  }

  async delete(firebaseUid: string): Promise<void> {
    this.values.delete(firebaseUid);
  }
}

class MemoryLegacySource implements LegacyCredentialSource {
  byUid = new Map<string, LegacyUntappdCredential>();
  byEmail = new Map<string, LegacyUntappdCredential>();
  emailLookups = 0;

  async getByFirebaseUid(firebaseUid: string): Promise<LegacyUntappdCredential | null> {
    return this.byUid.get(firebaseUid) ?? null;
  }

  async getByEmail(email: string): Promise<LegacyUntappdCredential | null> {
    this.emailLookups += 1;
    return this.byEmail.get(email) ?? null;
  }
}

test('imports a valid legacy token by Firebase UID and keeps the legacy source intact', async () => {
  const credentials = new MemoryCredentials();
  const legacy = new MemoryLegacySource();
  legacy.byUid.set('same-uid', { sourceUid: 'same-uid', accessToken: 'legacy-token', untappdUserName: 'old-name' });
  const migration = new LegacyCredentialMigrationService(credentials, legacy, {
    async getCurrentUser(token: string) {
      assert.equal(token, 'legacy-token');
      return { user: { user_name: 'fresh-name' } };
    },
  } as never);

  assert.equal(
    await migration.migrate({ firebaseUid: 'same-uid', email: 'same@example.com', emailVerified: true }),
    'imported'
  );
  assert.deepEqual(await credentials.get('same-uid'), { accessToken: 'legacy-token', untappdUserName: 'fresh-name' });
  assert.equal(legacy.byUid.get('same-uid')?.accessToken, 'legacy-token');
  assert.equal(legacy.emailLookups, 0);
});

test('uses an exact verified-email fallback and refuses an invalid legacy token', async () => {
  const credentials = new MemoryCredentials();
  const legacy = new MemoryLegacySource();
  legacy.byEmail.set('person@example.com', {
    sourceUid: 'old-uid',
    accessToken: 'expired-token',
    untappdUserName: 'old-name',
  });
  const migration = new LegacyCredentialMigrationService(credentials, legacy, {
    async getCurrentUser() {
      throw new UntappdApiError('Invalid access token', 401, 'user/info');
    },
  } as never);

  assert.equal(
    await migration.migrate({ firebaseUid: 'new-uid', email: 'person@example.com', emailVerified: true }),
    'invalid_token'
  );
  assert.equal(await credentials.get('new-uid'), null);

  const unverified = new LegacyCredentialMigrationService(credentials, legacy, {
    async getCurrentUser() {
      throw new Error('should not be called');
    },
  } as never);
  assert.equal(
    await unverified.migrate({ firebaseUid: 'another-uid', email: 'person@example.com', emailVerified: false }),
    'not_found'
  );
});
