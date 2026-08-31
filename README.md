# Untappd MCP

A multi-user [Model Context Protocol](https://modelcontextprotocol.io/) server for Untappd. It keeps Untappd credentials on the server and exposes a small, explicit tool surface for search, profile data, wishlists, beer history, and check-ins.

## Current capabilities

- Streamable HTTP endpoint: `POST /mcp`
- Optional Auth0-backed ChatGPT endpoint: `POST /chatgpt/mcp`
- OAuth 2.1 authorization-code flow with mandatory PKCE S256
- OAuth protected-resource and authorization-server metadata
- Client ID Metadata Document (CIMD) support for Claude and ChatGPT, plus a pre-registered public Claude client fallback
- Short-lived, audience-bound opaque access tokens and rotating refresh tokens
- Firebase Auth Google sign-in and a secure server-side browser session
- Revocable, time-limited personal access tokens for Claude while its custom-connector OAuth callback is unavailable
- `search_beers` and `get_beer`
- `get_my_profile`, `get_my_wishlist`, and `get_my_beers`
- `get_user_profile`, `get_user_beers`, and `get_user_checkins` for any Untappd username
- `check_user_had_beer` — "has USERNAME ever checked in this beer?", with their rating and first/last dates
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

For Claude’s current custom-connector OAuth callback failure, the server also provides personal access tokens. They are created only from an authenticated Firebase browser session, are shown once, stored only as SHA-256 hashes, bound to the Firebase `uid`, expire automatically, and can be revoked at any time. They use the same bearer-token MCP transport but do not depend on Claude completing an authorization-code exchange.

| Endpoint | Purpose |
| --- | --- |
| `POST /mcp` | Streamable HTTP MCP; accepts only MCP OAuth bearer tokens. |
| `POST /chatgpt/mcp` | Separate Auth0-protected MCP endpoint for ChatGPT. It is disabled until `AUTH0_ISSUER` is configured and never changes Claude’s `/mcp` flow. |
| `GET /health` | Unauthenticated liveness endpoint. |
| `GET /.well-known/oauth-protected-resource` | Protected-resource metadata. The `/mcp` suffix variant is also served. |
| `GET /.well-known/oauth-authorization-server` | OAuth authorization-server metadata. |
| `POST /oauth/register` | Dynamic Client Registration endpoint for MCP clients such as ChatGPT. |
| `GET /oauth/authorize` | Authorization request, Firebase browser sign-in, then consent. |
| `POST /oauth/token` | Authorization-code and refresh-token grants. |
| `GET /tokens` | Firebase-authenticated personal access-token management page. |
| `POST /tokens` | Creates a personal access token and shows it once. |
| `POST /tokens/revoke` | Revokes one of the signed-in user’s personal access tokens. |
| `GET /connect/untappd` | Starts the separate Untappd authorization flow for the signed-in Firebase user. |

The server keeps only hashes of MCP access, authorization-code, and refresh tokens in Firestore. Refresh tokens rotate; a reused refresh token revokes its whole token family. Untappd access tokens use AES-256-GCM encryption before storage.

### Auth0 path for ChatGPT

`/chatgpt/mcp` is intentionally a separate protected resource. It leaves `/mcp`, the custom OAuth server, existing Claude connector settings, and personal access tokens unchanged. When enabled, ChatGPT receives an Auth0 access token for this exact audience:

```text
https://YOUR_CLOUD_RUN_OR_CUSTOM_DOMAIN/chatgpt/mcp
```

The server validates the Auth0 JWT against the tenant JWKS, requires that exact audience and issuer, and maps a verified Auth0 email claim to the matching verified Firebase user. Therefore existing encrypted Untappd credentials and the read-only legacy-token migration remain keyed by the same Firebase UID.

#### Configure Auth0

1. Create an Auth0 tenant and a **Regular Web Application** for ChatGPT. Enable the Authorization Code and Refresh Token grant types.
2. Create an Auth0 **API** with identifier `https://YOUR_CLOUD_RUN_OR_CUSTOM_DOMAIN/chatgpt/mcp`, signing algorithm **RS256**, and these permissions:

   ```text
   untappd:read
   untappd:write
   ```

   Configure the tenant’s Resource Parameter Compatibility Profile so Auth0 accepts the standard OAuth `resource` parameter. ChatGPT sends that parameter instead of Auth0’s proprietary `audience` parameter.
3. Enable an identity connection with verified email, normally Google. For production Google login, register the Auth0 callback `https://YOUR_AUTH0_DOMAIN/login/callback` in Google Cloud and add its client ID and secret to the Auth0 Google connection.
4. Add and deploy this **Post Login Action**. Replace `YOUR_CLOUD_RUN_OR_CUSTOM_DOMAIN` exactly; claims must use the same origin as `PUBLIC_BASE_URL`.

   ```js
   exports.onExecutePostLogin = async (event, api) => {
     const namespace = 'https://YOUR_CLOUD_RUN_OR_CUSTOM_DOMAIN/auth0';
     if (event.user.email && event.user.email_verified) {
       api.accessToken.setCustomClaim(`${namespace}/email`, event.user.email);
       api.accessToken.setCustomClaim(`${namespace}/email_verified`, true);
     }
   };
   ```

5. Set the non-secret Cloud Run variable:

   ```text
   AUTH0_ISSUER=https://YOUR_AUTH0_TENANT.REGION.auth0.com/
   ```

   Keep the trailing slash. No Auth0 client secret is stored by Untappd MCP.
6. Create a new ChatGPT connector using `https://YOUR_CLOUD_RUN_OR_CUSTOM_DOMAIN/chatgpt/mcp`, choose **OAuth** then **Use your own OAuth client**, and copy the callback URL ChatGPT shows into the Auth0 application’s **Allowed Callback URLs**. Finally paste that Auth0 application’s client ID and client secret into ChatGPT. Select the Auth0-supported client authentication method shown by the application settings.

Auth0 users must sign in with a verified email that belongs to a Firebase user. A new person should first open `/connect/untappd`, sign in with Firebase using that email, and connect Untappd; later Auth0 tokens with the same verified email resolve to that Firebase UID.

### Legacy degustation-app migration

When a user opens `/tokens`, the server first checks for an existing encrypted credential. If none exists, it imports `users/{uid}.untappdAccessToken` from the old degustation app. When Firebase UID differs, it falls back only to one exact match of the user’s **verified Firebase email**. The token is validated with Untappd before being encrypted into `untappd_credentials/{uid}`. Legacy Firestore documents are read-only during this migration and their plaintext token is not deleted.

## Untappd connection flow

1. The user opens `/connect/untappd` and signs in with Firebase if no browser session exists.
2. The server creates a signed, ten-minute Untappd OAuth `state` bound to that Firebase `uid`, then redirects the user to Untappd.
3. Untappd redirects to `/connect/untappd/callback`.
4. The server exchanges the code, fetches the profile, and stores the encrypted token under `untappd_credentials/{firebaseUid}`.

Legacy field `users/{uid}.untappdAccessToken` is intentionally not read. Migrate it through an admin-only one-time job after Firestore rules have been closed; do not expose that field to browsers.

## Claude connector setup

Claude’s custom-connector OAuth callback currently fails before it calls the token endpoint, even after a valid authorization code is delivered. Use a personal access token until that issue is fixed:

1. Open `https://YOUR_CLOUD_RUN_OR_CUSTOM_DOMAIN/tokens` and sign in with the Firebase account whose Untappd data you want Claude to use.
2. Select **Create token for Claude**, then copy the displayed header value. It is shown once only.
3. In Claude’s connector settings, use `https://YOUR_CLOUD_RUN_OR_CUSTOM_DOMAIN/mcp`, select **Authentication: None**, and add this request header:

```text
Authorization: Bearer pat_…
```

Use the **Revoke** button on `/tokens` immediately if the token is exposed. A token uses the same read/write Untappd scope as an OAuth connection, so Claude must still ask for confirmation before check-ins.

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
# Optional: enables only /chatgpt/mcp, never changes /mcp
AUTH0_ISSUER=https://YOUR_AUTH0_TENANT.REGION.auth0.com/
```

`PUBLIC_BASE_URL` and `UNTAPPD_REDIRECT_URI` must use the exact final HTTPS origin. Add that hostname to **Firebase Console → Authentication → Settings → Authorized domains** before using the OAuth browser login. The browser config fields are Firebase public configuration, not credentials.

Create Firestore TTL policies for `expiresAt` in these collection groups: `mcp_oauth_transactions`, `mcp_oauth_authorization_codes`, `mcp_oauth_access_tokens`, `mcp_oauth_refresh_tokens`, and `mcp_personal_access_tokens`. TTL reduces retained metadata; server-side expiry checks remain mandatory.

## Security notes

- **Close Firestore Rules before deployment.** Cloud Run uses the Admin SDK, so it continues to work after browser access is denied. With open rules, an attacker could forge an OAuth token record.
- Untappd tokens are encrypted before reaching Firestore, but rotate the encryption key with a planned re-encryption migration.
- The OAuth callback uses a signed and expiring `state` value to prevent CSRF.
- OAuth authorization codes are one-time, expire after one minute, and require PKCE S256. Redirect URIs are exact-match registered values.
- MCP access tokens are short-lived and audience-bound to this server. Untappd tokens are never accepted at `/mcp`.
- Personal access tokens are displayed only once, stored as hashes, expire after 180 days by default, and can be revoked from `/tokens`.
- `check_in` is intentionally marked non-idempotent. The calling model must get user confirmation before invoking it.
- `untappd:write` is required for `check_in`; all other current tools require `untappd:read`.
