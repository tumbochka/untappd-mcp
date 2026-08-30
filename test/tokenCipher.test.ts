import assert from 'node:assert/strict';
import test from 'node:test';
import { ConnectStateSigner } from '../src/auth/connectState.js';
import { TokenCipher } from '../src/credentials/tokenCipher.js';

test('TokenCipher encrypts and decrypts access tokens', () => {
  const cipher = new TokenCipher(Buffer.alloc(32, 1));
  const encrypted = cipher.encrypt('untappd-access-token');

  assert.notEqual(encrypted.ciphertext, 'untappd-access-token');
  assert.equal(cipher.decrypt(encrypted), 'untappd-access-token');
});

test('ConnectStateSigner rejects a tampered or expired state', () => {
  const signer = new ConnectStateSigner('test-secret');
  const state = signer.sign({ firebaseUid: 'uid-1', expiresAt: 200 });

  assert.deepEqual(signer.verify(state, 100), { firebaseUid: 'uid-1', expiresAt: 200 });
  assert.throws(() => signer.verify(`${state}x`, 100), /Invalid OAuth state signature/);
  assert.throws(() => signer.verify(state, 200), /expired/);
});
