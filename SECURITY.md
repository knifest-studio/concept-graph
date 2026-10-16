# Security and privacy

Concept Graph is a local, single-user application. It binds to `127.0.0.1`, checks Host/Origin headers, and has no multi-user login or authorization layer. Do not put it behind a public tunnel or expose it as a shared server. Other programs and users with access to the local machine may be able to reach the local service or its files.

Boards, prompt history, and image originals are stored in the configured data directory. A board export contains its prompts, image originals, and historical input snapshots. Review an export before sharing it. Credentials are managed by Codex separately and are not included by the board exporter.

Running a prompt sends connected text and images to the signed-in Codex provider. The adapter rejects API-key authentication, requests a workspace-write sandbox, disables its shell tool/apps/memories/multi-agent features, and declines interactive approval requests. These settings are controls within Codex, not a separate security boundary against other configured local Codex tooling. Use your own trusted Codex configuration.

Archive import validates graph structure, paths, file signatures, sizes, and checksums before adding a new board. It is still unwise to import arbitrary files from untrusted sources. Keep backups of your whole data directory.

Do not post auth tokens, login files, private boards, or sensitive images in public issues. Report vulnerabilities through [GitHub private vulnerability reporting](https://github.com/knifest-studio/concept-graph/security/advisories/new) when enabled. If it is unavailable, open a minimal issue asking for a private contact without including exploit details or private data.
