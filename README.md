# RTL Fix for AI Chats

A Chrome extension (Manifest V3) that fixes **right-to-left** rendering —
Hebrew, Arabic, Persian/Farsi, Urdu, and any other RTL script — on AI chat
sites (**Claude, ChatGPT, Gemini, Perplexity, Copilot, DeepSeek, Grok, Mistral,
Meta AI, and more**), while keeping math (KaTeX/MathJax), code blocks, numbers,
and Latin text left-to-right and unbroken.

The fix is **script-agnostic**: it relies only on the browser's own Unicode
bidi resolution, never on anything specific to one language. Any RTL script
gets the same correct treatment.

## What it does

AI chats render each answer in a left-to-right container. When the answer is in
an RTL language, the text flows the wrong way, punctuation jumps sides, and
lines align left. This extension makes RTL blocks flow right-to-left **without**
breaking the technical content (math, code, numbers) mixed into them.

## Why a global `direction: rtl` is the wrong fix

KaTeX positions its glyphs with explicit spacing that assumes a left-to-right
context — it doesn't participate correctly in the Unicode BiDi Algorithm. If you
flip the whole message container to `direction: rtl`, the math renders backwards
and broken, code misaligns, and numbers/symbols get shuffled. So this extension
**never** sets `direction: rtl` on any container.

Instead it uses three CSS principles, plus one minimal JS helper for the
single case CSS can't reach:

1. **Per-block auto direction** — `unicode-bidi: plaintext` (the CSS equivalent
   of `dir="auto"`) on text blocks (`p, li, dd, dt, blockquote, figcaption,
   h1–h6, td, th`). Each block picks its own base direction from its first
   strong character, so an RTL block goes RTL and an English/number-first block
   stays LTR, while the browser's native bidi algorithm handles inline mixing
   (Latin words, numbers, `%`) inside an RTL sentence.
2. **Direction-aware alignment** — `text-align: right` only via the `:dir(rtl)`
   pseudo-class, so LTR blocks keep left alignment.
3. **LTR isolation islands** — `direction: ltr; unicode-bidi: isolate` on
   `.katex, .katex-display, mjx-container, code, pre, kbd, samp`. Isolation
   stops the surrounding RTL flow from reordering them and vice-versa. This is
   what keeps math from "going backwards" (e.g. `x > 0` rendering as `0x>`).
4. **Raw-text wrapping + RTL list markers (JS)** — AI chats sometimes emit
   math/logic as plain text (`¬¬r = r`, `(p ∧ q) → ¬r`) with no element around
   it at all, which no CSS selector can target. A small scanner in
   `content.js` wraps those runs in `<span class="hebi-ltr">` so principle 3
   can isolate them. The same scanner also tags blocks that read RTL
   (lists, blockquotes) with `.hebi-rtl` so their `direction` flips right —
   `unicode-bidi: plaintext` fixes a block's inline text but can't move a
   list's `::marker` or a blockquote's inline-start accent bar, and `:dir()`
   can't detect the CSS-only direction (details below).

All the critical rules are marked `!important` so a host site's own stylesheet
can't silently override the isolation.

Almost all of this is **CSS**, gated behind `html[data-hebi="on"]`, so streamed
messages and React re-renders are covered automatically at no cost. One case
CSS cannot reach: math written as *raw text* — e.g. `(p ∧ q) → ¬r` with no
LaTeX, `<code>`, or bold wrapper around it — inside an RTL sentence, because
CSS cannot select a substring of a text node. For that one case, `content.js`
runs a small scanner (MutationObserver) that waits until a streamed answer
goes quiet (~400 ms), then wraps just those symbol runs in an isolating
`<span class="hebi-ltr">`. The scanner never descends into math/code/editors,
trims binary connectors (arrows, `=`, `∧`…) off run edges so they stay
correctly placed in the surrounding RTL flow, keeps unary prefixes like `¬`
attached to their operand, and never mutates the DOM mid-stream (so it can't
fight the site's own renderer). The isolation itself still lives in the gated
CSS — the popup toggle stays instant, and injected spans simply become inert
when the fix is off, with no DOM unwrapping needed.

## Install (unpacked)

1. Open `chrome://extensions`
2. Enable **Developer mode** (top-right)
3. Click **Load unpacked**
4. Select the `rtl-fix-for-ai-chats/` folder
5. Open any supported AI chat and click the toolbar icon to toggle on/off

## Preview / develop

Open `test.html` directly in a browser. It loads real KaTeX from a CDN and links
the actual `content.css`, with test cards in Hebrew, Arabic, and Persian. Use
the **Toggle fix (A/B)** button to compare on vs. off.

## Manual test checklist

1. RTL paragraph + inline math → RTL sentence, LTR readable math
2. Display math between RTL paragraphs → centered and correct
3. RTL list with math in items → bullets/numbers on the right, math intact
4. Code block in an RTL answer → fully LTR
5. Pure English answer → unchanged
6. Mixed RTL/English answer → each paragraph aligns to its own side
7. Popup toggle OFF → instant revert, no reload
8. Streaming answer → new content styled as it arrives
9. Arabic / Persian answer → same correct behavior as Hebrew

## Supported sites

claude.ai, chatgpt.com, chat.openai.com, gemini.google.com, aistudio.google.com,
perplexity.ai, poe.com, copilot.microsoft.com, chat.deepseek.com, grok.com,
x.com/i/grok, chat.mistral.ai, meta.ai, chat.qwen.ai, huggingface.co/chat,
you.com, phind.com, kimi.com, chatglm.cn.

To add another site, add its URL pattern to `content_scripts[0].matches` in
`manifest.json`. Because the fix relies only on stable semantic selectors
(elements, `.katex*`, `code`, `[contenteditable]`) and never on obfuscated
class names, it works across sites and survives their frequent DOM redeploys.

## Notes & limitations

- **Desktop apps** (e.g. the Claude desktop app) are Electron and can't load
  Chrome extensions. This covers the sites above **in the browser**.
- The **composer/editor** rules (typing RTL in the message box) live in a
  clearly-marked, removable section at the bottom of `content.css`. If they ever
  conflict with a site's editor (e.g. ProseMirror), delete that section — the
  core fix (sections 1–3) is independent of it.
- `:dir()` and `unicode-bidi: plaintext` are supported in all modern Chromium
  browsers.

## Files

| File            | Purpose                                                    |
| --------------- | ---------------------------------------------------------- |
| `manifest.json` | MV3 config: content script, popup, icons, `storage` perm   |
| `content.css`   | All the bidi logic, gated on `html[data-hebi="on"]`        |
| `content.js`    | Toggle gate + raw-text scanner (wraps bare symbol runs)    |
| `popup.html`    | Toggle UI                                                  |
| `popup.js`      | Syncs the toggle with `chrome.storage.sync`                |
| `icons/`        | Extension icons (16/32/48/128)                             |
| `test.html`     | Standalone preview page (Hebrew, Arabic, Persian) + KaTeX  |

## License

MIT — see [LICENSE](LICENSE).
