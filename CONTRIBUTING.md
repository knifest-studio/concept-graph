# Contributing

Open an issue for a bug or proposed change. Keep pull requests focused and describe the visible behavior plus the checks you ran.

## Development

Use Node.js 22+ and npm:

```sh
npm ci
npm test
npm run build
CONCEPT_GRAPH_DATA=/tmp/concept-graph-development npm start
```

Keep experiments out of a real board directory. Automated tests start an isolated server on port 14319 with a deterministic fake Codex process. They do not need a login or send inference requests. Real generation checks require your own compatible Codex installation and allowance.

The frontend is in `src/`. `server.mjs` owns persistence and the queue; `codex.mjs` is the app-server adapter. `graph.mjs`, `workspace.mjs`, and `board-archive.mjs` validate and preserve graph/archive data.

Preserve node IDs, connections, original assets, and saved input snapshots when changing persistence. Include focused regression coverage for behavior/data changes. Do not commit personal boards, generated personal images, auth files, `.env` files, logs, `node_modules/`, or local backups. The explicitly reviewed `examples/courier-robot.conceptgraph` is the only bundled board exception; review its full manifest, snapshots, images, and metadata before replacing it, update its checksum, and run its import test.

## English and Ukrainian README

Update `README.md` and `README.uk.md` together when the English instructions change. Keep commands, links, requirements, features, caveats, and privacy statements equivalent. After reviewing the translation, run:

```sh
npm run docs:mark-synced
npm run docs:check
```

Commit both READMEs and `docs/readme-sync.json`. The first command records SHA-256 hashes; it does not translate text. It refuses an English-only change. CI and release packaging reject files that differ from the reviewed hashes, even if later commits touch only application code. Ukrainian-only language corrections can be recorded without changing English. Translation quality still needs review; never edit the hashes simply to bypass an untranslated change. See `AGENTS.md` for the same instructions used by coding agents.

## Releases (maintainers)

1. Update `package.json`, the root package in `package-lock.json`, `CHANGELOG.md`, and the version in `codex.mjs`'s `clientInfo`.
2. Run `npm ci`, `npm test`, and `npm run release:pack` from a Git checkout. Packaging reads tracked source files plus the freshly built `dist/` and rejects tracked private-data paths.
3. Test the resulting ZIP from a new directory with `npm ci --omit=dev` and an isolated data directory.
4. Commit the reviewed change, create a matching tag such as `v0.1.0`, and push the branch and tag.
5. The release workflow checks the app on Linux/macOS, builds the ZIP and `SHA256SUMS`, and publishes them as a prerelease. Edit that GitHub release when promoting a stable version.

Never put real Codex credentials into CI. GitHub Actions runs the fake-worker app tests; account capabilities and real generation are separate manual checks. Release automation does not bundle Codex or Node and does not publish to npm.
