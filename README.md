# Untappd MCP

A multi-user [Model Context Protocol](https://modelcontextprotocol.io/) server for Untappd. It keeps Untappd credentials on the server and exposes a small, explicit tool surface for beer search, profiles and beer history (your own and other users'), wishlists, "has this user had that beer?" lookups, and check-ins.

## Current capabilities

- Streamable HTTP endpoint: `POST /mcp`
- OAuth 2.1 authorization-code flow with mandatory PKCE S256; Claude and ChatGPT both connect through it
- OAuth protected-resource and authorization-server metadata
- Client ID Metadata Document (CIMD) support, Dynamic Client Registration, and a pre-registered public Claude client
- Short-lived, audience-bound opaque access tokens and rotating refresh tokens
- Firebase Auth Google sign-in and a secure server-side browser session
- Revocable, time-limited personal access tokens as a header-auth alternative to the OAuth flow
- `search_beers` (via Untappd's public search index — no shared-quota cost) and `get_beer`
- `get_my_profile`, `get_my_wishlist`, and `get_my_beers`
- `get_user_profile`, `get_user_beers`, and `get_user_checkins` for any Untappd username
- `check_user_had_beer` — "has USERNAME ever checked in this beer?", with their rating and first/last dates
- `get_untappd_api_usage` — the shared Untappd hourly rate-limit budget and how much is left
- `check_in`, with 0.1-step ratings (plus `.25` / `.75`) and message validation
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

As a header-auth alternative to the OAuth flow, the server also issues personal access tokens. They are created only from an authenticated Firebase browser session, are shown once, stored only as SHA-256 hashes, bound to the Firebase `uid`, expire automatically, and can be revoked at any time. They use the same bearer-token MCP transport.

| Endpoint | Purpose |
| --- | --- |
| `POST /mcp` | Streamable HTTP MCP; accepts MCP OAuth bearer tokens and personal access tokens. |
| `GET /health` | Unauthenticated liveness endpoint. |
| `GET /.well-known/oauth-protected-resource` | Protected-resource metadata. The `/mcp` suffix variant is also served. |
| `GET /.well-known/oauth-authorization-server` | OAuth authorization-server metadata. The `/mcp` suffix variant is also served. |
| `POST /oauth/register` | Dynamic Client Registration, for MCP clients that do not support CIMD. |
| `GET /oauth/authorize` | Authorization request, Firebase browser sign-in, then consent. |
| `POST /oauth/token` | Authorization-code and refresh-token grants. |
| `GET /tokens` | Firebase-authenticated personal access-token management page. |
| `POST /tokens` | Creates a personal access token and shows it once. |
| `POST /tokens/revoke` | Revokes one of the signed-in user’s personal access tokens. |
| `GET /connect/untappd` | Starts the separate Untappd authorization flow for the signed-in Firebase user. |

The server keeps only hashes of MCP access, authorization-code, and refresh tokens in Firestore. Refresh tokens rotate; a reused refresh token revokes its whole token family. Untappd access tokens use AES-256-GCM encryption before storage.

### Legacy degustation-app migration

When a user opens `/tokens`, the server first checks for an existing encrypted credential. If none exists, it imports `users/{uid}.untappdAccessToken` from the old degustation app. When Firebase UID differs, it falls back only to one exact match of the user’s **verified Firebase email**. The token is validated with Untappd before being encrypted into `untappd_credentials/{uid}`. Legacy Firestore documents are read-only during this migration and their plaintext token is not deleted.

## Untappd connection flow

1. The user opens `/connect/untappd` and signs in with Firebase if no browser session exists.
2. The server creates a signed, ten-minute Untappd OAuth `state` bound to that Firebase `uid`, then redirects the user to Untappd.
3. Untappd redirects to `/connect/untappd/callback`.
4. The server exchanges the code, fetches the profile, and stores the encrypted token under `untappd_credentials/{firebaseUid}`.

## Connecting a client

Claude and ChatGPT both connect to `https://YOUR_CLOUD_RUN_OR_CUSTOM_DOMAIN/mcp` over OAuth:

1. Add a custom connector pointing at `.../mcp` and choose **OAuth**. Both clients discover this server's client metadata automatically (CIMD); Dynamic Client Registration also works.
2. On first use the client opens this server's authorization page. Sign in with the Google account whose Untappd data the client should use, then approve the `untappd:read` / `untappd:write` scopes.

That Google account must already have Untappd connected — if not, open `https://YOUR_CLOUD_RUN_OR_CUSTOM_DOMAIN/connect/untappd` first and connect it.

### Personal access token (alternative)

For header-only auth, or a client that cannot run the OAuth flow:

1. Open `https://YOUR_CLOUD_RUN_OR_CUSTOM_DOMAIN/tokens` and sign in with the Google account whose Untappd data you want to use.
2. Select **Create token for Claude**, then copy the displayed header value — shown once only.
3. In the connector settings use `.../mcp`, set **Authentication: None**, and add this request header:

```text
Authorization: Bearer pat_…
```

Use the **Revoke** button on `/tokens` immediately if the token is exposed. A token carries the same read/write Untappd scope as an OAuth connection, so the client must still confirm before check-ins.

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

Grant the Cloud Run service account Firestore access for `untappd_credentials`, Secret Manager access for the three runtime secrets, and only `firebaseauth.users.createSession` plus `firebaseauth.users.get` for secure Firebase session handling. Keep Firebase service-account credentials and Untappd credentials out of the image and repository.

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
MCP_ALLOWED_ORIGINS=https://claude.ai,https://chatgpt.com
MCP_PERSONAL_ACCESS_TOKEN_TTL_SECONDS=15552000
# Optional: override Untappd's public Algolia search keys only if they rotate.
# Set both or neither; low-sensitivity, plain env is fine.
UNTAPPD_ALGOLIA_APP_ID=
UNTAPPD_ALGOLIA_SEARCH_KEY=
```

`PUBLIC_BASE_URL` and `UNTAPPD_REDIRECT_URI` must use the exact final HTTPS origin. Add that hostname to **Firebase Console → Authentication → Settings → Authorized domains** before using the OAuth browser login. The browser config fields are Firebase public configuration, not credentials.

Create Firestore TTL policies for `expiresAt` in these collection groups: `mcp_oauth_transactions`, `mcp_oauth_authorization_codes`, `mcp_oauth_access_tokens`, `mcp_oauth_refresh_tokens`, and `mcp_personal_access_tokens`. TTL reduces retained metadata; server-side expiry checks remain mandatory.

## Untappd API rate limit

Untappd allows **100 API requests per rolling hour per app key**, shared by every user of this server. To stay within it:

- `search_beers` runs against Untappd's public Algolia beer index and does **not** spend the quota. It falls back to the Untappd `search/beer` API (which does) only when Algolia returns an error; every fallback logs `"message":"algolia_search_fallback"`.
- Every real Untappd API response is recorded from its `X-RateLimit-*` headers and emitted as a structured `"message":"untappd_api_call"` log line (`rateLimitRemaining`, per-instance counters) — suitable for a Cloud Logging metric and a low-remaining alert.
- `get_untappd_api_usage` returns the latest `X-RateLimit-Remaining` (Untappd's account-wide figure) plus this process's own counters, without making a call.
- `check_user_had_beer` pages the target user's distinct beers (up to `maxRequests` × 50) and aborts early with `stoppedForRateLimit: true` once the shared remaining budget drops to ~10.

Cloud Run runs several instances, each with its own `instance.*` counters, so those undercount true shared usage; `lastSeen.remaining` is authoritative whenever a recent call ran on the serving instance.

## Security notes

- **Close Firestore Rules before deployment.** Cloud Run uses the Admin SDK, so it continues to work after browser access is denied. With open rules, an attacker could forge an OAuth token record.
- Untappd tokens are encrypted before reaching Firestore, but rotate the encryption key with a planned re-encryption migration.
- The OAuth callback uses a signed and expiring `state` value to prevent CSRF.
- OAuth authorization codes are one-time, expire after one minute, and require PKCE S256. Redirect URIs are exact-match registered values.
- MCP access tokens are short-lived and audience-bound to this server. Untappd tokens are never accepted at `/mcp`.
- Personal access tokens are displayed only once, stored as hashes, expire after 180 days by default, and can be revoked from `/tokens`.
- `check_in` is intentionally marked non-idempotent. The calling model must get user confirmation before invoking it.
- `untappd:write` is required for `check_in`; all other current tools (including `get_untappd_api_usage`) require `untappd:read`.
