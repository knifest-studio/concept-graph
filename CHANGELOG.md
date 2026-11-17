# Changelog

## Unreleased

- Prompts and describe nodes show one button per available model; Codex, Nano Banana/Gemini and GPT Image/GPT can run the same prompt concurrently, each with independent progress, elapsed time and owner cancellation. Model options retain Codex connection, access requests and shared limits; keyboard/MCP use the last model clicked.

- Cloud team boards: Describe image nodes now offer GPT alongside Codex and Gemini, using the site’s existing OpenAI key.
- Folding a slideshow closes it like an accordion: its images slide up under the shown one while the frame shrinks into the card, with no fade; unfolding runs the same motion backwards. Connection lines travel with the images and land exactly on the card or image, without vanishing or jumping.
- A run’s slideshow folds into its card when the run ends; grouping images from one prompt makes a folded slideshow; folded cards sit above connection lines and can be brought to front or sent to back. Connection lines stay under cards, except that where a card lies on another, its lines are drawn over that covered card only.
- Opening a board you can’t access offers **Request access**: the owner sees the request on **Share**, on the board’s tile and as a notice on the board, and lets the person in with view or edit or declines; the waiting page opens the board by itself once access is given.
- New results land right beside their prompt, or at the nearest free spot on the screen of the person who clicked, and never off screen (over other cards when nothing is free); agent runs go under the prompt’s earlier results instead of further along its row.
- Codex prompts get the variant buttons too: the chosen count is added to Codex’s request as a strict rule, and the board shows a placeholder for each image.

- Cloud team boards: 1, 2, 4, 8, 16 or up to 32 variants per prompt, run four at a time, with defaults of 100 images a day per person and $100 a month for the team; references too large for a generator go as reduced copies, and images gain Resize… and Restore original size. Everywhere: results land beside their prompt, the generations tray folds away and clears seen results, oversize uploads go up as smaller copies, shortcuts work on any keyboard layout with group/ungroup keys and personal rebinding in Settings, and Alt-drag duplicates.

- Added on-demand help, keyboard shortcuts and What’s new in English and Ukrainian; clarified Settings, system themes and custom-node discovery, with cloud UI usage events.

- Cloud team boards: persistent text chat with unread alerts, deletions, node links and MCP `list_chat` / `send_chat`; audio-only WebRTC voice for up to eight participants with optional Cloudflare TURN. Viewers can participate. Voice is not recorded; desktop boards are unchanged.

## 0.1.1 — 2026-10-16

- Added the Ukrainian README and language links.
- Added repository instructions and a checked synchronization record: CI and release packaging reject stale README translations, and English-only edits cannot be marked synchronized.
- Bundled the reviewed courier robot demo, its checksum, and an import regression test. Personal boards and every other export remain excluded from source/release packages.

## 0.1.0 — 2026-10-16

First public release.

- Text/image canvas with connected context, native Codex image generation, and preserved run history.
- Pasting, duplication, connected branching, automatic text sizing, and image inspection.
- Separate saved boards, collapsible groups, left-to-right alignment, selection-aware fitting, and undo/redo.
- Light/dark themes, contextual tooltips, and elapsed generation timers.
- Portable `.conceptgraph` ZIP export/import with original images and historical inputs.
- Local storage and loopback-only server, with ChatGPT authentication and image-capability checks.
- Setup guide, MIT license, automated app tests, and versioned release packaging.

Known limits and compatibility details are in the README and setup guide.
