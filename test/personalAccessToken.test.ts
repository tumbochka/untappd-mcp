import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PersonalAccessTokenService,
  type PersonalAccessToken,
  type PersonalAccessTokenStore,
} from '../src/auth/personalAccessToken.js';
import { OAuthProtocolError } from '../src/oauth/service.js';

class MemoryPersonalAccessTokenStore implements PersonalAccessTokenStore {
  tokens = new Map<string, PersonalAccessToken>();

  async create(token: PersonalAccessToken): Promise<void> {
    this.tokens.set(token.id, { ...token });
  }

  async get(id: string): Promise<PersonalAccessToken | null> {
    return this.tokens.get(id) ?? null;
  }

  async list(firebaseUid: string): Promise<PersonalAccessToken[]> {
    return Array.from(this.tokens.values()).filter(token => token.firebaseUid === firebaseUid);
  }

  async revoke(id: string, firebaseUid: string, revokedAt: number): Promise<boolean> {
    const token = this.tokens.get(id);
    if (!token || token.firebaseUid !== firebaseUid || token.revokedAt !== undefined) {
      return false;
    }
    token.revokedAt = revokedAt;
    return true;
  }
}

test('personal access token authenticates only its Firebase user and can be revoked', async () => {
  let now = 10_000;
  const store = new MemoryPersonalAccessTokenStore();
  const tokens = new PersonalAccessTokenService(store, 3600, () => now);
  const issued = await tokens.issue('firebase-user-123');

  assert.match(issued.token, /^pat_[A-Za-z0-9_-]{43}$/);
  assert.notEqual(issued.record.id, issued.token);
  assert.equal((await tokens.authenticate(issued.token)).firebaseUid, 'firebase-user-123');
  assert.equal((await tokens.authenticate(issued.token)).scopes.join(' '), 'untappd:read untappd:write');
  assert.equal((await tokens.list('firebase-user-123')).length, 1);

  assert.equal(await tokens.revoke(issued.record.id, 'another-user'), false);
  assert.equal(await tokens.revoke(issued.record.id, 'firebase-user-123'), true);
  await assert.rejects(
    () => tokens.authenticate(issued.token),
    (error: unknown) => error instanceof OAuthProtocolError && error.error === 'invalid_token'
  );

  const expiring = await tokens.issue('firebase-user-123');
  now += 3600;
  await assert.rejects(
    () => tokens.authenticate(expiring.token),
    (error: unknown) => error instanceof OAuthProtocolError && error.error === 'invalid_token'
  );
});
