# Cloud boards preview

Cloud prototype. Boards live on Cloudflare, several people edit one board at once and see each other's cursors, and each person generates images with their own Codex through the local helper. Results are uploaded to the shared board.

The stack uses Workers static assets + API (`cloud/worker.mjs`), one Durable Object per board running Yjs (`cloud/board-room.mjs`), a board directory Durable Object, R2 for images, and D1 for registered users. **Sign in with Google** accepts any verified Google account. Every signed-in person can use all features and access all shared boards, images, templates, and helper downloads. There is no allowlist or role system.

Google authenticates the person. Generation continues through each person's own Codex and local helper. Signing into Google and signing into Codex are separate steps.

## Configure Google sign-in

1. Create or select a project in Google Cloud Console. Open **Google Auth Platform** and configure the OAuth consent screen under **Branding**, including the app name, support email, and developer contact information. Set the privacy-policy URL to `https://concept-graph-cloud.concept-graph.workers.dev/privacy` (or your deployment's origin followed by `/privacy`). The Worker serves this public, self-contained English page without sign-in; the sign-in screen links to it as **Privacy**.
2. Under **Audience**, select **External** to accept Google accounts outside your organization. Under **Data Access**, request only `openid`, `email`, and `profile`. Google exempts these basic identity scopes from the test-user allowlist even while the app is in **Testing**. For a published deployment, set its publishing status to **In production** and complete any branding requirements shown in the console. Organization policies may still restrict an individual account. See Google's OAuth app-state documentation. [Google OAuth app states](https://developers.google.com/identity/protocols/oauth2/production-readiness/overview)
3. Under **Clients**, create an OAuth client of type **Web application**. Register these exact **Authorized redirect URIs**.

   ```text
   https://concept-graph-cloud.concept-graph.workers.dev/api/auth/google/callback
   http://localhost:8787/api/auth/google/callback
   ```

   If your deployed hostname differs, register its exact origin followed by `/api/auth/google/callback`. To test a second local cookie session at `http://127.0.0.1:8787`, also register `http://127.0.0.1:8787/api/auth/google/callback`. The Worker derives the callback URI from the request origin. Google permits HTTP for localhost redirects. [Google web-server OAuth setup](https://developers.google.com/identity/protocols/oauth2/web-server)
4. Copy the client ID and client secret into your local configuration or Cloudflare secrets as described below. Generate a long random `SESSION_SECRET`, for example with `openssl rand -hex 32`.

The Worker implements the authorization-code flow with state, nonce, and S256 PKCE. A signed, HttpOnly, SameSite=Lax cookie stores the temporary state for ten minutes and is cleared on callback. The Worker validates the ID token received directly from Google's HTTPS token endpoint using TLS server validation, as permitted by OIDC Core, and checks issuer, client audience, expiry, nonce, and verified email. It also checks the authorized party when present and requires a subject. [OIDC Core ID token validation](https://openid.net/specs/openid-connect-core-1_0.html#IDTokenValidation)

The signed `cg_session` cookie lasts 30 days and contains the lowercased email, display name, email-derived cursor color, and issue time. HTTPS cookies have the Secure flag. `/api/cloud/me` returns the person's `name`, `color`, and `email`. Names fall back to the email's local part and are limited to 40 characters. Cursor colors use the existing ten-color palette, so collisions remain possible. Old name-only cookies are rejected, and existing users must sign in again. OAuth tokens are discarded after sign-in. Callback failures return a fixed short error for the login screen.

## Registered users in D1

`cloud/wrangler.jsonc` binds `DB` to the existing D1 database **concept-graph-cloud**, ID `cb8f2e9c-34aa-4861-883e-498832370baf`. No database creation or migration command is needed: each successful Google callback lazily creates the `users` table if necessary and upserts one row per lowercased email. Columns are `email` (primary key), `google_sub` (Google account ID), `name` (the display name used on boards), `created_at`, `last_login_at` (UTC ISO timestamps), and `login_count`. Repeat sign-ins update the profile, last-login time, and count while preserving the first-login time. Existing sessions are recorded when the person next signs in, not on each page visit.

Browse registrations in **Cloudflare dashboard → Storage & databases → D1 → concept-graph-cloud → users table**, or query from this repository:

```sh
npx wrangler d1 execute concept-graph-cloud --remote -c cloud/wrangler.jsonc --command "SELECT * FROM users"
```

The table appears after the first successful registry write. Local development sign-in also records users in local D1 storage; `google_sub` is null for a dev-only user, and a dev sign-in preserves any previously recorded Google ID. D1 failures are logged and do not block sign-in, so the registry and login counts are best effort. There are no roles, account restrictions, or user-list API; the owner browses D1 directly.

The `/privacy` page describes Google identity and sign-in bookkeeping, the session cookie, shared board and image storage on Cloudflare, generation through each person's local helper and own Codex/ChatGPT account with prompts/reference images sent to OpenAI, no ads or data sales, and deletion requests to `knifest17@gmail.com`. It discloses access by signed-in workspace users and the services used by the app.

## Run locally

```sh
cp cloud/.dev.vars.example cloud/.dev.vars
# Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and SESSION_SECRET in cloud/.dev.vars.
npm run cloud:dev   # http://localhost:8787
CONCEPT_GRAPH_SITE=http://localhost:8787 npm run helper
```

Sign in, open a board, choose **Pair helper** and paste the code the helper prints. To try two people on one machine, open the second window at `http://127.0.0.1:8787` (separate cookies).

For local browser verification without Google credentials, add `DEV_LOGIN="1"` to `cloud/.dev.vars` and set `SESSION_SECRET`. The login screen then shows a **Local development sign-in** form for a display name and email. `POST /api/auth/dev` accepts that identity only when the flag is exactly `1` and the request hostname is exactly `localhost` or `127.0.0.1`. `GET /api/auth/config` reports whether this form is available. A supplied cross-origin `Origin` is rejected. The dev route returns 404 on every other host, even if the flag is set. Keep this flag out of `wrangler.jsonc` and deployed configuration, and remove it from local configuration when finished.

## Deploy to Cloudflare

1. Create a free Cloudflare account and enable R2 in the dashboard (it asks for a payment method; 10 GB/month is free).
2. `npx wrangler login`
3. `npx wrangler r2 bucket create concept-graph-files`
4. `npm run cloud:deploy` — prints the site URL. To include helper downloads on the site, deploy again with `CONCEPT_GRAPH_NODE_ARCHIVES` (folder with the Node.js archives listed in `scripts/helper-build.mjs`) and `CONCEPT_GRAPH_HELPER_SITE=<site URL>`; the launchers then point at your site.
5. Configure the three secrets, then verify **Sign in with Google** at the deployed URL.

   ```sh
   npx wrangler secret put GOOGLE_CLIENT_ID -c cloud/wrangler.jsonc
   npx wrangler secret put GOOGLE_CLIENT_SECRET -c cloud/wrangler.jsonc
   npx wrangler secret put SESSION_SECRET -c cloud/wrangler.jsonc
   ```

   The shared `TEAM_CODE` secret and `/api/cloud/login` endpoint have been retired. If the old secret exists in Cloudflare, remove it with `npx wrangler secret delete TEAM_CODE -c cloud/wrangler.jsonc`.

Share the URL. Anyone with a verified Google account can sign in and access the shared workspace. Each person who generates needs the helper. Download it from **Pair helper** on the site (when built with helper downloads), or run it from a checkout of this repository.

```sh
npm ci
CONCEPT_GRAPH_SITE=https://<your-worker-url> npm run helper
```

After pairing, a computer without Codex shows **Install Codex**. On Apple Silicon/Intel Mac and Windows x64 (including x64 emulation on ARM), the helper can download and install a pinned, SHA-256-verified Codex release from OpenAI’s official GitHub releases (up to 155 MiB), then open the existing ChatGPT sign-in flow. No separate Node.js or Codex setup is needed for the packaged helper. Existing user installations take priority; the managed copy shares the desktop app’s location and never overwrites an incomplete installation. Unsupported platforms still require manual Codex setup. For isolated installer tests, `CONCEPT_GRAPH_CODEX_INSTALL_DIR` overrides the managed root; it does not change board storage.

Use Chrome and allow its local network access prompt so the page can reach the helper on `127.0.0.1`.

Cloud builds put binaries and `concept-graph-helper-downloads.json` together in `dist-downloads` (override with `CONCEPT_GRAPH_DOWNLOADS_OUTPUT`); `CONCEPT_GRAPH_SITE_OUTPUT` remains the safety boundary that downloads must stay outside. With `CONCEPT_GRAPH_NODE_ARCHIVES` and `CONCEPT_GRAPH_HELPER_SITE` set, `cloud:helpers` builds `Concept-Graph-Helper-windows-x64-setup.exe`; `cloud:helpers:mac` builds both Mac DMGs (`CONCEPT_GRAPH_MAC_ARCHS` selects architectures). Set `CONCEPT_GRAPH_MAC_SIGN_IDENTITY` (full Developer ID Application identity) and `CONCEPT_GRAPH_MAC_NOTARY_PROFILE` (Keychain profile) for signed, notarized apps/DMGs; defaults are ad hoc previews. `cloud:helpers:upload` validates the manifest and requires every referenced installer in the downloads directory, then uploads binaries to R2 before uploading the manifest to `concept-graph-files/downloads/concept-graph-helper-downloads.json`. The Worker serves that manifest publicly at `/concept-graph-helper-downloads.json` with `Cache-Control: no-store`; static site builds and deploys do not touch the R2 downloads or manifest. `cloud:deploy` runs helper builds/uploads when configured. For the one-time migration of existing downloads, copy `dist-cloud/concept-graph-helper-downloads.json` to `dist-downloads/concept-graph-helper-downloads.json` before the next site build, then run `npm run cloud:helpers:upload` before deploying the updated Worker. Downloads require sign-in: Mac users drag the helper to Applications; Windows users run the installer, then copy the pairing code from its window. If Windows shows **Windows protected your PC**, choose **More info → Run anyway**. Next time, start **Concept Graph Helper** from the Start menu.

The Windows installer is built entirely on macOS using the .NET SDK at `~/.dotnet/dotnet`, NSIS (`brew install makensis`, default `/opt/homebrew/bin/makensis`), and the existing Swift icon renderer. Override tool paths with `CONCEPT_GRAPH_DOTNET` / `CONCEPT_GRAPH_MAKENSIS`. NuGet restore downloads the pinned `Microsoft.NETFramework.ReferenceAssemblies` 1.0.3 package; the launcher targets .NET Framework 4.8, included in Windows 10 version 1903+ and Windows 11, so no .NET runtime is bundled. Node's archive checksum is checked before building. Build intermediates stay in temporary storage and NuGet packages default to `$TMPDIR/concept-graph-nuget` (override `NUGET_PACKAGES`). The build removes the obsolete Windows ZIP from the downloads output only after the installer and manifest are written.

Setup requires no administrator privileges and installs under `%LOCALAPPDATA%\Programs\Concept Graph Helper`, with Start-menu and desktop shortcuts. Rerun setup to upgrade; if the helper is open, finish or stop any generation, close its window, and choose **Retry**. Setup and uninstall never force-kill a running helper. Closing the helper asks for confirmation, requests a graceful stop, then terminates remaining child processes with a Windows Job Object; killing the launcher also terminates its job. Uninstall removes only the packaged files, shortcuts, and HKCU uninstall entry. It preserves `%USERPROFILE%\.concept-graph`, Codex authentication, and `%LOCALAPPDATA%\Concept Graph\codex`. There is no ZIP fallback, login autostart, automatic update, or Windows code signing. Compilation and packaging on macOS do not prove Windows runtime behavior; verify installation, pairing, duplicate launch, normal/forced shutdown, upgrade, and data-preserving uninstall in a Windows VM before publication.

## Not yet supported in cloud boards

Board export/import, custom template library, MCP, run diagnostics beyond the error text, board permissions, voice chat.

## Verify authentication

Run the port-free cloud suites with Node.js 22.15 or later so the Worker runtime tests execute.

```sh
node --test tests/cloud-worker-auth.test.mjs tests/cloud-worker-runtime.test.mjs tests/cloud-boards.test.mjs tests/cloud-sync.test.mjs tests/cloud-sync-generation.test.mjs tests/cloud-download-upload.test.mjs
```

The tests mock Google's token endpoint and cover state/nonce/PKCE, malformed and rejected tokens, callback errors, cookie expiry and flags, old-cookie rejection, email identity, loopback-only dev sign-in, logout, and authenticated access to shared resources. A D1 stub backed by in-memory SQLite checks first and repeat sign-in records, profile updates, preserved creation times, independent users, and sign-in continuing when D1 fails. Tests also check the database binding and public `/privacy` route without authentication or other bindings. The helper integration tests in `tests/cloud-jobs.test.mjs` bind local ports and can be run separately with `node --test tests/cloud-jobs.test.mjs`.

For a live check, configure the Google client and local secrets, run `npm run cloud:dev`, and visit `http://localhost:8787`. Verify Google sign-in, account selection, shared board access, logout, cancellation, and signing in again. Also verify the dev form appears only with `DEV_LOGIN="1"` on loopback and remains hidden on the deployed hostname. Pair the helper and generate an image to confirm the existing Codex path end to end.
