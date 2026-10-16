# Concept Graph maintenance

## English and Ukrainian README

- When changing `README.md`, update `README.uk.md` in the same change. Keep features, commands, links, requirements, limitations, and privacy statements equivalent. Use natural Ukrainian; retain literal commands, product names, and UI labels where needed.
- After reviewing both versions, run `npm run docs:mark-synced`, then `npm run docs:check`. Commit `docs/readme-sync.json` with the READMEs. The update command refuses an English change if the Ukrainian file has not changed since the last recorded synchronization.
- CI and release packaging require a passing documentation check. The check detects stale files; a human or agent still needs to verify translation accuracy. Never update the recorded hashes merely to bypass an untranslated change.

## Public demo

- `examples/courier-robot.conceptgraph` is the only reviewed board export allowed in source/release packages. Keep its checksum in `examples/courier-robot.sha256`.
- Before replacing that example, inspect its full manifest, historical input snapshots, every image, and image metadata for private information. Only deliberately public demo prompts/images may be bundled.
- Do not commit other boards, user data, login files, logs, backups, or generated personal assets. Do not modify a real data directory when testing; use separate `CONCEPT_GRAPH_DATA` storage.

Run focused checks for the change, `npm test`, and `npm run release:pack` before publishing a release.
