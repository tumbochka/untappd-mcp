# Untappd MCP

A multi-user [Model Context Protocol](https://modelcontextprotocol.io/) server for Untappd. It keeps Untappd credentials on the server and exposes a small, explicit tool surface for search, profile data, wishlists, beer history, and check-ins.

## Current capabilities

- Streamable HTTP endpoint: `POST /mcp`
- `search_beers` and `get_beer`
- `get_my_profile`, `get_my_wishlist`, and `get_my_beers`
- `check_in`, with rating and message validation
- Untappd authorization-code connect flow: `GET /connect/untappd`
- AES-256-GCM encryption at rest for credentials in Firestore collection `untappd_credentials`
- Firebase ID-token verification on every authenticated server request

The server never returns an Untappd access token to an MCP client.

## Identity and authorization

There are two different authorization boundaries:

```text
MCP client ── Firebase ID token ──> Untappd MCP ── Untappd access token ──> Untappd API
```

The current server verifies a Firebase ID token and uses its `uid` as the credential owner. This makes it compatible with the existing degustation application’s user identity, but a Firebase ID token is **not** a standards-compliant remote MCP OAuth token.

Before connecting a hosted MCP client such as Claude directly, put an OAuth 2.1 authorization server in front of `/mcp` (or implement it in this service). That layer must:

1. authenticate the user with Firebase Auth;
2. issue short-lived MCP tokens with `aud` set to this server and least-privilege scopes;
3. expose OAuth authorization-server and protected-resource metadata;
4. use PKCE and support Claude’s dynamic-client-registration or client-ID-metadata flow.

The MCP specification requires this separation: an Untappd token is an upstream credential and must not be accepted as a token to call this MCP server.

## Untappd connection flow

1. The user authenticates to your companion web app with Firebase.
2. The app opens `/connect/untappd` with the Firebase ID token in `Authorization: Bearer …`.
3. The server creates a signed, ten-minute OAuth `state` and redirects the user to Untappd.
4. Untappd redirects to `/connect/untappd/callback`.
5. The server exchanges the code, fetches the profile, and stores the encrypted token under `untappd_credentials/{firebaseUid}`.

Legacy field `users/{uid}.untappdAccessToken` is intentionally not read. Migrate it through an admin-only one-time job after Firestore rules have been closed; do not expose that field to browsers.

## Local development

Prerequisites: Node.js 22+, a Firebase project credential available through Application Default Credentials, and a registered Untappd application.

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

Set `PUBLIC_BASE_URL` to the final HTTPS origin and set `MCP_ALLOWED_ORIGINS` to the comma-separated list of browser client origins. The server rejects an `Origin` header that is not allowlisted.

## Security notes

- Untappd tokens are encrypted before reaching Firestore, but rotate the encryption key with a planned re-encryption migration.
- The OAuth callback uses a signed and expiring `state` value to prevent CSRF.
- `check_in` is intentionally marked non-idempotent. The calling model must get user confirmation before invoking it.
- Apply Firestore rules so the browser cannot read or write `untappd_credentials`.
