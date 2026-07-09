# Chrome Web Store listing — copy/paste reference

Everything below is text you paste directly into the Developer Dashboard
(https://chrome.google.com/webstore/devconsole). Nothing here needs editing
unless you want to change the wording.

---

## Store listing tab

**Extension name** (already set in manifest, dashboard shows it read-only after first upload)
```
RTL Fix for AI Chats
```

**Summary** (132 characters max — shown under the name in search results)
```
Fixes right-to-left (Hebrew, Arabic, Persian) text on AI chat sites — without breaking math, code, or numbers.
```
(108 characters)

**Description** (long-form, shown on the listing page)

Note: the previous submission was rejected for "keyword spam" — a long list
of competitor brand names in the description. This version describes the
functionality instead and keeps the supported-site list in the README/GitHub,
not the store copy.
```
When an AI assistant answers in a right-to-left language such as Hebrew,
Arabic, or Persian, the text often renders backwards: it flows the wrong
way and punctuation lands on the wrong side. Fixing this the obvious way —
flipping the whole page to right-to-left — breaks something else: math
(KaTeX / MathJax) renders scrambled and code blocks misalign.

This extension solves both problems at once, without ever forcing a blanket
right-to-left flip:

• Each paragraph, list item, and heading resolves its own reading direction
  automatically from its content — so right-to-left text reads correctly
  while English stays left-to-right, even in the same answer.
• Math, equations, and code are locked left-to-right and isolated from the
  surrounding text, so they are never reordered by the right-to-left layout
  around them.
• Right-to-left list bullets, numbers, and blockquote bars move to the
  correct side.

It runs on major AI chat and assistant websites (the full, current list is
on the GitHub page). A single on/off switch in the toolbar popup turns it on
or off instantly, with no page reload.

Privacy: no tracking, no analytics, no network requests, and no data
collection of any kind. All processing happens locally in your browser to
apply text-direction styling; nothing is ever sent anywhere.

Open source: github.com/adinizri/rtl-fix-for-ai-chats
```

**Category**
```
Productivity
```
(Accessibility is a reasonable alternate choice if Productivity feels off.)

**Language**
```
English
```

---

## Privacy practices tab

Chrome Web Store requires a privacy policy URL once you request host
permissions. Use:
```
https://github.com/adinizri/rtl-fix-for-ai-chats/blob/main/PRIVACY.md
```

**Single purpose description** (required field)
```
Adjusts CSS text-direction and alignment so right-to-left languages
(Hebrew, Arabic, Persian, etc.) display correctly on AI chat websites,
while keeping math and code left-to-right.
```

**Permission justifications**

`storage`:
```
Used only to remember whether the user has toggled the fix on or off.
No other data is stored.
```

Host permission (per-site, e.g. claude.ai, chatgpt.com, gemini.google.com, …):
```
Required so the extension's CSS/JS can run on this AI chat site to fix
right-to-left text rendering. All processing is local to the page; the
extension does not collect or transmit any page content.
```

**Are you using remote code?**
```
No
```

**Data collection** — for each category (Personally identifiable info,
Health info, Financial info, Authentication info, Personal communications,
Location, Web history, User activity, Website content) select:
```
Not collected
```

**Certify** the standard checkboxes: does not sell user data, does not use
data for unrelated purposes, does not use data for creditworthiness/lending
— all should be affirmed truthfully since nothing is collected.

---

## Screenshots (from `store-assets/screenshots/`)

Upload in this order, each 1280×800:

1. `1-before.png` — caption: "Without the fix: Hebrew flows the wrong way"
2. `2-after.png` — caption: "With RTL Fix: correct direction, math intact"
3. `3-languages.png` — caption: "Works for Hebrew, Arabic, Persian & more"
4. `4-popup.png` — caption: "One-click toggle, no reload needed"

## Promo tile (optional)

`store-assets/promo-tile-440x280.png` — small promotional tile, 440×280.

## Package to upload

`store-assets/rtl-fix-for-ai-chats.zip` — built from the extension source
only (manifest, CSS, JS, popup, icons). Rebuild after any source change with:

```
cd rtl-fix-for-ai-chats
rm -f store-assets/rtl-fix-for-ai-chats.zip
zip -r store-assets/rtl-fix-for-ai-chats.zip \
  manifest.json content.css content.js popup.html popup.js icons
```

---

## What only you can do (needs your Google account)

1. Go to https://chrome.google.com/webstore/devconsole
2. Pay the one-time $5 USD registration fee if you haven't published before.
3. Click **New item**, upload `rtl-fix-for-ai-chats.zip`.
4. Fill in the Store listing tab using the copy above.
5. Fill in the Privacy practices tab using the copy above (paste the
   PRIVACY.md URL, mark all data categories "Not collected").
6. Upload the 4 screenshots (and the promo tile, optional) from
   `store-assets/screenshots/`.
7. Submit for review. Typical review time is a few hours to a few days for
   a first-time small extension with no remote code and minimal permissions.
