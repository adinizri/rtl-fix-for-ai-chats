# Privacy Policy — RTL Fix for AI Chats

**Last updated: 2026-07-03**

RTL Fix for AI Chats does not collect, transmit, store remotely, sell, or
share any user data, browsing history, or page content. There are no
analytics, no tracking pixels, and no network requests made by the
extension itself.

## What the extension does

The extension injects a CSS stylesheet (`content.css`) and a small script
(`content.js`) into the pages listed in its `matches` configuration (AI chat
sites such as claude.ai, chatgpt.com, gemini.google.com, and others). The CSS
adjusts text direction and alignment for right-to-left languages. The script
additionally scans displayed text locally, entirely inside your browser, for
the sole purpose of wrapping runs of math/logic symbols (such as `¬`, `→`,
`∧`) in a styling element so they are not visually reordered. This processing
never leaves the page: no text, message content, or credentials are copied,
stored, or transmitted anywhere.

## Data storage

The extension uses the `storage` permission solely to remember one setting:
whether the fix is turned on or off (`hebiEnabled`, a boolean). This value is
stored using `chrome.storage.sync`, which is Google's own Chrome sync
mechanism tied to your Google account — the extension does not operate its
own server and has no access to this value outside your browser.

## Permissions

| Permission | Why it's needed |
| --- | --- |
| `storage` | Persist the on/off toggle state (see above). Nothing else is stored. |
| Host access to AI chat sites (see `manifest.json`) | Required so the content script (CSS + text-direction fixes) can run on those pages. All text processing is local to the page; the extension does not collect or transmit page content, does not use a background service worker, and makes no network requests of its own. |

## Third parties

None. The extension makes no calls to any external server, analytics
provider, or third party. (The included `test.html` developer-preview page,
which is not part of the packaged extension, loads KaTeX from a public CDN
for local testing only — it is not shipped or executed inside the extension
itself.)

## Changes

If this policy ever changes, the update will be reflected in this file at
its permanent location:
<https://github.com/adinizri/rtl-fix-for-ai-chats/blob/main/PRIVACY.md>

## Contact

Questions can be filed as an issue at
<https://github.com/adinizri/rtl-fix-for-ai-chats/issues>.
