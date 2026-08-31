import assert from 'node:assert/strict';
import test from 'node:test';
import { FormTokenSigner } from '../src/auth/formToken.js';

test('form token is bound to the Firebase user, action, and expiration', () => {
  const signer = new FormTokenSigner('a secure test secret');
  const token = signer.sign('firebase-user-123', 'create', 2_000);

  signer.verify(token, 'firebase-user-123', 'create', 1_000);
  assert.throws(() => signer.verify(token, 'other-user', 'create', 1_000));
  assert.throws(() => signer.verify(token, 'firebase-user-123', 'revoke', 1_000));
  assert.throws(() => signer.verify(token, 'firebase-user-123', 'create', 2_000));
});
