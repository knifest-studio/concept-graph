# User guide

Install the app using the [setup guide](setup.md).

The desktop preview and source-run browser app share the canvas controls below. The desktop preview includes Node.js, uses an existing or separately downloaded Codex CLI, and runs in a native window; see [desktop preview setup](desktop-preview.md) for platform support and current limitations.

## Use

- Click **+ Add text prompt** in the sidebar, the empty canvas button, or press **T**. New prompts are selected and focused, and brought into view when needed. Add references using upload, drag-and-drop, or **⌘V**.
- Paste plain text on the canvas to make a text node. Pasting while editing a prompt works normally.
- Drag a node's right connection dot to the left dot of a prompt.
- Every generation uses **GPT-6-Luna** with **low** reasoning effort. Older boards and exports retain saved model/effort fields for compatibility; these fields do not affect generation. This selects the Codex agent, not necessarily the image generator, and does not change your global Codex settings.
- Describe the image you want, then click **Generate** or press **⌘Enter** on Mac / **Ctrl+Enter** elsewhere. Empty prompts need text or saved custom instructions. The **Inputs** chip counts directly connected image and text nodes; those nodes and their template references are sent with the request. Disconnected branches and indirect ancestors are excluded.
- Request several separate images in your prompt. Each returned image becomes its own node. Runs queue one at a time.
- Captions appear automatically when useful; when a run returns multiple images, each gets a caption. If Codex omits a caption, the app uses a generic label such as **Image 1**. Captions describe the requested result and do not verify what was actually generated. Hover over an image to add a caption, or click one to edit it.
- Use the type selector in a text node's header to apply a saved custom node or switch back to **Text prompt**. A plain prompt's selector appears on hover, selection or keyboard focus; custom nodes always show it. The written text, position and connections stay in place. Switching back removes the custom instructions and fixed references from that node.
- While running, the header shows **Generating… 12s** and a separate **Cancel** control for your run. In cloud mode, another artist's run shows their name. History shows returned image counts. Codex does not expose a live completion percentage or ETA.
- In cloud/hosted mode, the top bar distinguishes a disconnected helper, Codex sign-in and readiness. A selected blocked prompt has an action to connect or sign in. **Connect and generate** resumes only if its text, template and directly connected inputs still match the original click; otherwise review it and click Generate again. Cancelling setup, switching boards or navigating away cancels that pending request.
- The **Getting started** card records this viewer's own prompt, generation and variation actions in browser storage. It is never part of a board. Dismiss it with **×**, or reopen it and five short canvas tips with **?** in the top bar.
- Hover, select or keyboard-focus an image and choose **+ Prompt from this** to make a connected variation prompt in free space to its right. Existing nodes stay in place, and the new prompt receives focus.
- Open **History** and select a run's diagnostics to inspect the available agent messages, model and effort, events, errors and token usage. Availability depends on what Codex reports; older runs may have no diagnostics. Diagnostics are stored locally with the run and included in board exports, so review their contents before sharing.
- Token usage is cumulative across agent model calls: cached input is part of Input and reasoning is part of Output. Similar totals on different models do not establish equal subscription usage. Image-generation usage may not be included. Initial thread settings are recorded before any per-generation overrides.
- Drag an image or text node's output dot into empty canvas space to create a connected text prompt. Its text cursor focuses automatically so you can type immediately.
- Images keep their original proportions. Hover to darken the image and reveal its fullscreen button, which remains 44 screen pixels across at every zoom level.
- Create, switch, or rename boards in the sidebar. Each board has its own nodes, connections, viewport, and run history; pending edits save before switching. Generation continues on its original board when you switch away.
- Use **CUSTOM NODES** to save a reusable text-node template with additional instructions and up to 10 reference images. Add a template to a board and write any task-specific text in the new node. Each inserted node keeps its own settings and references if the library template is later edited or deleted. The 10-image limit applies to all reference images in a run, including those from custom nodes.
- Right-click a text node and choose **Save as custom node** to start a template from its prompt, saved instructions and directly connected reference images. Saving the template keeps the original node intact. In cloud mode the library belongs to the whole team; it refreshes every 10 seconds while the page is visible and when you return to the window. Conflicting edits ask you to reopen the latest version.
- Each custom type has a palette colour on its badge, border, header and collapsed square. New templates start with the least-used colour; choose a swatch in the template dialog to change it. Existing board nodes retain their saved colour when the library changes.
- Switch light/dark themes with the sun/moon button. Text connections are blue; image connections are purple.
- Pan with the trackpad or middle/right drag; passing over prompts keeps panning. Click a prompt to edit it. Prompt cards grow and shrink to fit their text, without internal scrolling. Pinch to zoom; use the bottom toolbar to fit selected nodes, or the whole canvas when nothing is selected. Drag on the canvas to select a group.
- Images from the same generation are grouped automatically as they arrive, starting with the second ungrouped image; partial results remain after cancellation or an error. Select at least two ungrouped nodes with a selection rectangle or **⌘-click**, then press **Group selected nodes** in the bottom toolbar. Use the group's chevron to fold/unfold it; drag its header to move the members together. Its **Ungroup** control removes only the frame, keeping all nodes. Selecting a group and pressing Delete also ungroups it. Groups persist on their board and do not change generation inputs or connections. Groups support one level, without nesting.
- Collapse an individual text or image node with its collapse control; the compact square keeps its connections. Its expand control appears on hover or keyboard focus. The state is saved with the board.
- **Auto-align all nodes** in the bottom toolbar places generations from left to right and orders each column oldest first, centering parents against their children where that order permits. Undated legacy nodes retain their array order before dated nodes; groups use their oldest member and retain internal offsets. It accounts for image sizes and separates overlapping cards. Fold groups first for a compact layout. **Undo** restores your previous positions. Alignment runs only when you press the button.
- Hover over a button for a short explanation. Keyboard focus shows the same hint, and disabled controls explain what they need. Hints stay readable at every canvas zoom.
- Select one image and press **⌘C / Ctrl+C** to copy the image for pasting into other apps. Press **⌘ShiftC / Ctrl+Shift+C** to copy selected node or group IDs as text for an agent; you can also find these commands in the node's right-click menu. Select text nodes or multiple nodes and use **⌘/Ctrl+C**, then **⌘/Ctrl+V**, to copy them at the pointer with their internal connections. **⌘/Ctrl+D** duplicates selected nodes with a small offset, keeping incoming parent connections and connections between the copies. Outgoing connections to other nodes stay on the originals. Copies receive a fresh creation time. Copy/paste inside a prompt edits text normally. Clipboard node references work within the same app installation, including across boards.
- **⌘Z / ⌘ShiftZ** undo/redo canvas edits. Delete removes selected nodes/connections. Removed assets remain on disk.
- Double-click an image to inspect it, download the original, and review its saved prompt and input image thumbnails.
- Every run appends results. Editing a prompt never changes the historical snapshot of an earlier run.

For a source-run browser app, boards save automatically to `data/workspace.json`; image originals are in `data/assets/`. The first launch after upgrading an earlier source-run installation imports `data/canvas.json` unchanged into **My concepts**, retaining all nodes, connections, runs, and viewport. The old file remains as a migration backup; subsequent edits go to `workspace.json`. Use one browser tab per board.

The desktop preview uses `~/Library/Application Support/Concept Graph` on macOS or `%LOCALAPPDATA%\Concept Graph\data` on Windows by default. Change the folder via **Concept Graph → Storage Location…** on macOS or **Storage → Change Storage Folder…** on Windows; the app copies and verifies the data and retains the original folder. Earlier browser installations do not automatically migrate to desktop: use board export/import or the data-directory guidance in [desktop-preview.md](desktop-preview.md). In either mode, back up the entire data folder. Files and references are stored locally; connected prompts and images are sent to OpenAI when you run a prompt.

On desktop, **Connect MCP** in the top bar copies a setup message for a local Codex or Claude Code agent. Keep Concept Graph open. The connected agent can read and modify boards and images and start generation; see the [MCP guide](mcp.md).

## Portable boards

Use **Export** and **Import** under the board picker. Export saves current edits before downloading one `.conceptgraph` file. Import saves the current board, then opens a new board named `… (imported)`; repeat imports get distinct names and IDs. Existing boards and original image files are retained.

The archive is a standard ZIP with UTF-8 `board.json` and an `assets/` directory. The manifest stores `format: "concept-graph-board"`, the format version, the board name/creation time, its full graph and history, and an image inventory containing byte sizes and SHA-256 checksums. Boards containing custom-node settings use version 2, which older app versions cannot import; other boards use version 1. Images keep their original bytes and include saved run inputs and custom-node references, even when no longer visible on the canvas. Login credentials and unrelated files are not read into exports. The archive can be inspected by renaming a copy to `.zip`.

On import, image filenames are regenerated and all node/history references are updated, preventing collisions with existing images. Incomplete imported runs become cancelled history entries; they never resume or consume allowance automatically. Export during generation captures the board as it exists at that moment and leaves the original generation running.

Limits: 512 MB archive/expanded data, 30 MB per image, 32 MB manifest, 4 MB editable graph, and 5,000 ZIP entries/history runs. Invalid files, unsupported versions, missing images, checksum mismatches, unsafe paths, links, and oversize entries are rejected. Uploads are staged and validated before a new board is added; imports never replace existing boards.

## Development

```sh
npm ci
npm run build
npm test
npm start
```

React Flow provides the canvas. A local Node server stores assets and runs `codex app-server --stdio`. No cloud hosting, external database, or API key is needed. The Codex app-server interface is experimental; updates may require adapter changes.

Set `CODEX_BIN` to the Codex executable if it is not on PATH. `PORT` defaults to 4317, and `CONCEPT_GRAPH_DATA` can select another data folder. The server listens only on 127.0.0.1 and rejects external Host/Origin headers.

Limits: one active generation across all boards, 10 connected image inputs per run, 30 MB per image. Run history survives restarts; interrupted jobs are marked failed rather than silently repeated. Undo history lasts until you leave the board or reload. Boards can be renamed; board deletion is intentionally not included. Generated images do not join an existing group automatically.

For isolated development, set `CONCEPT_GRAPH_DATA` to a separate folder. The server integration test uses a deterministic fake Codex process and never sends requests to OpenAI. To roll back an upgrade, stop the server and restore the matching application and data backup together; retain the newer data folder separately so post-upgrade work is not lost.
