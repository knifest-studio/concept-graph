Concept Graph is a local canvas for image ideas and their evolution, powered by your signed-in Codex CLI.

Connect text and image nodes, generate and branch from results, keep separate boards, fold groups, and share a board as one `.conceptgraph` file.

### Install

Download the named `concept-graph-vVERSION.zip` asset below, extract it, and run `npm ci --omit=dev` followed by `npm start`. Visit http://127.0.0.1:4317. The ZIP includes the built interface; install Node.js 22+ and a compatible Codex CLI separately.

Read the [setup guide](https://github.com/knifest-studio/concept-graph/blob/main/docs/setup.md) for Codex login, configuration, troubleshooting, and updates that preserve your boards.

### Compatibility

Experimental prerelease. Local app and archive tests pass on macOS; the workflow also runs app checks on Linux. Tests use a fake worker and do not consume generation allowance. Public Codex CLI 0.163.0 passed authentication/image-capability checks; the original image workflow was exercised with desktop-bundled 0.162.0-alpha.17.2. Native Windows is unverified.

Use your own ChatGPT login and available Codex allowance. API-key authentication is deliberately rejected; there is no paid API fallback. No personal boards, images, or credentials are bundled.

MIT licensed. See CHANGELOG.md for the full feature list and SHA256SUMS for the ZIP checksum.
