# Concept Graph MCP

This guide covers the desktop app's local boards. For cloud team boards, connect agents to the site's remote MCP server instead; see [Agents over MCP](cloud-preview.md#agents-over-mcp).

Cloud-only chat tools: `list_chat {boardId, before?}` returns up to 50 messages newest first plus `more`; pass the last message's numeric `id` as `before` to page backward. `send_chat {boardId, text, nodeId?}` posts 1–2000 trimmed characters in the signed-in person's name, marked `agent: true` (**via agent**), and broadcasts live. Both tools allow viewers. Messages expose their author's name, color and email to board participants and their agents. Chat is stored with the board outside the canvas document, exports and version history; the newest 5,000 entries are kept, including deletion markers. An author deletes their own messages through the board UI; the owner can delete any. There is no MCP voice or chat-deletion tool.

Concept Graph can expose its local boards to MCP-capable agents through a local stdio server. Open the desktop app before asking an agent to use it. The MCP process connects to that running app and its selected data folder; it does not start a second copy or create another library. Keep both the agent and Concept Graph on the same computer and user account.

The desktop package includes the required Node runtime and MCP server. You do not need to install Node.js, clone this repository, or provide an API key for the MCP connection. Image generation still uses the account signed into Concept Graph and its available Codex limits.

In the desktop app, select **Connect MCP** in the top bar and copy the message into a local agent such as Codex or Claude Code. The message includes the paths for this installation and asks the agent to configure its MCP client. The agent may need permission to update its settings and a new session or restart before it can use the server. If you move the app, copy the message again and update the agent's configuration.

An agent connected to this MCP can read and change your boards and images and start generation. Only connect an agent you trust with that access, and review its requested operations as appropriate. Board content returned to an agent is available to that agent and its provider. The MCP connection itself is local; generating an image still sends the inputs to the configured Codex service. The MCP server does not grant an agent access to Codex login credentials.

The tools cover board listing, creation, renaming, import and export; adding and editing nodes, connections and groups; arranging the board and changing its viewport; reading, uploading and saving original images; inspecting runs, starting and cancelling generation; and managing or inserting custom-node templates. Use `set_node_template` or `clear_node_template` to change an existing prompt's type while keeping its text and connections; `update_node` can collapse or expand an individual node. An existing node keeps its own custom settings if its library template changes. Agents can retrieve images for visual inspection using `get_image` and capture the current app viewport with `get_canvas_screenshot`. A screenshot includes the visible canvas, sidebar, header and web-interface overlays; it does not capture other applications, the native menu bar or native dialogs. The app window must be visible, not minimized, and ready.

`add_image_node` stores a unique image name across all pages. Its `caption` is the visible name used to refer to the image in connected generation and describe prompts; those prompts also list each image’s node ID and asset file name, so either works as a reference too. If omitted or blank, the name comes from `label` (the original file name without its extension), or the next free `Image N` for a generic or missing file name. `update_node` edits that name through `caption`. Copies retain their names.

Groups no longer show a colour: `create_group` and `update_group` still accept the legacy `color` (`#rrggbb`; `color: ""` clears it) and `get_board` and `apply_graph` keep it, but the app does not draw it. `get_board` and `apply_graph` preserve generation author display names/colors, and the `drawing`, `sticky`, and `stamp` annotation node types. Annotations can be moved, duplicated, deleted, and grouped with the existing tools; they cannot be connected or used as generation inputs. Auto-align leaves drawings, stickies, and unattached stamps in place. Attached stamps follow their target when it moves, including through `update_node` and `update_group`. Deleting a target deletes its stamps. Copies retain an attachment only when both the stamp and its target are selected. Nodes may carry an optional layer number `z` (finite, at most 1e9 in magnitude): higher draws in front within its page, a missing `z` counts as 0, and ties put annotations above prompts and images, then follow the stored node order. `get_board` and `apply_graph` keep `z`; `update_node` accepts `z`; nodes added by tools, duplicates and generated images are placed on top. An attached stamp is always drawn directly above its target.

Boards can have several pages. `get_board` returns the ordered `pages` list and each node's `page`; a node without a stored page belongs to the reserved first page `page-1`. Connections and groups stay within one page. `add_text_node`, `add_image_node`, `add_template_node` and `align_board` accept `pageId`, which is required when a board has more than one page. `update_node`, `delete_nodes`, `duplicate_nodes`, `connect_nodes` and `create_group` use the page of the nodes they name, and an optional `pageId` must match it; `duplicate_nodes`, `connect_nodes` and `create_group` reject nodes from different pages. `duplicate_nodes` keeps copies on the original page. `apply_graph` accepts an optional complete `pages` list to add, rename or remove pages; omit it to keep the current pages, and remove a deleted page's nodes in the same call. There are no separate page-management tools yet. Which page is open in the app is each person's local preference and is not changed by MCP.

Sections are named background frames, `{ id, name, x, y, width, height, color?, page? }` with a size of at least 200 × 120 and an optional `#rrggbb` colour. They store no member list: a node belongs to the section its centre is in, and moving a section in the app moves what it holds. `get_board` returns `sections` with each section's `page`; `apply_graph` accepts an optional complete `sections` list and keeps the current sections when it is omitted. There are no separate section tools; other tools leave sections unchanged.

The `undo` and `redo` tools operate on the open editor's local history. Operating-system file dialogs and app/account settings are not MCP operations. A simultaneous user edit may cause a conflict; the client must handle the error and preserve its unsaved changes.

## macOS

The following paths assume the app is installed at `/Applications/Concept Graph.app`. If it is elsewhere, use that app's absolute path instead.

### Codex

If the Codex CLI is installed, run:

```sh
codex mcp add concept-graph -- "/Applications/Concept Graph.app/Contents/Resources/runtime/node" "/Applications/Concept Graph.app/Contents/Resources/app/mcp.mjs"
```

Alternatively, add this entry to `~/.codex/config.toml`, preserving your other settings:

```toml
[mcp_servers.concept-graph]
command = "/Applications/Concept Graph.app/Contents/Resources/runtime/node"
args = ["/Applications/Concept Graph.app/Contents/Resources/app/mcp.mjs"]
```

Restart Codex or start a new session, and use `codex mcp list` or `/mcp` in the CLI to check the registration.

### Claude Code

Run the following command in a terminal with Claude Code installed:

```sh
claude mcp add --transport stdio --scope user concept-graph -- "/Applications/Concept Graph.app/Contents/Resources/runtime/node" "/Applications/Concept Graph.app/Contents/Resources/app/mcp.mjs"
```

Use `/mcp` in Claude Code to check the connection. User scope makes the registration available across projects on this computer.

### Claude Desktop

Add the following entry under `mcpServers` in `~/Library/Application Support/Claude/claude_desktop_config.json`. Preserve any existing server entries; the complete file must remain valid JSON.

```json
{
  "mcpServers": {
    "concept-graph": {
      "command": "/Applications/Concept Graph.app/Contents/Resources/runtime/node",
      "args": ["/Applications/Concept Graph.app/Contents/Resources/app/mcp.mjs"]
    }
  }
}
```

Quit Claude Desktop completely and reopen it to load the configuration.

## Windows

The Windows preview is portable. The examples below assume it has been extracted to `C:\Users\YOUR_NAME\Apps\Concept Graph`. Replace that example with the **actual absolute path** to the extracted folder containing `Concept Graph.exe`. Do not leave `YOUR_NAME` or `Apps` unchanged unless those really match your system. Moving the app later requires updating the registered paths.

### Codex

In PowerShell with Codex CLI installed:

```powershell
codex mcp add concept-graph -- "C:\Users\YOUR_NAME\Apps\Concept Graph\runtime\node.exe" "C:\Users\YOUR_NAME\Apps\Concept Graph\app\mcp.mjs"
```

Alternatively, add this entry to `%USERPROFILE%\.codex\config.toml` with your actual path. Forward slashes work in these TOML strings:

```toml
[mcp_servers.concept-graph]
command = "C:/Users/YOUR_NAME/Apps/Concept Graph/runtime/node.exe"
args = ["C:/Users/YOUR_NAME/Apps/Concept Graph/app/mcp.mjs"]
```

Restart Codex or start a new session; `codex mcp list` or `/mcp` shows the registration.

### Claude Code

In PowerShell with Claude Code installed:

```powershell
claude mcp add --transport stdio --scope user concept-graph -- "C:\Users\YOUR_NAME\Apps\Concept Graph\runtime\node.exe" "C:\Users\YOUR_NAME\Apps\Concept Graph\app\mcp.mjs"
```

Use `/mcp` in Claude Code to check the connection.

### Claude Desktop

Add an entry under `mcpServers` in `%APPDATA%\Claude\claude_desktop_config.json`, preserving existing entries. Replace the example path with the real one; backslashes in JSON must be doubled.

```json
{
  "mcpServers": {
    "concept-graph": {
      "command": "C:\\Users\\YOUR_NAME\\Apps\\Concept Graph\\runtime\\node.exe",
      "args": ["C:\\Users\\YOUR_NAME\\Apps\\Concept Graph\\app\\mcp.mjs"]
    }
  }
}
```

Quit Claude Desktop completely and reopen it. Windows desktop and its MCP integration are preview builds; native Windows validation is still required.

## Troubleshooting

- Open Concept Graph first and verify that the desktop window has loaded. The MCP server cannot operate against a closed or unavailable app.
- Confirm both configured paths point to files in the installed/extracted app and that the agent runs on the same machine. A cloud-only agent cannot use these local paths.
- If the app was moved or reinstalled at a different path, update the host's `command` and `args`. Changing the app's data location does not require changing these executable paths.
- If the host uses a sandbox, allow its MCP process to access the application and local connection under the host's normal permission controls.
- For isolated development runs using `CONCEPT_GRAPH_DATA`, also provide the same absolute `CONCEPT_GRAPH_MCP_SESSION_FILE` to the desktop app and MCP process. Without that explicit test override, the app does not publish a session for the isolated data directory.
- If a connection fails after a change or generation request was sent, check the current board or run history before retrying; the request may already have taken effect.
- Check the agent's MCP status and restart the host after changing configuration. Do not paste authentication files or session tokens into chats or issue reports.

References: [Codex MCP configuration](https://developers.openai.com/codex/mcp), [Claude Code MCP configuration](https://code.claude.com/docs/en/mcp), and [Claude Desktop local MCP setup](https://py.sdk.modelcontextprotocol.io/get-started/real-host/).
