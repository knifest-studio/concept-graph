# Desktop previews

The desktop application runs the existing canvas in a local native window. It includes Node.js and searches for an installed Codex CLI; neither a separate Node installation nor the hosted Site or its helper is required. If no CLI is found, it offers to download the official pinned Codex package, verify its SHA-256 digest, and install an app-managed copy without changing the user's existing CLI. Users can decline and still use their boards, and can retry setup later from the native menu. Users sign in to their own ChatGPT account through Codex. These are development previews.

By default, boards, generation history and images live in `~/Library/Application Support/Concept Graph` on macOS and `%LOCALAPPDATA%\Concept Graph\data` on Windows. To change the location, choose **Concept Graph → Storage Location…** on macOS or **Storage → Change Storage Folder…** on Windows. The app copies and verifies the library in a new `Concept Graph Data` folder inside the selected location, keeps the original files, then closes; reopen it to use the new location. Wait for active generations and transfers to finish first. Existing destination folders are never overwritten. If the selected folder becomes unavailable, reconnect it before opening the app; it will not create a replacement empty library.

Neither preview automatically migrates the older local app or helper data; export a board from the old app and import it in the desktop app. Never point two application instances at the same data directory.

Custom nodes are saved in the same data directory and can be reused across boards. Each inserted node keeps its own instructions and image references, so editing or deleting its library template does not change existing boards. A board export includes the custom-node settings and referenced images; archives containing custom nodes use format version 2, which older app versions cannot import.

Legacy caption-enabled templates use template-library version 2, which older builds cannot read. Boards with captions or legacy caption settings export as format version 3; earlier app versions cannot import them. Captions are automatic: multi-image runs get a generic label where Codex does not provide one. Captions can be added or edited manually.

## macOS

Build on a Mac with Node.js, npm, Swift and Apple command-line tools installed. Put the official Node.js v22.22.3 archive for the desired Mac architecture in a directory and run:

```sh
CONCEPT_GRAPH_NODE_ARCHIVES=/path/to/archives npm run build:macos
npm run package:macos
```

The default output is `desktop-build/Concept Graph.app` and `desktop-build/Concept Graph-preview.dmg`. The build checks the Node archive against a pinned checksum, then ad hoc signs the complete app after adding its resources unless a Developer ID identity is selected below. Both build and packaging verify the bundle signature; packaging refuses an invalid app. Ad hoc signing seals the files but does not establish an Apple-verified publisher, so macOS can block a downloaded local build. The public Apple Silicon download uses the Developer ID workflow below and is notarized by Apple. Codex setup is available from **Concept Graph → Set Up Codex…**; if an existing CLI is incompatible, installing the app-managed copy and reopening switches to that copy. Codex uses its existing account storage without copying credentials into the app. Set `CONCEPT_GRAPH_MAC_ARCH=arm64` or `x64` to choose the target, and `CONCEPT_GRAPH_DESKTOP_OUTPUT` to choose a different build directory. Apple Silicon has been exercised with the real signed-in Codex; Intel has been compiled but not run.

### Developer ID distribution

For a public Mac build, first create a **Developer ID Application** certificate with its private key in this Mac's Keychain, and a `notarytool` Keychain profile. These require active Apple Developer Program membership. Keep credentials in Keychain; do not put passwords, API keys, or private certificates into the source or package. Then build into a new output directory:

```sh
export CONCEPT_GRAPH_MAC_SIGN_IDENTITY='Developer ID Application: Your Name (TEAMID)'
export CONCEPT_GRAPH_DESKTOP_OUTPUT=/path/to/new-output
CONCEPT_GRAPH_NODE_ARCHIVES=/path/to/archives npm run build:macos
CONCEPT_GRAPH_MAC_NOTARY_PROFILE=concept-graph-notary npm run package:macos -- \
  "$CONCEPT_GRAPH_DESKTOP_OUTPUT/Concept Graph.app" \
  "$CONCEPT_GRAPH_DESKTOP_OUTPUT/Concept Graph.dmg"
```

The builder signs bundled Node first with Hardened Runtime and its V8 JIT entitlements, then signs the app with Hardened Runtime and secure timestamps. The Swift shell receives no runtime exceptions. Packaging refuses an app or Node signed with a different identity or without Hardened Runtime/timestamps. It signs the DMG, submits it using the selected Keychain profile, requires an **Accepted** response, staples and validates the ticket, and runs a Gatekeeper assessment. Without `CONCEPT_GRAPH_MAC_NOTARY_PROFILE`, the DMG is signed but not notarized and must not be presented as a notarized release. Developer ID distribution with the optional Sparkle framework is refused until its nested helper signing workflow is separately validated.

After notarization, test the final DMG by downloading it through a browser, copying the app into Applications and opening it with Gatekeeper enabled. A successful local run or valid ad hoc signature alone does not prove this first-launch experience. See [Apple's distribution signing guidance](https://developer.apple.com/documentation/xcode/creating-distribution-signed-code-for-the-mac/) and [notarization workflow](https://developer.apple.com/documentation/security/customizing-the-notarization-workflow).

The build supports an optional Sparkle framework using `CONCEPT_GRAPH_SPARKLE_FRAMEWORK`, `CONCEPT_GRAPH_UPDATE_FEED` and `CONCEPT_GRAPH_UPDATE_PUBLIC_KEY` together. The feed must be HTTPS and the public key must be a 32-byte Ed25519 key encoded as base64. An enabled build checks for updates automatically but requires the user to confirm installation. Do not ship it until a stable private signing key, signed releases, a reachable update feed, code signing and end-to-end update/quit testing are in place. The default preview contains no Sparkle framework or configured updater and does not update automatically.

## Windows

The x64 preview is a self-contained WinForms/WebView2 application containing its own .NET and Node runtimes. It uses an existing native Codex CLI or offers to download an app-managed copy. WebView2 Runtime is required. The build has been cross-compiled and its package inspected, but it has not been run on Windows. It is not a signed installer and does not yet update automatically.

Build the Windows shell with a .NET SDK, `dotnet publish desktop/windows/ConceptGraph.Windows.csproj -c Release -r win-x64 --self-contained true -p:DebugType=None -p:DebugSymbols=false -o <publish-dir>`, then run `node desktop/windows/package.mjs <publish-dir> <node-win-x64.zip> <local-dist-dir> <new-output-dir>`. The local dist must be a regular non-hosted Vite build. The packaging script verifies the Node archive checksum and copies .NET and WebView2 license notices from the NuGet cache; set `NUGET_PACKAGES` if that cache is not in its default location.

For isolated testing, set `CONCEPT_GRAPH_DATA` to a temporary directory and `CODEX_BIN` to a test fixture. An explicit `CONCEPT_GRAPH_DATA` overrides the saved location and disables changing it from the app. The native app prevents concurrent desktop instances from sharing its chosen data directory. It saves pending edits before quitting and asks before cancelling an active generation.
