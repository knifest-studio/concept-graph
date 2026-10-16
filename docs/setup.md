# Setup guide

## 1. Install prerequisites

Install [Node.js 22 or newer](https://nodejs.org/en/download), including npm. Open a new terminal and check:

```sh
node --version
npm --version
```

Install the tested public Codex CLI version:

```sh
npm install -g @openai/codex@0.163.0
codex --version
codex login
codex login status
```

Choose **Sign in with ChatGPT** in the login flow. Every person uses their own account. You do not need to keep the Codex desktop app open: Concept Graph starts a child `codex app-server` process itself.

See the official [Codex CLI guide](https://learn.chatgpt.com/docs/codex/cli) and [authentication guide](https://learn.chatgpt.com/docs/auth). Avoid posting login files or tokens in issues.

macOS is locally tested. CI runs app tests on macOS and Linux. On Windows, use WSL2 and run both Node and Codex inside that environment; native Windows startup and clipboard behavior have not been verified.

## 2. Download the app

### Release ZIP

1. Open [Releases](https://github.com/knifest-studio/concept-graph/releases).
2. Download the named `concept-graph-vVERSION.zip` asset and extract it into a writable folder.
3. In that folder, run:

```sh
npm ci --omit=dev
npm start
```

The named release ZIP includes `dist/`, the built browser interface. Node, Codex, and npm dependencies are not bundled. Internet access is required for installation and generation. The adjacent `SHA256SUMS` file lets you check your download with `shasum -a 256` (macOS) or `sha256sum` (Linux).

### Git clone or automatic Source code archive

```sh
git clone https://github.com/knifest-studio/concept-graph.git
cd concept-graph
npm ci
npm run build
npm start
```

If you downloaded GitHub's **Source code (zip)** instead, extract it, open its directory, and run the same commands starting at `npm ci`.

## 3. Open and use it

Visit **http://127.0.0.1:4317**. The status in the top right should read **Codex connected**. Add a text prompt, describe an image, and click play. Run requests consume the allowance available to your signed-in Codex account.

Keep the server terminal open. Stop with **Ctrl+C**. On macOS, after the initial installation/build, you can also double-click **Start Concept Graph.command**. It uses Node and Codex from your PATH. If macOS refuses an unsigned shell launcher, use `npm start` in Terminal instead.

Read the [user guide](user-guide.md) for connections, shortcuts, groups, history, and board export/import.

## Codex compatibility

Concept Graph uses native Codex image generation over the experimental app-server protocol. A successful sign-in alone does not prove image access. The app checks that the account type is `chatgpt` and that the provider reports `imageGeneration: true`.

The public npm CLI **0.163.0** passed initialization, account, and image-capability checks during release preparation. The original full image-generation workflow was verified on the desktop-bundled **0.162.0-alpha.17.2**. No new image-generation request was made with 0.163.0 during release preparation. Availability can vary by account, workspace policy, or CLI version.

This app uses existing Codex authentication. It does not implement its own Sign in with ChatGPT flow, extract tokens, bypass account limits, or call the paid image API as a fallback. API-key-only authentication is rejected.

## Configuration

Set environment variables in the terminal that starts the app:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `4317` | Local HTTP port. |
| `CONCEPT_GRAPH_DATA` | `data/` inside the app | Directory for boards and images. Use an absolute path. |
| `CODEX_BIN` | `codex` from PATH | Codex executable. Use an absolute path if needed. |

For example:

```sh
CONCEPT_GRAPH_DATA="$HOME/ConceptGraphData" PORT=4318 npm start
```

Then visit `http://127.0.0.1:4318`. Paths containing spaces must be quoted. Always use the same data-directory setting when restarting an installation.

To select another Codex installation:

```sh
CODEX_BIN="/absolute/path/to/codex" npm start
```

## Back up and update without losing boards

Boards are **not** stored in the Git repository. By default, `data/workspace.json` contains all boards and history, and `data/assets/` contains image originals. Preserve the whole directory together. A `.conceptgraph` export is a portable copy of one board, including historical image inputs.

1. Let saves finish. Complete or cancel active generations, then stop the server.
2. Copy the entire data directory somewhere safe. Keep the matching old app version as well for rollback.
3. For a Git checkout, run `git pull --ff-only`, `npm ci`, and `npm run build`. These commands do not replace `data/`.
4. For a release ZIP, extract the new version into a **new folder**, install its dependencies, and start it with `CONCEPT_GRAPH_DATA` pointing to your existing data directory.
5. Open the app, refresh the page, and confirm your boards appear before deleting an old app folder.

Never run two app servers against the same data directory. If rolling back, restore the matching app and data backup together; retain any newer data separately so later work is not lost.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| `node` or `npm` not found | Install Node and reopen your terminal. The launcher requires Node on PATH. |
| `spawn codex ENOENT` / Codex disconnected | Run `codex --version` in the same terminal, or set `CODEX_BIN`. Restart the server after changing PATH. |
| Sign-in required | Run `codex login`, choose ChatGPT, then restart or click the Codex status button. |
| Provider lacks built-in image generation | Check your CLI version and account/workspace capabilities. API keys do not enable this app's generation path. |
| App opens but interface is missing | A source download needs `npm ci` then `npm run build`. |
| `EADDRINUSE` | An app already uses the port. Open the existing instance or choose another `PORT` with a separate data directory. |
| Usage limit reached | Wait for your account allowance to reset. The app does not switch billing methods. |
| Restart interrupted a run | Existing results remain. The interrupted run is marked failed; retry manually if desired. |
| Clipboard blocked | Focus the canvas and use the keyboard shortcut. Use upload or drag-and-drop for images if the browser blocks clipboard image data. |
| Import rejected | Use a valid `.conceptgraph` archive with intact images/checksums. The limit is 512 MB total and 30 MB per image. Existing boards are retained. |

If you report a bug, include your OS, Node version, Codex version, and the error text. Remove private prompts, images, paths, and credentials first.
