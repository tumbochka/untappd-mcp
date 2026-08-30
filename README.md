# Untappd MCP

A multi-user [Model Context Protocol](https://modelcontextprotocol.io/) server for Untappd. It keeps Untappd credentials on the server and exposes a small, explicit tool surface for search, profile data, wishlists, beer history, and check-ins.

## Current capabilities

- Streamable HTTP endpoint: `POST /mcp`
- OAuth 2.1 authorization-code flow with mandatory PKCE S256
- OAuth protected-resource and authorization-server metadata
- OAuth 2.0 Dynamic Client Registration for public MCP clients
- Short-lived, audience-bound opaque access tokens and rotating refresh tokens
- Firebase Auth Google sign-in and a secure server-side browser session
- `search_beers` and `get_beer`
- `get_my_profile`, `get_my_wishlist`, and `get_my_beers`
- `check_in`, with rating and message validation
- Untappd authorization-code connect flow: `GET /connect/untappd`
- AES-256-GCM encryption at rest for credentials in Firestore collection `untappd_credentials`
- Firebase ID-token verification on every authenticated server request

The server never returns an Untappd access token to an MCP client.

## Identity and authorization

There are three separate credentials. They must never be substituted for one another:

```text
Firebase browser sign-in ──> MCP OAuth server ── MCP access token ──> /mcp
                                              └─ encrypted Untappd access token ──> Untappd API
```

Firebase Auth identifies the person in the browser and creates a secure HTTP-only session. The MCP authorization server then issues its own access token whose owner is that Firebase `uid`, whose audience is exactly this server’s `/mcp` URL, and whose scopes are `untappd:read` and `untappd:write`.

Unauthenticated MCP requests receive `401` with protected-resource metadata. A compatible client such as Claude discovers the authorization server, registers a public OAuth client if necessary, sends the user through Firebase sign-in and the consent screen, then exchanges a PKCE-protected code for MCP tokens.

| Endpoint | Purpose |
| --- | --- |
| `POST /mcp` | Streamable HTTP MCP; accepts only MCP OAuth bearer tokens. |
| `GET /.well-known/oauth-protected-resource` | Protected-resource metadata. The `/mcp` suffix variant is also served. |
| `GET /.well-known/oauth-authorization-server` | OAuth authorization-server metadata. |
| `POST /oauth/register` | Dynamic Client Registration for public clients. |
| `GET /oauth/authorize` | Authorization request, Firebase browser sign-in, then consent. |
| `POST /oauth/token` | Authorization-code and refresh-token grants. |
| `GET /connect/untappd` | Starts the separate Untappd authorization flow for the signed-in Firebase user. |

The server keeps only hashes of MCP access, authorization-code, and refresh tokens in Firestore. Refresh tokens rotate; a reused refresh token revokes its whole token family. Untappd access tokens use AES-256-GCM encryption before storage.

## Untappd connection flow

1. The user opens `/connect/untappd` and signs in with Firebase if no browser session exists.
2. The server creates a signed, ten-minute Untappd OAuth `state` bound to that Firebase `uid`, then redirects the user to Untappd.
3. Untappd redirects to `/connect/untappd/callback`.
4. The server exchanges the code, fetches the profile, and stores the encrypted token under `untappd_credentials/{firebaseUid}`.

Legacy field `users/{uid}.untappdAccessToken` is intentionally not read. Migrate it through an admin-only one-time job after Firestore rules have been closed; do not expose that field to browsers.

## Local development

Prerequisites: Node.js 22+, Firebase Application Default Credentials, a Firebase project with Google sign-in enabled, and a registered Untappd application.

```bash
cp .env.example .env
npm ci
npm test
npm run build
npm start
```

Configure the values in `.env`; never commit it. Generate the encryption key with:

```bash
openssl rand -base64 32
```

For local callback testing, register the exact `UNTAPPD_REDIRECT_URI` with Untappd. Untappd requires HTTPS for API calls, and it expects a non-standard `User-Agent` for every request.

## Deployment

The included `Dockerfile` is suitable for Cloud Run. Configure these values through Secret Manager:

- `UNTAPPD_CLIENT_SECRET`
- `UNTAPPD_TOKEN_ENCRYPTION_KEY`
- `CONNECT_STATE_SECRET`

Grant the Cloud Run service account only the Firestore permissions needed for `untappd_credentials`. Keep Firebase service-account credentials and Untappd credentials out of the image and repository.

Set these non-secret runtime variables:

```text
PUBLIC_BASE_URL=https://YOUR_CLOUD_RUN_OR_CUSTOM_DOMAIN
FIREBASE_PROJECT_ID=beer-degustation
FIREBASE_WEB_API_KEY=...
FIREBASE_AUTH_DOMAIN=beer-degustation.firebaseapp.com
FIREBASE_WEB_APP_ID=...
UNTAPPD_CLIENT_ID=...
UNTAPPD_REDIRECT_URI=https://YOUR_CLOUD_RUN_OR_CUSTOM_DOMAIN/connect/untappd/callback
UNTAPPD_USER_AGENT=untappd-mcp/0.1 (support@example.com)
MCP_ALLOWED_ORIGINS=https://claude.ai
```

`PUBLIC_BASE_URL` and `UNTAPPD_REDIRECT_URI` must use the exact final HTTPS origin. Add that hostname to **Firebase Console → Authentication → Settings → Authorized domains** before using the OAuth browser login. The browser config fields are Firebase public configuration, not credentials.

Create Firestore TTL policies for `expiresAt` in these collection groups: `mcp_oauth_transactions`, `mcp_oauth_authorization_codes`, `mcp_oauth_access_tokens`, and `mcp_oauth_refresh_tokens`. TTL reduces retained metadata; server-side expiry checks remain mandatory.

## Security notes

- **Close Firestore Rules before deployment.** Cloud Run uses the Admin SDK, so it continues to work after browser access is denied. With open rules, an attacker could forge an OAuth token record.
- Untappd tokens are encrypted before reaching Firestore, but rotate the encryption key with a planned re-encryption migration.
- The OAuth callback uses a signed and expiring `state` value to prevent CSRF.
- OAuth authorization codes are one-time, expire after one minute, and require PKCE S256. Redirect URIs are exact-match registered values.
- MCP access tokens are short-lived and audience-bound to this server. Untappd tokens are never accepted at `/mcp`.
- `check_in` is intentionally marked non-idempotent. The calling model must get user confirmation before invoking it.
- `untappd:write` is required for `check_in`; all other current tools require `untappd:read`.
