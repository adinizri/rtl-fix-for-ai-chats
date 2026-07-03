/* RTL Fix for AI Chats — content script (runs at document_start)
 *
 * Two layers:
 *   1. The html[data-hebi] gate that switches all the CSS on/off.
 *   2. A text scanner (BiDi wrapper) that finds RAW math/logic runs living
 *      in mixed RTL text nodes — the one case pure CSS cannot reach, because
 *      CSS cannot target a substring of a text node — and wraps each run in
 *      <span class="hebi-ltr"> so content.css can isolate it left-to-right.
 *
 * Everything is defensive: DOM writes are wrapped in try/catch, the observer
 * is disconnected while we mutate (so we never observe our own writes), we
 * only touch the DOM after ~400 ms of mutation quiet (never mid-stream, so
 * we can't yank a text node out from under the host app's renderer), and
 * the isolation lives in CSS gated on data-hebi (not inline styles), so
 * toggling off makes injected spans inert without unwrapping the DOM.
 */
(function () {
  "use strict";

  var KEY = "hebiEnabled";
  var enabled = true;

  function apply(on) {
    try {
      document.documentElement.dataset.hebi = on ? "on" : "off";
    } catch (e) {
      /* documentElement may not exist for an instant at document_start */
    }
  }

  // Default ON immediately so there's no flash of wrong (LTR) direction.
  apply(true);

  // ====================================================================
  // BiDi text wrapper
  // ====================================================================

  // Strong RTL scripts: Hebrew, Arabic (+ supplement/extended), Syriac,
  // Thaana, N'Ko, and the Arabic/Hebrew presentation-form blocks.
  var RTL = /[֐-޿ࢠ-ࣿיִ-﷿ﹰ-﻿]/;

  // A single strong-directional character, RTL or LTR (Latin ranges). Used to
  // resolve a block's *base* direction the way the Unicode algorithm does:
  // the first strong char wins; weak/neutral chars (digits, spaces, most
  // punctuation) are skipped.
  var STRONG_LTR = /[A-Za-zÀ-ʯͰ-ϿḀ-ỿ]/;

  // True if the first strong-directional character in `text` is RTL — i.e. the
  // block should read right-to-left. Returns false for empty/LTR-first text.
  function firstStrongIsRtl(text) {
    if (!text) return false;
    for (var i = 0; i < text.length; i++) {
      var ch = text.charAt(i);
      if (RTL.test(ch)) return true;
      if (STRONG_LTR.test(ch)) return false;
    }
    return false;
  }

  // "Technical" characters that may form part of an LTR run: Latin letters,
  // digits, math symbols, operators, brackets, arrows, Greek, etc.
  var TECH =
    "A-Za-z0-9" +
    "\\-.,_=+*/^~|<>()%$#&@" +
    "\\[\\]{}" +
    "\\u00A7\\u00AC\\u00B0\\u00B1\\u00B2\\u00B3\\u00B7\\u00B9\\u00D7\\u00F7" +
    "\\u0370-\\u03FF" + // Greek (math variables)
    "\\u2032-\\u2037\\u2070-\\u209F\\u2100-\\u214F" + // primes, super/subs, letterlike (ℝ ℤ …)
    "\\u2190-\\u21FF\\u2200-\\u22FF\\u2300-\\u23FF" + // arrows, math operators, misc technical
    "\\u27C0-\\u27FF\\u2980-\\u29FF\\u2A00-\\u2AFF"; // misc math + long arrows + supplemental operators

  // A run is only wrapped if it contains at least one of these "trigger"
  // symbols. This deliberately EXCLUDES brackets, dot, comma, hyphen and
  // underscore so we never wrap Hebrew parentheticals "(שלום)", Hebrew
  // hyphenation "ל-6", plain words ("React"), numbers, versions, domains
  // or emails — the native bidi algorithm already handles those correctly.
  var TRIG =
    "=+*/^~|<>" +
    "\\u00AC\\u00A7\\u00B0\\u00B1\\u00B2\\u00B3\\u00B7\\u00D7\\u00F7" +
    "\\u0370-\\u03FF" +
    "\\u2032-\\u2037\\u2070-\\u209F\\u2100-\\u214F" +
    "\\u2190-\\u21FF\\u2200-\\u22FF\\u2300-\\u23FF" +
    "\\u27C0-\\u27FF\\u2980-\\u29FF\\u2A00-\\u2AFF";

  // Binary connectors that must not sit at the EDGE of a wrapped run. Left
  // OUTSIDE the isolated span they act as plain bidi neutrals, and the
  // browser places them correctly in the surrounding RTL flow — e.g. in
  // "הנחה: (p∧q) → נשארת" the arrow must sit between the math and the Hebrew
  // word after it; wrapped inside the LTR island it would flip to the other
  // side. Deliberately EXCLUDES unary prefixes ¬ (U+00AC), ± and -, so a
  // leading negation as in "¬r" is never split off its operand.
  var EDGE =
    "\\s=+*/^~|<>" +
    "\\u00D7\\u00F7" +
    "\\u2190-\\u21FF\\u2227\\u2228\\u27F0-\\u27FF";
  var LEAD_TRIM = new RegExp("^[" + EDGE + "]+");
  var TRAIL_TRIM = new RegExp("[" + EDGE + "]+$");

  // A maximal run of TECH characters, allowing single internal spaces so
  // "(p ∧ q) → ¬r" is captured as ONE run rather than several.
  var RUN = new RegExp("[" + TECH + "](?:[ \\t\\u00A0]*[" + TECH + "])*", "g");
  var TRIGGER = new RegExp("[" + TRIG + "]");

  // Never descend into these — already-isolated islands, editors, or content
  // whose internal structure must not be touched (KaTeX/MathJax/SVG/MathML).
  var SKIP_SEL =
    "code,pre,kbd,samp,.katex,.katex-display,.katex-mathml,.katex-html," +
    "mjx-container,svg,math,script,style,noscript,textarea,.hebi-ltr";

  var observer = null;
  var started = false;
  var queue = [];
  var timer = null;

  function skip(el) {
    if (!el) return true;
    try {
      if (el.isContentEditable) return true;
      return !!(el.closest && el.closest(SKIP_SEL));
    } catch (e) {
      return true;
    }
  }

  function wrapTextNode(tn) {
    var text = tn.nodeValue;
    if (!text || text.length < 2) return;
    if (!RTL.test(text)) return; // only mixed RTL nodes can misorder LTR runs
    var parent = tn.parentNode;
    if (!parent || skip(tn.parentElement)) return;

    RUN.lastIndex = 0;
    var m,
      ranges = [];
    while ((m = RUN.exec(text)) !== null) {
      var s = m.index;
      var e = m.index + m[0].length;
      var run = m[0];
      // Trim edge connectors (see EDGE above) so they stay in the outer
      // bidi flow; then re-check the trigger — a run that was ONLY a lone
      // arrow between two Hebrew words disappears entirely, which is
      // correct (the native algorithm already places it fine).
      var lead = run.match(LEAD_TRIM);
      if (lead) {
        s += lead[0].length;
        run = run.slice(lead[0].length);
      }
      var trail = run.match(TRAIL_TRIM);
      if (trail) {
        e -= trail[0].length;
        run = run.slice(0, run.length - trail[0].length);
      }
      if (s < e && TRIGGER.test(run)) ranges.push([s, e]);
      if (RUN.lastIndex === m.index) RUN.lastIndex++; // guard against zero-width
    }
    if (!ranges.length) return;

    var frag = document.createDocumentFragment();
    var cursor = 0;
    for (var i = 0; i < ranges.length; i++) {
      var s = ranges[i][0],
        e = ranges[i][1];
      if (s > cursor) frag.appendChild(document.createTextNode(text.slice(cursor, s)));
      var span = document.createElement("span");
      span.className = "hebi-ltr";
      span.textContent = text.slice(s, e);
      frag.appendChild(span);
      cursor = e;
    }
    if (cursor < text.length) frag.appendChild(document.createTextNode(text.slice(cursor)));
    parent.replaceChild(frag, tn);
  }

  // ----- Block-level direction ---------------------------------------
  // `unicode-bidi: plaintext` fixes a block's inline text but does NOT set its
  // `direction`. Anything that follows `direction` therefore stays stuck on
  // the LTR side for RTL content: list ::markers (bullets/numbers), a
  // blockquote's inline-start accent bar and padding, and start-based
  // alignment when a host site pins it. `:dir(rtl)` can't help — it reflects
  // the HTML dir attribute, not the CSS plaintext value, so it never matches.
  // So we tag any such block whose content reads RTL with `.hebi-rtl`; gated
  // CSS then flips just that block's direction, while plaintext keeps its
  // inline content correct.
  var DIR_SEL = "ul,ol,blockquote";

  function tagOneBlock(el) {
    if (!el || el.nodeType !== 1) return;
    try {
      if (el.classList.contains("hebi-rtl")) return; // already decided RTL
      if (skip(el)) return;
      if (firstStrongIsRtl(el.textContent || "")) el.classList.add("hebi-rtl");
    } catch (e) {
      /* ignore a single bad block */
    }
  }

  function tagBlocks(root) {
    if (!root) return;
    var el = root.nodeType === 3 ? root.parentElement : root;
    if (!el || el.nodeType !== 1) return;
    try {
      // the block this node lives in (e.g. an <li> streamed into a live <ul>)
      if (el.closest) {
        var anc = el.closest(DIR_SEL);
        if (anc) tagOneBlock(anc);
      }
      // any managed blocks inside the changed subtree
      if (el.querySelectorAll) {
        var blocks = el.querySelectorAll(DIR_SEL);
        for (var i = 0; i < blocks.length; i++) tagOneBlock(blocks[i]);
      }
    } catch (e) {
      /* ignore */
    }
  }

  function collectInto(root, out) {
    if (!root) return;
    if (root.nodeType === 3) {
      out.push(root);
      return;
    }
    if (root.nodeType !== 1 || skip(root)) return;
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    var n;
    while ((n = walker.nextNode())) {
      if (RTL.test(n.nodeValue || "") && !skip(n.parentElement)) out.push(n);
    }
  }

  function process() {
    timer = null;
    if (!enabled || !document.body) {
      queue = [];
      return;
    }
    var roots = queue;
    queue = [];
    if (!roots.length) return;
    var nodes = [];
    for (var i = 0; i < roots.length; i++) {
      if (roots[i].isConnected !== false) collectInto(roots[i], nodes);
    }

    if (observer) observer.disconnect(); // don't observe our own writes
    try {
      for (var r = 0; r < roots.length; r++) tagBlocks(roots[r]); // RTL block direction
      for (var j = 0; j < nodes.length; j++) {
        try {
          wrapTextNode(nodes[j]);
        } catch (e) {
          /* ignore a single bad node */
        }
      }
    } finally {
      if (observer && enabled) reconnect();
    }
  }

  function schedule() {
    // Pure trailing debounce: process only after ~400 ms with no further
    // mutations. NEVER force a flush mid-stream — replacing a text node the
    // host app (React) is actively appending to can break its reconciler
    // (the classic translate-extension-crashes-the-page failure). The cost
    // is that raw math in a long streamed answer snaps into place at the
    // next pause instead of progressively — a safe trade.
    if (timer) clearTimeout(timer);
    timer = setTimeout(process, 400);
  }

  function reconnect() {
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  }

  function onMutations(muts) {
    for (var i = 0; i < muts.length; i++) {
      var mu = muts[i];
      if (mu.type === "characterData") {
        queue.push(mu.target);
      } else {
        for (var j = 0; j < mu.addedNodes.length; j++) queue.push(mu.addedNodes[j]);
      }
    }
    if (queue.length) schedule();
  }

  function start() {
    if (started || !document.body) return;
    started = true;
    queue.push(document.body); // initial full scan
    schedule();
    observer = new MutationObserver(onMutations);
    reconnect();
  }

  function stop() {
    started = false;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    queue = [];
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    // Injected spans are left in place but become inert (their isolation is
    // gated on html[data-hebi="on"], which is now off).
  }

  function setEnabled(on) {
    enabled = on;
    apply(on);
    if (on) {
      if (document.body) start();
    } else {
      stop();
    }
  }

  // ====================================================================
  // Preference wiring
  // ====================================================================

  function boot() {
    if (enabled && document.body) start();
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }

  try {
    chrome.storage.sync.get({ hebiEnabled: true }, function (res) {
      if (chrome.runtime && chrome.runtime.lastError) return;
      setEnabled(!res || res.hebiEnabled !== false);
    });
  } catch (e) {
    /* chrome.storage unavailable — stay ON (already applied) */
  }

  try {
    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area === "sync" && changes[KEY]) {
        setEnabled(changes[KEY].newValue !== false);
      }
    });
  } catch (e) {
    /* ignore */
  }
})();
