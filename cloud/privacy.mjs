export const privacyHtml = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Privacy Policy — Concept Graph</title>
  <style>
    :root{font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color-scheme:light;--bg:#f5f5fb;--panel:#fcfcff;--text:#25243d;--muted:#787891;--border:#e0e1ee;--purple:#8b5cf6}
    @media(prefers-color-scheme:dark){:root{color-scheme:dark;--bg:#131521;--panel:#191b2b;--text:#e9e9f5;--muted:#969bb8;--border:#34374f;--purple:#aa83ff}}
    *{box-sizing:border-box}body{margin:0;padding:40px 20px;background:var(--bg);color:var(--text);line-height:1.7}
    main{max-width:720px;margin:auto;padding:32px;background:var(--panel);border:1px solid var(--border);border-radius:14px;box-shadow:0 5px 22px #25245b09}
    h1{font-size:28px;font-weight:500;letter-spacing:-.5px;line-height:1.3}h2{font-size:18px;margin-top:28px}p{font-size:14px}a{color:var(--purple);overflow-wrap:anywhere}a:focus-visible{outline:2px solid var(--purple);outline-offset:3px}nav{font-size:13px;color:var(--muted)}
    @media(max-width:480px){body{padding:16px}main{padding:24px}}
  </style>
</head>
<body>
  <main>
    <nav><a href="/">Concept Graph</a></nav>
    <h1>Privacy Policy</h1>
    <h2>Usage analytics and session recordings</h2>
    <p>To improve the interface, usage analytics and session recordings are on by default for signed-in users of this cloud site. We collect your account email, device, screen and viewport information, language and theme, referrer and navigation timing, clicks and keyboard shortcuts, board and page visits, generation settings, outcomes and durations, errors, and session duration and activity.</p>
    <p>Session recordings reconstruct the full site UI, including private board content, prompts, images, chat and input values. Password inputs are always masked. These are DOM recordings, not video of your desktop; voice audio and canvas pixels are not recorded. Recordings use image URLs, so images that are later deleted may no longer appear.</p>
    <p>Analytics is stored in this site's own Cloudflare D1 database and R2 storage. Only site admins can view it, including recordings of private boards. No third-party analytics service receives this data. Events and session metadata are kept for 180 days and recordings for 30 days; daily cleanup removes expired data. Cloudflare storage recovery may retain earlier data for up to 30 additional days.</p>
    <p>In Preferences, turn off “Share usage data and session recordings to improve Concept Graph” to stop all analytics collection and sending in this browser. The setting applies to this browser, including its open tabs, and is on by default in a new browser. Turning it off does not delete data already sent. The local desktop app does not collect this analytics.</p>
    <h2>Google sign-in</h2>
    <p>We store your Google account name, email address, and Google account ID to sign you in, show who is on a board, and let the site owner see registered users. We also store your first and most recent sign-in times and sign-in count. A session cookie keeps you signed in.</p>
    <h2>Boards and images</h2>
    <p>Board content and uploaded or generated images are stored on Cloudflare, together with small preview copies of those images that make large boards load faster. Boards also store display names and avatar colors for generation authors, sticky notes, and stamps; these board identities do not include email addresses.</p>
    <h2>Who can see a board</h2>
    <p>A new board is private to the person who created it and the people they invite by email. Its owner can also open it to anyone signed in who has its link, or to everyone who signs in, and chooses whether invited people and the link can edit or only view. Viewers see the board, its changes and other people's cursors live but cannot change it. Boards made before sharing existed belong to the site owner and are open to anyone signed in who has their link until the owner changes that. Custom nodes belong to their board and are visible to everyone who can open it.</p>
    <p>To enforce this we store each board's owner (email address and display name), the email addresses and roles of the people invited to it, and, when you open a board, your email address, display name and the time, so a board opened from its link stays in your list. The owner sees the email addresses of invited people; others with access see only display names. Someone who opens a board's link without access sees the owner's display name. Images are stored under long random addresses: anyone signed in who has an image's address can load it.</p>
    <h2>Text and voice chat</h2>
    <p>Everyone with access to a cloud board, including viewers, can read and send chat messages and join voice. The newest 5,000 chat messages are stored with the board in Cloudflare room storage, separately from canvas versions and exports. Messages include the author's display name, color and email address, visible to people with board access and their connected MCP agents. Agents can read and send chat in the person's name, marked as sent via an agent. Authors can delete their own messages; the board owner can delete any message. Deletion clears the text and node link, leaving a deleted-message marker and author identity. Chat is erased when the board is permanently erased; Cloudflare storage recovery may retain earlier data for up to 30 days. This device stores a per-board read cursor for your account.</p>
    <p>Voice is audio-only, peer-to-peer WebRTC for up to eight participants. Peers may see each other's IP address. Audio may be relayed through Cloudflare TURN on restrictive networks. We do not record or store voice audio. Joining requires microphone permission; leaving voice or the board releases the microphone. A brief board-connection drop keeps the microphone and peer connections for up to 20 seconds while admission is retried automatically. Failed admission or a longer drop releases the microphone.</p>
    <h2>Board history and deleted boards</h2>
    <p>So that lost or deleted work can be recovered, the site keeps copies of each board's content: every 10 minutes while it changes, just before a large deletion or a restore, and once a day. Copies are kept for up to 90 days, daily copies for 31 days, and cannot be removed sooner. Each copy lists the display names of the people who edited the board, never email addresses, and everyone who can open the board can see its copies. A deleted board can be restored by its owner or a site admin for 30 days and is then erased, together with its copies, except daily copies, which expire on their own.</p>
    <h2>Image generation</h2>
    <p>By default, image generation runs on your own computer through the local helper, using your own Codex/ChatGPT account. Prompts and reference images are sent to OpenAI under your account.</p>
    <p>If the site owner has set up Nano Banana or GPT Image and your account is on the shared allowed list, you can choose either for a prompt instead. Those generations run on the site's server: the prompt, its connected text and its reference images are sent to Google's Gemini API for Nano Banana or OpenAI's Images API for GPT Image under the site owner's accounts, and the results are stored with the board like other generated images. To enforce the shared daily and monthly limits, we record how many images each signed-in person generated each day and their estimated cost, linked to your email address; boards show only your display name.</p>
    <p>On the same allowed list you can also upscale images. Topaz and SeedVR2 upscales send the image to fal.ai, and Nano Banana upscales send it to Google's Gemini API, both under the site owner's accounts; the larger image is stored with the board, and the usage is recorded as for Nano Banana.</p>
    <p>A teammate without Codex can ask to use yours on a board. If you allow it, their prompts and reference images for those generations are sent to OpenAI through your helper and under your account until you revoke access or leave the board; the images are credited to them. If someone allows you to use theirs, your prompts and reference images are sent under their account. Access requests and grants are shared only through live board presence and are not saved.</p>
    <h2>How data is used</h2>
    <p>We do not display ads or sell your data. We do not share your data beyond the services and shared workspace described above.</p>
    <h2>Request deletion</h2>
    <p>To ask for deletion of your account record or board content, contact <a href="mailto:knifest17@gmail.com">knifest17@gmail.com</a>.</p>
  </main>
</body>
</html>`;
