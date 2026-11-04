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
    <h2>Google sign-in</h2>
    <p>We store your Google account name, email address, and Google account ID to sign you in, show who is on a board, and let the site owner see registered users. We also store your first and most recent sign-in times and sign-in count. A session cookie keeps you signed in.</p>
    <h2>Boards and images</h2>
    <p>Board content and uploaded or generated images are stored on Cloudflare, together with small preview copies of those images that make large boards load faster. Boards also store display names and avatar colors for generation authors, sticky notes, and stamps; these board identities do not include email addresses.</p>
    <h2>Who can see a board</h2>
    <p>A new board is private to the person who created it and the people they invite by email. Its owner can also open it to anyone signed in who has its link, or to everyone who signs in, and chooses whether invited people and the link can edit or only view. Viewers see the board, its changes and other people's cursors live but cannot change it. Boards made before sharing existed belong to the site owner and stay open to everyone who signs in until the owner changes that. Custom nodes belong to their board and are visible to everyone who can open it.</p>
    <p>To enforce this we store each board's owner (email address and display name), the email addresses and roles of the people invited to it, and, when you open a board, your email address, display name and the time, so a board opened from its link stays in your list. The owner sees the email addresses of invited people; others with access see only display names. Someone who opens a board's link without access sees the owner's display name. Images are stored under long random addresses: anyone signed in who has an image's address can load it.</p>
    <h2>Image generation</h2>
    <p>By default, image generation runs on your own computer through the local helper, using your own Codex/ChatGPT account. Prompts and reference images are sent to OpenAI under your account.</p>
    <p>If the site owner has set up Nano Banana and your account is on its allowed list, you can choose Nano Banana for a prompt instead. Those generations run on the site's server: the prompt, its connected text and its reference images are sent to Google's Gemini API under the site owner's account, and the results are stored with the board like other generated images. To enforce the daily and monthly limits, we record how many images each signed-in person generated with it each day and their estimated cost, linked to your email address; boards show only your display name.</p>
    <p>A teammate without Codex can ask to use yours on a board. If you allow it, their prompts and reference images for those generations are sent to OpenAI through your helper and under your account until you revoke access or leave the board; the images are credited to them. If someone allows you to use theirs, your prompts and reference images are sent under their account. Access requests and grants are shared only through live board presence and are not saved.</p>
    <h2>How data is used</h2>
    <p>We do not display ads or sell your data. We do not share your data beyond the services and shared workspace described above.</p>
    <h2>Request deletion</h2>
    <p>To ask for deletion of your account record or board content, contact <a href="mailto:knifest17@gmail.com">knifest17@gmail.com</a>.</p>
  </main>
</body>
</html>`;
