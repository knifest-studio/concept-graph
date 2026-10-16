# Courier robot: example board

A real Concept Graph workflow: one original character, then two image-reference branches. The cream shell, amber face, orange antenna, and navy satchel carry through the variations.

Open the bundled [example board](courier-robot.conceptgraph) at `examples/courier-robot.conceptgraph`, or [download it separately](https://github.com/knifest-studio/concept-graph/releases/download/v0.1.0/courier-robot.conceptgraph), then use **Import** below the board picker. Import creates a separate board with its images and saved run history. It does not start generation. Run a prompt only if you want another result; that uses your own Codex allowance.

## Prompts

### Original character

Design a friendly courier robot: a rounded cream ceramic body, amber digital face, short legs, navy satchel and a small orange antenna. Stylized 3D clay render, full body, three-quarter view, soft lilac studio background. One square image, no text.

### Rainy city branch

Keep the same courier robot and satchel. Put it on a rainy neon-blue city street, carrying a tiny glowing parcel. Cinematic 3D illustration, puddle reflections, one square image. No text.

### Forest delivery branch

Keep the same courier robot and satchel. Put it in a lush mossy forest, delivering a seedling in a glass capsule. Warm shafts of sunlight, tiny mushrooms, cinematic 3D illustration. One square image. No text.

## How it was made

The three images were generated through Concept Graph itself using the public Codex CLI 0.163.0 and ChatGPT authentication. The city and forest prompts each receive the original character image as a connected input. They are separate branches; neither receives the other branch's image. The archive retains completed runs, the original prompt text, and the input snapshots used at generation time.

Screenshots are captures of the running app. AI-generated artwork was made for this public demo; no personal boards, reference photographs, or login data were used.

The sample board and documentation are provided under the project's MIT license. Generating your own variations remains subject to your provider's terms and usage allowance.

## Public-data review

The reviewed archive contains only `board.json` and three PNG files: six demo nodes, five connections, and three completed generations with their input snapshots. It includes public robot prompts, generated artwork, layout, random node/run IDs, and generation timestamps. The full manifest and image metadata were checked: no private board references, user names, personal email, credentials, or local machine paths were found. Images retain their provider-generated Content Credentials and signing certificates. The reviewed archive checksum is recorded in [courier-robot.sha256](courier-robot.sha256), and CI verifies that exact file plus a successful import.

This explicitly reviewed example is the only board export allowed in release packages. Other `.conceptgraph` files, real `data/`, login files, logs, and backups remain excluded. Replacing the demo requires a new privacy review and checksum update.
