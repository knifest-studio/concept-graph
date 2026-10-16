# User guide

Install the app using the [setup guide](setup.md).

## Use

- Add a text prompt with the sidebar or **T**. Add references using upload, drag-and-drop, or **⌘V**.
- Paste plain text on the canvas to make a text node. Pasting while editing a prompt works normally.
- Drag a node's right connection dot to the left dot of a prompt.
- Press the **play icon** or **⌘Enter** inside a prompt. The app sends connected ancestors only; final instructions take priority. Disconnected branches are excluded.
- Request several separate images in your prompt. Each returned image becomes its own node. Runs queue one at a time.
- The play icon becomes a seconds-only timer while running, such as **42s**. Click it to cancel. History shows returned image counts. Codex does not expose a live completion percentage or ETA. Generation and queue time are tracked separately.
- Drag an image or text node's output dot into empty canvas space to create a connected text prompt. Its text cursor focuses automatically so you can type immediately.
- Images keep their original proportions. Hover to darken the image and reveal its fullscreen button, which remains 44 screen pixels across at every zoom level.
- Create, switch, or rename boards in the sidebar. Each board has its own nodes, connections, viewport, and run history; pending edits save before switching. Generation continues on its original board when you switch away.
- Switch light/dark themes with the sun/moon button. Text connections are blue; image connections are purple.
- Pan with the trackpad or middle/right drag; passing over prompts keeps panning. Click a prompt to edit it. Prompt cards grow and shrink to fit their text, without internal scrolling. Pinch to zoom; use the bottom toolbar to fit selected nodes, or the whole canvas when nothing is selected. Drag on the canvas to select a group.
- Select at least two ungrouped nodes with a selection rectangle or **⌘-click**, then press **Group selected nodes** in the bottom toolbar. Use the group's chevron to fold/unfold it; drag its header to move the members together. Its **Ungroup** control removes only the frame, keeping all nodes. Selecting a group and pressing Delete also ungroups it. Groups persist on their board and do not change generation inputs or connections. Groups support one level, without nesting.
- **Auto-align all nodes** in the bottom toolbar places generations from left to right, with each parent centered vertically against the span of its children. It accounts for image sizes, separates overlapping cards, and keeps group members together. Fold groups first for a compact layout. **Undo** restores your previous positions. Alignment runs only when you press the button.
- Hover over a button for a short explanation. Keyboard focus shows the same hint, and disabled controls explain what they need. Hints stay readable at every canvas zoom.
- Select text or image nodes, then use **⌘/Ctrl+D** to duplicate them with a small offset. **⌘/Ctrl+C** copies the selection; **⌘/Ctrl+V** pastes it at the pointer, including connections between selected nodes. Copy/paste inside a prompt edits text normally. Both node operations support Undo. Clipboard image references work within the same app installation, including across boards.
- **⌘Z / ⌘ShiftZ** undo/redo canvas edits. Delete removes selected nodes/connections. Removed assets remain on disk.
- Double-click an image to inspect it, download the original, and review its saved prompt and input image thumbnails.
- Every run appends results. Editing a prompt never changes the historical snapshot of an earlier run.

Boards save automatically to `data/workspace.json`; image originals are in `data/assets/`. The first launch after upgrading imports your existing `data/canvas.json` unchanged into **My concepts**, retaining all nodes, connections, runs, and viewport. The old file remains as a migration backup; subsequent edits go to `workspace.json`. Back up the entire `data` folder. Files and references are stored locally; connected prompts and images are sent to OpenAI when you run a prompt. Use one browser tab per board.

## Portable boards

Use **Export** and **Import** under the board picker. Export saves current edits before downloading one `.conceptgraph` file. Import saves the current board, then opens a new board named `… (imported)`; repeat imports get distinct names and IDs. Existing boards and original image files are retained.

Version 1 is a standard ZIP archive with UTF-8 `board.json` and an `assets/` directory. The manifest stores `format: "concept-graph-board"`, `version: 1`, the board name/creation time, its full graph and history, and an image inventory containing byte sizes and SHA-256 checksums. Images keep their original bytes and include saved run inputs that are no longer on the canvas. Login credentials and unrelated files are not read into exports. The archive can be inspected by renaming a copy to `.zip`.

On import, image filenames are regenerated and all node/history references are updated, preventing collisions with existing images. Incomplete imported runs become cancelled history entries; they never resume or consume allowance automatically. Export during generation captures the board as it exists at that moment and leaves the original generation running.

Limits: 512 MB archive/expanded data, 30 MB per image, 32 MB manifest, 4 MB editable graph, and 5,000 ZIP entries/history runs. Invalid files, unsupported versions, missing images, checksum mismatches, unsafe paths, links, and oversize entries are rejected. Uploads are staged and validated before a new board is added; imports never replace existing boards. The existing `data/workspace.json` schema is unchanged.

## Development

```sh
npm ci
npm run build
npm test
npm start
```

React Flow provides the canvas. A local Node server stores assets and runs `codex app-server --stdio`. No cloud hosting, external database, or API key is needed. The Codex app-server interface is experimental; updates may require adapter changes.

Set `CODEX_BIN` to the Codex executable if it is not on PATH. `PORT` defaults to 4317, and `CONCEPT_GRAPH_DATA` can select another data folder. The server listens only on 127.0.0.1 and rejects external Host/Origin headers.

Limits: one active generation across all boards, 10 connected image inputs per run, 30 MB per image. Run history survives restarts; interrupted jobs are marked failed rather than silently repeated. Undo history lasts until you leave the board or reload. Boards can be renamed; board deletion is intentionally not included. New generation results stay outside existing groups until you explicitly regroup the desired selection.

For isolated development, set `CONCEPT_GRAPH_DATA` to a separate folder. The server integration test uses a deterministic fake Codex process and never sends requests to OpenAI. To roll back an upgrade, stop the server and restore the matching application and data backup together; retain the newer data folder separately so post-upgrade work is not lost.
