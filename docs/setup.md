# Setup guide

## Desktop preview

The desktop preview includes Node.js and searches for an installed Codex CLI. If none is found, it offers to download and verify an app-managed copy; you can decline and still work with boards. Open Concept Graph and use **Sign in with ChatGPT** when prompted. Keep the app open while using it or its MCP server. Available account capabilities and usage limits still apply.

The macOS preview has been tested on Apple Silicon. It is unsigned and not notarized, so macOS may warn about or block it. The Windows x64 preview is an unsigned portable ZIP that requires WebView2 Runtime; it has been cross-compiled but has not been tested on Windows. Neither preview updates automatically. See [desktop-preview.md](desktop-preview.md) for build details, requirements, and limitations. Download links should only be used when the corresponding preview is actually published.

To retry Codex setup or install an app-managed copy if an existing CLI is incompatible, choose **Concept Graph → Set Up Codex…** on macOS or **Codex → Set Up Compatible Codex…** on Windows. The app may ask you to reopen it before switching copies; it does not overwrite your existing Codex installation.

The desktop app stores boards, history, custom-node templates, and images in `~/Library/Application Support/Concept Graph` on macOS or `%LOCALAPPDATA%\Concept Graph\data` on Windows by default. To change this location, choose **Concept Graph → Storage Location…** on macOS or **Storage → Change Storage Folder…** on Windows. It copies and verifies the data before switching; the old folder is retained. Reopen the app after the change, and back up the entire data directory. Earlier browser installations are not automatically imported into the desktop preview: export and import a board or follow the guidance in [desktop-preview.md](desktop-preview.md).

To let a local agent operate the desktop app, choose **Connect MCP** in the top bar, copy the message, and send it to Codex or Claude Code on the same computer. The agent may need permission to update its configuration and a new session. It can access and modify boards and images and start generation. See [mcp.md](mcp.md) for manual setup and details.

The rest of this guide describes the separate browser app run from source or a source release ZIP.

## 1. Install prerequisites for the browser app

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

The browser app is locally tested on macOS. CI runs app tests on macOS and Linux. For the source-run app on Windows, WSL2 is an option: run both Node and Codex inside that environment. The separate native Windows desktop preview has not been tested on Windows.

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

Git checkouts and release ZIPs from v0.1.1 include `examples/courier-robot.conceptgraph`. Use **Import** to open this reviewed public demo as a separate board. It contains prompts, three generated images, and completed history; importing it does not start generation.

## Codex compatibility

Concept Graph uses native Codex image generation over the experimental app-server protocol. A successful sign-in alone does not prove image access. The app checks that the account type is `chatgpt` and that the provider reports `imageGeneration: true`.

Image-generation threads disable unrelated skills, plugins, configured MCP servers, web search, shell, memory, planning, and multi-agent delegation. They also omit project instruction files and configured developer instructions. These overrides apply only to Concept Graph's generation worker; account authentication, the provider, and global Codex settings are retained. Codex may still include its own required context and global host user instructions, which the current thread API cannot fully exclude. The app refuses to start generation if it cannot read the configuration needed to disable configured MCP servers.

The public npm CLI **0.163.0** was verified end-to-end with ChatGPT authentication by generating the three images in the [courier robot demo](../examples/courier-robot.md), including two image-reference branches. Availability can vary by account, workspace policy, or CLI version.

The app delegates authentication to Codex. The desktop preview can start the Codex sign-in flow from its window; it does not extract tokens, bypass account limits, or call the paid image API as a fallback. API-key-only authentication is rejected.

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
