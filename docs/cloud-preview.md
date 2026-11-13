# Cloud boards preview

Cloud prototype. Boards live on Cloudflare, several people edit one board at once and see each other's cursors, and each person generates images with their own Codex through the local helper, or, when the site owner sets it up, with Nano Banana on the company's Gemini API key or GPT Image on its OpenAI API key (see [Nano Banana](#nano-banana-on-the-companys-gemini-key) and [GPT Image](#gpt-image-on-the-companys-openai-key)). Results are added to the shared board.

The stack uses Workers static assets + API (`cloud/worker.mjs`), one Durable Object per board running Yjs (`cloud/board-room.mjs`), a board directory Durable Object, R2 for images, and D1 for registered users. **Sign in with Google** accepts any verified Google account, and anyone signed in can create boards. A new board is private to its owner and the people they invite; the owner can also share it by link or with everyone who signs in, and chooses who can edit and who can only view (see [Sharing boards](#sharing-boards)). Nano Banana and GPT Image share one allowed list. There is no other allowlist.

Google authenticates the person. Codex generation continues through each person's own Codex and local helper. Signing into Google and signing into Codex are separate steps.

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

The table appears after the first successful registry write. Local development sign-in also records users in local D1 storage; `google_sub` is null for a dev-only user, and a dev sign-in preserves any previously recorded Google ID. D1 failures are logged and do not block sign-in, so the registry and login counts are best effort. There are no account restrictions or user-list API; the owner browses D1 directly. Board roles live in the board directory, not in D1.

The `/privacy` page describes Google identity and sign-in bookkeeping, the session cookie, shared board and image storage on Cloudflare, generation through each person's local helper and own Codex/ChatGPT account with prompts/reference images sent to OpenAI, Nano Banana generations sent to Google's Gemini API under the site owner's account with per-person usage records, GPT Image generations sent to OpenAI's Images API under the site owner's account with the same usage records, no ads or data sales, and deletion requests to `knifest17@gmail.com`. It describes who can see a board (owner, invited people, link and everyone sharing, view-only access), what is stored to enforce that, and the services used by the app.

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
3. `npx wrangler r2 bucket create concept-graph-files`, then add its backup lock and lifecycle rules (see [Version history, deleted boards and backups](#version-history-deleted-boards-and-backups)).
4. `npm run cloud:deploy` — prints the site URL. To include helper downloads on the site, deploy again with `CONCEPT_GRAPH_NODE_ARCHIVES` (folder with the Node.js archives listed in `scripts/helper-build.mjs`) and `CONCEPT_GRAPH_HELPER_SITE=<site URL>`; the launchers then point at your site.
5. Configure the secrets, then verify **Sign in with Google** at the deployed URL. `SITE_OWNER_EMAIL` is your own Google email: you become the owner of the boards created before sharing (see [Sharing boards](#sharing-boards)).

   ```sh
   npx wrangler secret put GOOGLE_CLIENT_ID -c cloud/wrangler.jsonc
   npx wrangler secret put GOOGLE_CLIENT_SECRET -c cloud/wrangler.jsonc
   npx wrangler secret put SESSION_SECRET -c cloud/wrangler.jsonc
   npx wrangler secret put SITE_OWNER_EMAIL -c cloud/wrangler.jsonc
   ```

   The shared `TEAM_CODE` secret and `/api/cloud/login` endpoint have been retired. If the old secret exists in Cloudflare, remove it with `npx wrangler secret delete TEAM_CODE -c cloud/wrangler.jsonc`.

Share the URL. Anyone with a verified Google account can sign in and create boards; each person sees only the boards they own, were invited to, opened from a link, or that are open to everyone. Each person who generates needs the helper. Download it from **Pair helper** on the site (when built with helper downloads), or run it from a checkout of this repository.

```sh
npm ci
CONCEPT_GRAPH_SITE=https://<your-worker-url> npm run helper
```

After pairing, a computer without Codex shows **Install Codex**. On Apple Silicon/Intel Mac and Windows x64 (including x64 emulation on ARM), the helper can download and install a pinned, SHA-256-verified Codex release from OpenAI’s official GitHub releases (up to 155 MiB), then open the existing ChatGPT sign-in flow. No separate Node.js or Codex setup is needed for the packaged helper. Existing user installations take priority; the managed copy shares the desktop app’s location and never overwrites an incomplete installation. Unsupported platforms still require manual Codex setup. For isolated installer tests, `CONCEPT_GRAPH_CODEX_INSTALL_DIR` overrides the managed root; it does not change board storage.

Use Chrome and allow its local network access prompt so the page can reach the helper on `127.0.0.1`. Safari and in-app WebKit browsers (Telegram's, for example) treat that request as mixed content ([WebKit bug 171934](https://bugs.webkit.org/show_bug.cgi?id=171934)) and fail with "Load failed"; the pairing screen warns about this and offers to copy the page link.

Cloud builds put binaries and `concept-graph-helper-downloads.json` together in `dist-downloads` (override with `CONCEPT_GRAPH_DOWNLOADS_OUTPUT`); `CONCEPT_GRAPH_SITE_OUTPUT` remains the safety boundary that downloads must stay outside. With `CONCEPT_GRAPH_NODE_ARCHIVES` and `CONCEPT_GRAPH_HELPER_SITE` set, `cloud:helpers` builds `Concept-Graph-Helper-windows-x64-setup.exe`; `cloud:helpers:mac` builds both Mac DMGs (`CONCEPT_GRAPH_MAC_ARCHS` selects architectures). Set `CONCEPT_GRAPH_MAC_SIGN_IDENTITY` (full Developer ID Application identity) and `CONCEPT_GRAPH_MAC_NOTARY_PROFILE` (Keychain profile) for signed, notarized apps/DMGs; defaults are ad hoc previews. `cloud:helpers:upload` validates the manifest and requires every referenced installer in the downloads directory, then uploads binaries to R2 before uploading the manifest to `concept-graph-files/downloads/concept-graph-helper-downloads.json`. The Worker serves that manifest publicly at `/concept-graph-helper-downloads.json` with `Cache-Control: no-store`; static site builds and deploys do not touch the R2 downloads or manifest. `cloud:deploy` runs helper builds/uploads when configured. For the one-time migration of existing downloads, copy `dist-cloud/concept-graph-helper-downloads.json` to `dist-downloads/concept-graph-helper-downloads.json` before the next site build, then run `npm run cloud:helpers:upload` before deploying the updated Worker. Downloads require sign-in: Mac users drag the helper to Applications; Windows users run the installer, then copy the pairing code from its window. If Windows shows **Windows protected your PC**, choose **More info → Run anyway**. Next time, start **Concept Graph Helper** from the Start menu.

The Windows installer is built entirely on macOS using the .NET SDK at `~/.dotnet/dotnet`, NSIS (`brew install makensis`, default `/opt/homebrew/bin/makensis`), and the existing Swift icon renderer. Override tool paths with `CONCEPT_GRAPH_DOTNET` / `CONCEPT_GRAPH_MAKENSIS`. NuGet restore downloads the pinned `Microsoft.NETFramework.ReferenceAssemblies` 1.0.3 package; the launcher targets .NET Framework 4.8, included in Windows 10 version 1903+ and Windows 11, so no .NET runtime is bundled. Node's archive checksum is checked before building. Build intermediates stay in temporary storage and NuGet packages default to `$TMPDIR/concept-graph-nuget` (override `NUGET_PACKAGES`). The build removes the obsolete Windows ZIP from the downloads output only after the installer and manifest are written.

Setup requires no administrator privileges and installs under `%LOCALAPPDATA%\Programs\Concept Graph Helper`, with Start-menu and desktop shortcuts. Rerun setup to upgrade; if the helper is open, finish or stop any generation, close its window, and choose **Retry**. Setup and uninstall never force-kill a running helper. Closing the helper asks for confirmation, requests a graceful stop, then terminates remaining child processes with a Windows Job Object; killing the launcher also terminates its job. Uninstall removes only the packaged files, shortcuts, and HKCU uninstall entry. It preserves `%USERPROFILE%\.concept-graph`, Codex authentication, and `%LOCALAPPDATA%\Concept Graph\codex`. There is no ZIP fallback, login autostart, automatic update, or Windows code signing. Compilation and packaging on macOS do not prove Windows runtime behavior; verify installation, pairing, duplicate launch, normal/forced shutdown, upgrade, and data-preserving uninstall in a Windows VM before publication.

## Waiting clips

The clips a placeholder plays while a run works are hosted, never bundled: the app ships none, so nothing in the repository or a release package is someone else's footage. Put the files in `clips/` (gitignored) and run `npm run cloud:clips:upload`. It checks every name against `clipPattern` and the 4 MB limit, uploads the files to `concept-graph-files/clips/`, then writes `clips/index.json` last, so a half-finished upload never advertises a clip that is not there yet. The Worker serves them publicly at `/clips/<name>.mp4` (immutable for a year) and the index at `/clips/index.json` (five minutes). Only the cloud build asks for that index (`VITE_CONCEPT_GRAPH_CLOUD`); a desktop board makes no request and its placeholders shimmer without a clip. A placeholder's opening clip comes from `waitingSeed(id)`, so neighbours start apart and step on together; if the index is missing, empty or unreachable the shimmer stays and nothing is retried. Remove a clip with `wrangler r2 object delete concept-graph-files/clips/<name>.mp4 --remote -c cloud/wrangler.jsonc` and upload again so the index drops it.

## Nano Banana on the company's Gemini key

Cloud prompts can generate with **Nano Banana 2.1** (`gemini-nano-banana-2.1`) on one Gemini API key that the company pays for, so allowed teammates need no helper or Codex. Codex stays the default: the arrow beside a prompt's **Generate** button switches that prompt between **Codex**, **Nano Banana** and **GPT Image**; the choice is saved with the prompt and synced. The menu's last line shows how many images you have left today and the team's spend this month, or why Nano Banana is unavailable. A Nano Banana prompt also shows **Variants 1–4** under its text: one Generate then starts that many separate calls at once, and their images arrive as one slideshow. Each variant counts against the daily image limit and the monthly budget; if they do not all fit, nothing starts. If some variants fail, the others are kept and History says how many failed. A **Describe image** node can also run on the site's key: choose **Gemini** in its menu and the description comes from `gemini-3.5-flash-lite` (about half a cent each at the prices in `cloud/nano-banana.mjs`), so people without Codex can describe images too. Descriptions count against the team's monthly budget but not against anyone's daily images.

Generation runs on the server. The Worker checks the person and the limits; the board's Durable Object then sends one request per Generate to Google's Interactions API (`POST https://generativelanguage.googleapis.com/v1beta/interactions`, `Api-Revision: 2026-05-20`, `store: false`), as documented in Google's [image generation guide](https://aistudio.google.com/docs/image-generation). It sends the same inputs as a Codex run: the prompt, its directly connected text and custom-node instructions, and up to 10 reference images (20 MB in total). Each returned image is saved to R2 and placed on the board exactly like a Codex result, with connections, captions, groups, the author's name and history, so everyone on the board sees it. The key never leaves the Worker. A paid call is never retried automatically: if the board's server restarts during a call, the run fails with **Generation was interrupted. Run the prompt again.** Only the person who started a run can cancel it.

### Set up

1. In Google AI Studio, create an API key in a project with billing enabled. Nano Banana 2.1 has no free tier for image output.
2. Store the key as a Worker secret. The command asks for the value: paste it at the prompt, not on the command line.

   ```sh
   npx wrangler secret put GEMINI_API_KEY -c cloud/wrangler.jsonc
   ```

   Then choose who may use it in **Team access** on the boards page (see below). Everyone else can still sign in and use their own Codex.
3. Limits are variables in `cloud/wrangler.jsonc`: `NANO_BANANA_DAILY_IMAGES` (images per person per UTC day, default 50) and `NANO_BANANA_MONTHLY_USD` (the team's spend per UTC calendar month, default 50). Edit the values and run `npm run cloud:deploy`; `0` stops generation through both site providers.

Without `GEMINI_API_KEY`, the option shows **Nano Banana isn’t set up on this site**. Also set a budget alert in Google Cloud: the monthly cap is the site's own estimate, not a limit Google enforces.

### Team access

Site admins decide who may generate with Nano Banana and GPT Image, in **Team access** on the boards page. The site owner (the `SITE_OWNER_EMAIL` secret) is always an admin and the only one who can make or remove other admins. The panel lists everyone who has signed in, newest first, with each person's combined site-generated images today; admins tick **Nano Banana / GPT Image** for a person, or add an email for someone who hasn't signed in yet, or a whole domain such as `@studio.com` (case is ignored, subdomains are not included). Someone with access through a domain shows a greyed tick; remove the domain to change it. Changes apply to the next Generate, without a redeploy. Admins see the email addresses of everyone who signed in; nobody else does.

The list lives in the board-directory Durable Object (`nano_access` and `site_admins`). The old `NANO_BANANA_ALLOWED` secret is copied into it once, the first time this version runs, and is not read again: change access on the site and delete the secret with `npx wrangler secret delete NANO_BANANA_ALLOWED -c cloud/wrangler.jsonc`. Without `SITE_OWNER_EMAIL` nobody can manage access, and only the copied list applies. Agents connected over MCP cannot change access. The routes are `GET /api/cloud/team` and `PATCH /api/cloud/team` with `{ "nano": { "entry": "name@example.com" | "@example.com", "allowed": true | false } }` or, for the owner, `{ "admin": { "email": "…", "admin": true | false } }`; `GET /api/cloud/me` returns the person's `siteRole` (`owner`, `admin` or null).

### Limits and cost

Before each call the site reserves one image for the person and an estimated cost for the team; open reservations count, so simultaneous clicks cannot overshoot a limit. When the call ends it records the images placed and the cost from the token usage Google returns, using the Standard-tier prices read on 2026-11-04 from Google's [pricing page](https://aistudio.google.com/docs/pricing): $1.50 per million input tokens, $7.50 per million text and thinking tokens, and $30 per million image tokens ($0.0336 per 1K image). They are kept in `cloud/nano-banana.mjs`. Calls that Google refused or failed with an error cost nothing; a cancelled or unanswered call keeps its estimate in the month, because Google may still bill it. A reservation that never finishes stops counting against the person after 15 minutes. Usage rows live in the board-directory Durable Object with the person's email; boards store only display names. A full limit stops generation with **Daily limit reached (50/50)** or **Team budget for this month is used up**.

The routes are `GET /api/nano` (setup, access and usage for the signed-in person), `POST /api/boards/<board>/nano` with `{ "nodeId": "…" }`, and `POST /api/boards/<board>/nano/<run>/cancel`.

### Test locally without Google

Run the fake Gemini server (`node scripts/fake-gemini.mjs`, port 8788; put `[two]`, `[text]`, `[refuse]`, `[busy]`, `[error]` or `[slow]` in a prompt to choose its answer) and point a local Worker at it:

```sh
npx wrangler dev -c cloud/wrangler.jsonc --port 8787 --var DEV_LOGIN:1 --var GEMINI_API_KEY:fake-key --var SITE_OWNER_EMAIL:you@example.com --var NANO_BANANA_ENDPOINT:http://127.0.0.1:8788
```

Sign in with the test sign-in as `you@example.com` and give access in **Team access**.

`NANO_BANANA_ENDPOINT` is honoured only for `localhost`, `127.0.0.1` or `[::1]` addresses, so the key can never be sent to another host by mistake. Keep it out of deployed configuration. The automated tests (`tests/nano-banana.test.mjs`) use a fake fetch and never contact Google.

## GPT Image on the company's OpenAI key

Cloud image prompts also offer **GPT Image** (`gpt-image-2.5-flare`) beside Codex and Nano Banana. Allowed people need neither a ChatGPT subscription nor a helper. It runs entirely in the board's Durable Object on the company key, which never reaches the browser, board export or MCP response. **Describe image** nodes still offer only Codex or Gemini; upscaling is unchanged. The local app has no GPT Image option.

Store the key as a Worker secret, then deploy the updated Worker and cloud UI:

```sh
npx wrangler secret put OPENAI_API_KEY -c cloud/wrangler.jsonc
npm run cloud:deploy
```

The OpenAI project needs API billing/credit and access to the model; ChatGPT billing does not fund API usage. Verify the OpenAI organization if the API requires it. Without the key the picker still shows GPT Image, disabled, with **GPT Image isn’t set up on this site**. Authentication, organization-verification, credit, safety and rate-limit failures have separate messages.

The **Team access** checkbox grants both Nano Banana and GPT Image through the existing `nano_access` list. Both debit the same `nano_usage` table, `NANO_BANANA_DAILY_IMAGES` per person per UTC day and `NANO_BANANA_MONTHLY_USD` for the team per UTC month; existing rows are kept without a schema migration. Gemini descriptions and upscales continue using those limits as before. `GET /api/nano` now includes a `gptImage` setup/access/usage object; both generators use the existing `POST /api/boards/<board>/nano` and cancellation routes. The room chooses the provider from the saved prompt. MCP uses `generator: "gpt-image"`, then `start_run`; `whoami` includes its setup and the shared allowance.

One Generate starts **1–4 variants**, one paid request per variant, displayed as one slideshow. All variants must fit the shared limits before any starts. Prompts without references use `/v1/images/generations`; references use JSON `/v1/images/edits` with ordered data URLs and the same named context as Nano Banana. The shared board limit is 10 references and 20 MB total; each GPT data URL is also capped at 20,971,520 characters. The assembled prompt must be at most 32,000 characters. Settings are fixed to `quality: medium`, `output_format: png`, `moderation: auto`. The closest of 1024×1024, 1536×1024 and 1024×1536 is used for an aspect when present, otherwise square (there is no prompt size picker yet).

The supplied [Images API contract](https://developers.openai.com/api/reference/resources/images) and [pricing](https://developers.openai.com/api/docs/pricing), read on **2026-11-13**, specify USD per million tokens: **$5 text input, $8 image input, $30 image output**. `cloud/gpt-image.mjs` settles from response usage, ignoring cached discounts; there is no text-output charge. Before each call it reserves $0.25 per image plus a generous input estimate. Missing usage, cancellation or a lost answer keeps a conservative estimate because the provider may still bill it. Explicit provider errors refund the reservation; successful partial variants stay. Calls time out after five minutes and are never retried automatically, including after a room restart. The site's estimate is not an OpenAI-enforced billing cap.

For local testing without paid calls, run `node scripts/fake-openai.mjs` (port 8789) and put these in the local Worker environment:

```dotenv
OPENAI_API_KEY=fake-local-key
GPT_IMAGE_ENDPOINT=http://127.0.0.1:8789
```

The endpoint override accepts only localhost, 127.0.0.1 or [::1] origins. Keep it out of deployed configuration. The fake accepts `[text]`, `[refuse]`, `[busy]`, `[credit]`, `[key]`, `[verify]`, `[error]` and `[slow]` prompt markers, validates request settings, and serves generated PNGs. `node --test tests/gpt-image.test.mjs` mocks fetch and contacts neither provider. Live model/API compatibility and UI layout still require separate verification.

## Upscaling images

**Upscale image** in the sidebar (or **Upscale image** on an image's right-click menu) adds an upscale node; connect up to four images into it, choose who upscales and how much, and click **Upscale**. Each image comes back as a new image beside the node, connected from it, and every image whose stored size is 2K or more shows a size badge (2K, 3K, 4K, 6K, 8K) in its corner that stays readable when zoomed out; hovering it shows the exact pixels. Generated and upscaled images record their size; images uploaded before this change show no badge.

| Upscaler | What it does | Sizes | Cost (read 2026-11-05) |
| --- | --- | --- | --- |
| **Topaz** (default), `fal-ai/topaz/upscale/image`, model *Standard V2* | The same engine as Krea's enhancer; keeps the picture as it is | ×2, ×4 | $0.08 per image up to 24 MP of output, $0.16 up to 48 MP |
| **SeedVR2**, `fal-ai/seedvr/upscale/image` | Restores fine detail; much cheaper | ×2, ×4 | $0.001 per output megapixel (a 4K image ≈ $0.02) |
| **Nano Banana** (`gemini-nano-banana-2.1`, `response_format.image_size`) | Redraws the image at the new size; small details can change | 2K, 4K | about $0.05 (2K) or $0.11 (4K) |

Nano Banana draws only fixed shapes (1:1, 2:3, 3:4, 4:5, 9:16, 1:4, 1:8 and their landscape forms, 16:9 and 21:9) and fills whichever it is asked for, so an image of another shape would come back cropped or reframed. An image of another shape is therefore sent padded to the nearest shape and the part holding the original is cut back out of the answer, so the result keeps the original's shape and framing. A PNG is padded in the room, repeating its edge pixels, row by row (`cloud/png-frame.mjs`) so it stays well inside the room's 128 MB; other formats are padded, and the answer (always a JPEG: Google accepts no other `mime_type`) is cut back, by [Cloudflare Images](https://developers.cloudflare.com/images/transform-images/bindings/) through the `IMAGES` binding in `cloud/wrangler.jsonc` (5,000 transformations a month on the free plan, two per such upscale; the binding takes images up to 20 MB). Without the binding the image is sent as it is, in the nearest shape.

Upscaling runs in the board's Durable Object like Nano Banana and is governed the same way: only people on the **Team access** list can run it, each upscaled image counts as one of the person's daily images, and its cost counts toward the team's monthly budget (reserved at the largest size it could come out, then settled with what it cost). Outputs are capped at 8192 px on their long side; a ×4 that would pass it is reduced, and an image already that large is refused. Topaz and SeedVR2 return JPEG to keep 4K files small. Agents use `add_upscale_node`, then `start_run`.

Topaz and SeedVR2 run on [fal.ai](https://fal.ai)'s queue API with a company key; Nano Banana uses the existing Gemini key. To turn on the first two, create a fal.ai account, add credit (pay as you go, no subscription), create an API key, and store it as a Worker secret (paste the key at the prompt):

```sh
npx wrangler secret put FAL_KEY -c cloud/wrangler.jsonc
```

Without it the node offers only Nano Banana and says why. fal.ai is prepaid, so while its account has no credit keep `"FAL_UPSCALERS": "off"` in the `vars` of `cloud/wrangler.jsonc` (the setting as of 2026-11-05): the key stays stored, the node and agents offer only Nano Banana, and nodes already set to Topaz or SeedVR2 ask for Nano Banana instead. Remove it or set it to `"on"` and deploy once the account has credit. The image is sent to fal.ai as a data URI; the key never leaves the Worker and is sent only to `queue.fal.run`, never to the host that serves the result. For local testing, `FAL_ENDPOINT` may point at a fake server on localhost (and `NANO_BANANA_ENDPOINT` likewise for Gemini).

## Sharing boards

Sign-in stays open to any verified Google account. Each board has an owner, the person who created it, and one of three general access settings, chosen in the board's **Share** dialog (top bar):

- **Only invited people**, the default for new boards: the owner and the people they invite by email.
- **Anyone with the link**: also anyone signed in who opens the board's link (`/b/<board ID>`). The board then appears in that person's list; nobody else sees it listed.
- **Everyone who signs in**: every signed-in person sees it under **Shared with you**.

The owner chooses **Can edit** or **Can view** for each invited person and for the link or everyone setting. A person gets the strongest role that applies, as in Google Docs: an invited viewer can still edit when the link lets anyone edit. Only the owner can rename the board or change its sharing. Everyone with access can open the dialog to see who has access and their own role: the owner sees invited people's emails, others see display names. No email is sent. The owner copies the link and sends it; an invited person sees the board after signing in with the invited address. Someone who opens a link without access sees **You don't have access to this board** with the owner's name.

Viewers see changes and cursors live and can select, copy, zoom, pan, switch pages and open images fullscreen, but cannot change anything; the editor shows **View only**. The server enforces this: the Worker admits a board connection only for someone with a role and passes that role to the board's Durable Object in a header it sets itself (any copy the client sent is dropped), and the room ignores document updates from view-only connections while their presence still syncs. Renaming and sharing changes need the owner, and site generation needs edit access. When the owner changes access, people already on the board get their new role at once (their board reloads), and anyone who lost access is disconnected.

Boards created before sharing have no recorded owner and belong to the site owner, who can change each one in its Share dialog. Because any Google account can sign in, they were moved once (the first time the version with board history ran) from **Everyone who signs in** to **Anyone with the link**, editing kept: people who had opened them keep them in their list, and nobody else sees them listed. A board its owner opens to everyone again stays that way. The site owner's Google email is a Worker secret, never stored in the repository:

```sh
npx wrangler secret put SITE_OWNER_EMAIL -c cloud/wrangler.jsonc
```

Without it, those boards keep their link access and nobody can change their sharing; their Share dialog says so. For local development, add `SITE_OWNER_EMAIL="you@example.com"` to `cloud/.dev.vars`.

Custom nodes belong to boards. Each board keeps its templates in its Yjs document, so they sync live: everyone who can open the board can use them, and people who can edit it can change them (the last edit wins). A board created before this change copies the old site-wide library into its document the first time it opens; new boards start with none. The old library stays untouched in the board directory, and `/api/templates` still serves it to tabs left open from older versions. The desktop app keeps its own library.

Owners, access settings, invitations and visits live in the board-directory Durable Object (the `owner`, `ownerName`, `access` and `linkRole` columns of `boards` and the `board_people` table); board documents hold only display names and colors. Limitation: images and their previews are not tied to boards. They stay behind sign-in under long random names, so anyone signed in who obtains an image's address can load it.

The routes are `GET /api/cloud/boards` (the boards you can open, with your role), `GET /api/cloud/boards/<board>` (open a board: your role and who has access; a 403 names the owner), `GET` and `PATCH /api/cloud/boards/<board>/sharing` (owner only for changes: `{ "access": "private" | "link" | "everyone", "linkRole": "view" | "edit", "member": { "email": "…", "role": "view" | "edit" | null } }`, where a null role removes the invitation) and `PATCH /api/cloud/boards/<board>` (rename, owner only).

## Text and voice chat

Cloud boards have **Chat** and **Voice** in the toolbar, also for viewers. Chat keeps the newest 5,000 messages in the board room's SQLite, outside Yjs, board exports and versions. History is paged by 50, with unread state per board/account on this device, quiet alerts following **Sounds**, safe web links, and optional links to nodes. Authors may delete their own messages; owners may delete any. Deletion clears text and node links but keeps an author/time marker. Messages include author names, colors and emails, visible to everyone with board access and their MCP agents. Permanently erasing a board erases its chat; restoring a canvas version does not rewind chat.

Voice is audio-only WebRTC mesh for up to eight people. Awareness shows muted/speaking state; the room admits participants and relays bounded signals only between their sockets. Socket state survives room hibernation. Negotiation follows [MDN's perfect negotiation pattern](https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Perfect_negotiation). Leaving the board or closing the tab releases the microphone. During a board-connection drop, voice keeps the microphone and peer connections for up to 20 seconds and automatically requests room admission again after reconnect. Failed admission or a longer drop releases the microphone and shows the disconnect message. Peers also allow a missing socket 20 seconds to return with the same presence ID. Audio is never recorded. Participants may see each other's IP address; restrictive networks may relay audio through Cloudflare TURN. Desktop mode has neither feature.

Without TURN secrets, `POST /api/boards/<board>/voice/ice` returns `stun:stun.cloudflare.com:3478` only; some networks will not connect. It requires sign-in and board access, including view access. To enable TURN, set **both** Worker secrets (or add them to local `cloud/.dev.vars`):

```sh
npx wrangler secret put TURN_KEY_ID -c cloud/wrangler.jsonc
npx wrangler secret put TURN_KEY_API_TOKEN -c cloud/wrangler.jsonc
```

The key remains server-side. The endpoint obtains one-day browser credentials through the [Cloudflare TURN credential API](https://developers.cloudflare.com/realtime/turn/generate-credentials/) and filters port 53 URLs. Responses are not cached; a configured TURN API failure is reported instead of silently falling back to STUN. Join again to obtain fresh credentials for calls exceeding one day. Verify a real restrictive-network call before relying on TURN.

For manual verification, build with `node node_modules/vite/bin/vite.js build --mode cloud --outDir dist-cloud`, then start `node node_modules/wrangler/bin/wrangler.js dev -c cloud/wrangler.jsonc --port 8787`. Use separate signed-in browser profiles/devices and test: viewer posting; late arrival and reload with over 50 messages; own/owner deletion; unread and sounds with chat closed, hidden and scrolled up; links to another page and deleted nodes; microphone denial/missing device; simultaneous voice joins, mute, leave, board navigation, tab close and reconnect; blocked autoplay; eight participants and a refused ninth. Inspect both light/dark themes and a narrow screen. Test TURN with real credentials and peers on a restrictive network; mocked negotiation and route tests do not prove real audio delivery or TURN reachability.

## Calling teammates

Choosing a person's avatar in the board's top bar offers **Go to {name}** and **Call {name} here**; the bell beside the avatars (also at the top of the **+N** list) is **Call everyone here**. As in Figma's spotlight, Miro's *Bring everyone to me* and Mural's summon:

- The person called hears a short chime, even in a background tab, whose title blinks until they look, and sees a card naming the caller with **Go now** and **Not now**. **Go now** moves their canvas (and page) to where the caller's pointer is, or the middle of their view, and a ring in the caller's colour marks the spot; **Back to where I was** returns them for 12 seconds afterwards.
- Everyone called is taken there after a 5-second countdown unless they choose **Not now**. The countdown waits while they type or look at another tab.
- The caller sees how many people were called, then who is coming and who said not now.

The board's room relays calls (custom messages; nothing is stored): it names the caller from the connection it admitted, so nobody can call in someone else's name, reaches every tab of the person called, accepts one answer per person, and spaces calls out to one every 4 seconds per tab and one to everyone every 15 seconds. Viewers can call too. The chime follows the person's sound setting.

## Version history, deleted boards and backups

Anyone who can edit a board can also wipe it, by accident or on purpose, so every board keeps its history on the server:

- **Versions.** While a board changes, its room copies the whole document (Yjs state, gzipped) to R2 at most every 10 minutes, under `versions/<board>/<time>-auto`. An alarm takes the last copy once edits stop. A copy is also made at once **before a large deletion** (20 or more nodes, or at least half of a board with six or more, gone in one save; `versions/<board>/<time>-before-delete`, recording who deleted) and **before every restore**. Each copy records its time, node and image counts, four cover images and the display names of the people who edited since the previous one, never emails. The room keeps every copy from the last 24 hours, then the latest of each hour for 14 days and of each day for 90 days; copies made before a deletion or restore stay 30 days.
- **Restoring.** **Versions** in the board's top bar lists them for everyone with access; people who can edit can choose **Restore → Restore for everyone**. The board as it is now is copied first, so a restore can be undone the same way. A restore changes only what differs, in one edit that reaches everyone connected, who see who restored it and to when. Generation history only grows: runs missing from the board come back and none are removed. Routes: `GET /api/cloud/boards/<board>/versions` and `POST /api/cloud/boards/<board>/versions/<version>/restore`.
- **Deleted boards.** Deleting a board (owner only, typing its name) moves it to **Recently deleted** on the boards page: nobody can open it, and its owner or a site admin can restore it, with its sharing, for 30 days. A daily cron trigger (`23 3 * * *` UTC, in `cloud/wrangler.jsonc`) then erases its room storage and versions. Routes: `GET /api/cloud/trash` and `POST /api/cloud/trash/<board>/restore`.
- **Daily backups.** The first copy each UTC day is also written to `backups/<board>/<date>`. Protect that prefix once with an R2 bucket lock, so nothing (the app, a bug, a leaked key or the dashboard) can delete or overwrite those copies for 30 days, and let a lifecycle rule remove them a day later. When a daily backup's original version has been thinned out, the backup shows in the list as **Daily backup**.

  ```sh
  npx wrangler r2 bucket lock add concept-graph-files backups-30-days backups/ --retention-days 30
  npx wrangler r2 bucket lifecycle add concept-graph-files backups-expire backups/ --expire-days 31
  npx wrangler r2 bucket lifecycle add concept-graph-files versions-expire versions/ --expire-days 92
  ```

  The second lifecycle rule is only a backstop: the rooms already remove versions older than 90 days.
- **Last resort.** Durable Objects with SQLite storage can be rolled back to any minute of the last 30 days with [point-in-time recovery](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/) (`getBookmarkForTime` and `onNextSessionRestoreBookmark`), which covers both board rooms and the board directory. It works only in production and is not wired to any page yet. D1 keeps its own Time Travel.

Agents over MCP use the same history: `list_versions` and `restore_version`, and `delete_board` moves a board to Recently deleted. One agent call can delete at most 200 nodes.

Storage: a copy is the board's document only (images live once in `assets/`), usually well under 1 MB gzipped, so even a busy board keeps a few hundred copies within R2's free 10 GB.

## Agents over MCP

Agents such as Claude Code, Codex and Claude Desktop can work on cloud boards through the site's remote MCP server at `https://<your-worker-url>/mcp` (Streamable HTTP with plain JSON answers). **Connect MCP** on a board copies a message that asks your agent to register it; by hand:

```sh
claude mcp add --transport http --scope user concept-graph https://<your-worker-url>/mcp
codex mcp add concept-graph --url https://<your-worker-url>/mcp && codex mcp login concept-graph
```

In Claude Desktop or claude.ai, add a custom connector with the same address. The agent signs in with OAuth: its first request opens the site in your browser, you sign in with Google as usual, and a consent page names the app, where its access goes and the account it will act as. **Allow** gives it a token for this site only, valid for an hour and renewed for up to 30 days; **Deny** sends it away. Apps register themselves (dynamic client registration or a Client ID Metadata Document); tokens, codes and the person's identity are kept, hashed or encrypted, in the `OAUTH_KV` namespace by [`@cloudflare/workers-oauth-provider`](https://github.com/cloudflare/workers-oauth-provider).

An agent acts as the person who connected it, with that person's role on each board: viewers can read, editors can change and generate, and only owners can rename or delete a board. Its edits run inside the board's Durable Object, so everyone on the board sees them at once, and generations and stickies it adds carry that person's name. The tools cover:

- boards: list, create, rename, delete (with the exact name; the board goes to its owner's Recently deleted for 30 days), and who the agent is signed in as with the Nano Banana allowance left today;
- version history: `list_versions` and `restore_version` (see [Version history, deleted boards and backups](#version-history-deleted-boards-and-backups)); one call can delete at most 200 nodes;
- board chat: `list_chat` (50 recent messages, newest first, optional numeric `before` cursor) and `send_chat` (text, optional `nodeId`); both allow viewers, and posts are marked **via agent**;
- seeing a board: `get_board` (pages, nodes with their estimated size, connections, groups, sections, custom nodes, recent generations) and `get_image`, which returns images as image content, using the shared preview when one exists;
- prompts, describe nodes, reference images (uploaded as base64), custom-node prompts, stickies, shapes, arrows (ends can hold on to nodes), stamps and drawings;
- moving, editing, restacking, folding, copying, connecting and deleting nodes; groups and slideshows; pages; sections (moving one carries what lies inside it); auto-align; and `apply_graph`, which replaces a board's graph in one step and refuses if the board changed since the agent read it;
- the board's custom nodes, and generation history.

`start_run` generates as the person's **Generate** button would. Nano Banana runs on the site's Gemini key and GPT Image on its OpenAI key, with shared access, daily images and monthly budget. Codex runs on the person's own computer, which the server cannot reach, so the board's room asks that person's open tabs of the board, one at a time, to start it: the tab checks the helper and Codex as Generate does, uses a teammate's Codex if it was granted, shows **Your agent started a generation**, and answers with the run's ID. Only tabs signed in as that person and able to edit are asked, so an agent never spends anyone else's Codex. Without such a tab, or with the helper not connected, the agent is told what to open or fix. `cancel_run` stops a Codex run the same way. There is no screenshot tool: the agent sees a board as data plus its images. Sharing settings are not available to agents. There is no page yet for listing or revoking connected agents; a connection ends when its 30 days run out.

To set it up, create the namespace once and put its ID in the `OAUTH_KV` entry of `cloud/wrangler.jsonc` before deploying:

```sh
npx wrangler kv namespace create OAUTH_KV -c cloud/wrangler.jsonc
```

Local development (`npm run cloud:dev`, or `wrangler dev` with `DEV_LOGIN=1`) uses a local namespace. With `DEV_LOGIN=1`, the consent step's sign-in page also offers the local test sign-in.

## Not yet supported in cloud boards

Board export/import, ownership transfer, access requests and email invitations, run diagnostics beyond the error text, voice chat.

## Verify authentication

Run the port-free cloud suites with Node.js 22.15 or later so the Worker runtime tests execute.

```sh
node --test tests/team-access.test.mjs tests/cloud-worker-auth.test.mjs tests/cloud-worker-runtime.test.mjs tests/board-access.test.mjs tests/cloud-boards.test.mjs tests/cloud-sync.test.mjs tests/cloud-sync-generation.test.mjs tests/cloud-download-upload.test.mjs tests/nano-banana.test.mjs tests/cloud-mcp.test.mjs
```

The tests mock Google's token endpoint and cover state/nonce/PKCE, malformed and rejected tokens, callback errors, cookie expiry and flags, old-cookie rejection, email identity, loopback-only dev sign-in, logout, and authenticated access to shared resources. A D1 stub backed by in-memory SQLite checks first and repeat sign-in records, profile updates, preserved creation times, independent users, and sign-in continuing when D1 fails. Tests also check the database binding and public `/privacy` route without authentication or other bindings. `tests/board-access.test.mjs` covers the role rules, the directory migration of older boards, invitations, link visits and the board list, the owner-only routes, WebSocket admission and header stripping, read-only room connections, board links and the sign-in return to a board, and the one-time copy of the old custom-node library. The helper integration tests in `tests/cloud-jobs.test.mjs` bind local ports and can be run separately with `node --test tests/cloud-jobs.test.mjs`.

For a live check, configure the Google client and local secrets, run `npm run cloud:dev`, and visit `http://localhost:8787`. Verify Google sign-in, account selection, opening a shared board link while signed out (sign-in returns to that board), logout, cancellation, and signing in again. With two people (for example `localhost` and `127.0.0.1` windows), check that a new board is private, that inviting someone as a viewer shows them the board read-only and live, and that changing or removing their access takes effect without a reload. Also verify the dev form appears only with `DEV_LOGIN="1"` on loopback and remains hidden on the deployed hostname. Pair the helper and generate an image to confirm the existing Codex path end to end.
