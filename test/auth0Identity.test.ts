import assert from 'node:assert/strict';
import test from 'node:test';
import { Auth0IdentityVerifier } from '../src/auth/auth0Identity.js';

const config = {
  issuer: 'https://untappd-test.eu.auth0.com/',
  audience: 'https://untappd-mcp.example.com/chatgpt/mcp',
  emailClaim: 'https://untappd-mcp.example.com/auth0/email',
  emailVerifiedClaim: 'https://untappd-mcp.example.com/auth0/email_verified',
};

test('Auth0 access token maps a verified email to its Firebase user and preserves MCP scopes', async () => {
  let resolvedEmail: string | undefined;
  const verifier = new Auth0IdentityVerifier(
    config,
    async email => {
      resolvedEmail = email;
      return 'firebase-user-123';
    },
    async token => {
      assert.equal(token, 'auth0-access-token');
      return {
        sub: 'google-oauth2|123',
        exp: 1_900_000_000,
        scope: 'openid profile untappd:read',
        permissions: ['untappd:write', 'not-an-mcp-scope'],
        [config.emailClaim]: '  USER@example.com ',
        [config.emailVerifiedClaim]: true,
      };
    }
  );

  const principal = await verifier.verify('Bearer auth0-access-token');

  assert.equal(resolvedEmail, 'user@example.com');
  assert.equal(principal.firebaseUid, 'firebase-user-123');
  assert.equal(principal.expiresAt, 1_900_000_000);
  assert.deepEqual(principal.scopes, ['untappd:read', 'untappd:write']);
});

test('Auth0 access token refuses an unverified or absent email claim', async () => {
  const verifier = new Auth0IdentityVerifier(
    config,
    async () => 'firebase-user-123',
    async () => ({
      sub: 'google-oauth2|123',
      exp: 1_900_000_000,
      scope: 'untappd:read',
      [config.emailClaim]: 'user@example.com',
      [config.emailVerifiedClaim]: false,
    })
  );

  await assert.rejects(() => verifier.verify('Bearer auth0-access-token'), /verified email identity/);
});
