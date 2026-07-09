/* RTL Fix for AI Chats — content script (runs at document_start)
 *
 * Two layers:
 *   1. The html[data-hebi] gate that switches all the CSS on/off.
 *   2. A DOM scanner that does the things pure CSS can't:
 *      a. Wrap RAW math/logic runs (e.g. "(p ∧ q) → ¬r", "¬¬r = r") that live
 *         in a text node with no element of their own, in <span class="hebi-ltr">
 *         so content.css can isolate them left-to-right. CSS can't target a
 *         substring of a text node.
 *      b. Give each block a correct base DIRECTION. `unicode-bidi: plaintext`
 *         resolves a block's inline text but never sets its `direction`, so RTL
 *         list markers, blockquote bars, and pure-math blocks in an RTL message
 *         stay stuck on the LTR side. We resolve each block's direction (the way
 *         the browser's own algorithm does — skipping isolated islands, and
 *         falling back to the surrounding message for Hebrew-free math blocks)
 *         and tag RTL ones `.hebi-rtl` so gated CSS can flip them.
 *
 * Everything is defensive: DOM writes are wrapped in try/catch, the observer
 * is disconnected while we mutate (so we never observe our own writes), we
 * only touch the DOM after ~400 ms of mutation quiet (never mid-stream, so
 * we can't yank a text node out from under the host app's renderer), and
 * the isolation/direction live in CSS gated on data-hebi (not inline styles),
 * so toggling off makes injected spans/classes inert without unwrapping.
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
  // Character classes
  // ====================================================================

  // Strong RTL scripts, as explicit \u ranges so a stray combining mark in the
  // source can't corrupt them: U+0590–U+08FF covers Hebrew, Arabic, Syriac,
  // Thaana, N'Ko, Samaritan, Mandaic and the Arabic supplements/extensions;
  // then the Hebrew + Arabic presentation-form blocks. Deliberately excludes
  // the U+2000–U+2FFF math/arrow area (a past bug classified ∃ ∀ → ≡ as RTL).
  var RTL = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/;
  var RTL_G = new RegExp(RTL.source, "g");

  // A single strong-directional LTR character: Latin (+ Latin-1/Extended) and
  // Greek (used for math variables). Weak/neutral chars — digits, spaces, most
  // punctuation, math operators — match neither RTL nor STRONG_LTR.
  var STRONG_LTR = /[A-Za-zÀ-ʯͰ-ϿḀ-ỿ]/;

  // "Technical" characters that may form part of an LTR run: Latin letters,
  // digits, math symbols, operators, brackets, arrows, Greek, colon (sets /
  // logic like "∃x: P(x)"), etc.
  var TECH =
    "A-Za-z0-9" +
    "\\-.,_=+*/^~|<>()%$#&@:;" +
    "\\[\\]{}" +
    "\\u00A7\\u00AC\\u00B0\\u00B1\\u00B2\\u00B3\\u00B7\\u00B9\\u00D7\\u00F7" +
    "\\u0370-\\u03FF" + // Greek (math variables)
    "\\u2032-\\u2037\\u2070-\\u209F\\u2100-\\u214F" + // primes, super/subs, letterlike (ℝ ℤ …)
    "\\u2190-\\u21FF\\u2200-\\u22FF\\u2300-\\u23FF" + // arrows, math operators, misc technical
    "\\u27C0-\\u27FF\\u2980-\\u29FF\\u2A00-\\u2AFF"; // misc math + long arrows + supplemental operators

  // A run is only wrapped if it contains at least one of these "trigger"
  // symbols. Deliberately EXCLUDES brackets, dot, comma, hyphen, colon and
  // underscore so we never wrap Hebrew parentheticals "(שלום)", hyphenation
  // "ל-6", plain words ("React"), numbers, versions, domains or emails.
  var TRIG =
    "=+*/^~|<>" +
    "\\u00AC\\u00A7\\u00B0\\u00B1\\u00B2\\u00B3\\u00B7\\u00D7\\u00F7" +
    "\\u0370-\\u03FF" +
    "\\u2032-\\u2037\\u2070-\\u209F\\u2100-\\u214F" +
    "\\u2190-\\u21FF\\u2200-\\u22FF\\u2300-\\u23FF" +
    "\\u27C0-\\u27FF\\u2980-\\u29FF\\u2A00-\\u2AFF";

  // Binary connectors / neutrals trimmed off a run's EDGES so they stay in the
  // outer bidi flow (an arrow between math and a Hebrew word must sit between
  // them, not inside the LTR island). EXCLUDES unary prefixes ¬ ± -, so "¬r"
  // keeps its negation.
  var EDGE =
    "\\s=+*/^~|<>:;" +
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

  // Managed block elements whose base direction we set.
  var DIR_SEL =
    "p,li,dd,dt,blockquote,figcaption,h1,h2,h3,h4,h5,h6,td,th,ul,ol";

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

  // ====================================================================
  // Bracket balancing — never split a bracket pair across an island edge
  // ====================================================================
  var OPEN = { "(": ")", "[": "]", "{": "}" };
  var CLOSE = { ")": "(", "]": "[", "}": "{" };

  function leadUnmatched(s) {
    var c = s.charAt(0);
    if (CLOSE.hasOwnProperty(c)) return true; // a closer at the start is unmatched
    if (!OPEN.hasOwnProperty(c)) return false;
    var want = OPEN[c],
      d = 0;
    for (var i = 0; i < s.length; i++) {
      if (s.charAt(i) === c) d++;
      else if (s.charAt(i) === want) {
        d--;
        if (d === 0) return false; // matched within the run
      }
    }
    return true;
  }

  function trailUnmatched(s) {
    var c = s.charAt(s.length - 1);
    if (OPEN.hasOwnProperty(c)) return true; // an opener at the end is unmatched
    if (!CLOSE.hasOwnProperty(c)) return false;
    var want = CLOSE[c],
      d = 0;
    for (var i = s.length - 1; i >= 0; i--) {
      if (s.charAt(i) === c) d++;
      else if (s.charAt(i) === want) {
        d--;
        if (d === 0) return false;
      }
    }
    return true;
  }

  // ====================================================================
  // Raw math/logic wrapper
  // ====================================================================

  function wrapTextNode(tn, force) {
    var text = tn.nodeValue;
    if (!text || text.length < 2) return;
    // Only mixed-RTL nodes can misorder LTR runs — unless `force` (a pure-math
    // block that we've already decided belongs to an RTL message).
    if (!force && !RTL.test(text)) return;
    var parent = tn.parentNode;
    if (!parent || skip(tn.parentElement)) return;

    RUN.lastIndex = 0;
    var m,
      ranges = [];
    while ((m = RUN.exec(text)) !== null) {
      var s = m.index;
      var e = m.index + m[0].length;
      var run = m[0];

      // 1. Trim edge connectors so they stay in the outer bidi flow.
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

      // 2. Trim edge brackets whose partner is outside the run, so a bracket
      //    pair is never split across the island boundary (which would break
      //    its mirroring). Balanced runs like "(p ∧ q)" or "¬(∃x: P(x))" are
      //    left whole.
      var changed = true;
      while (changed && run.length) {
        changed = false;
        if (leadUnmatched(run)) {
          s++;
          run = run.slice(1);
          changed = true;
        }
        if (run.length && trailUnmatched(run)) {
          e--;
          run = run.slice(0, -1);
          changed = true;
        }
      }

      if (s < e && TRIGGER.test(run)) ranges.push([s, e]);
      if (RUN.lastIndex === m.index) RUN.lastIndex++; // guard against zero-width
    }
    if (!ranges.length) return;

    var frag = document.createDocumentFragment();
    var cursor = 0;
    for (var i = 0; i < ranges.length; i++) {
      var rs = ranges[i][0],
        re = ranges[i][1];
      if (rs > cursor) frag.appendChild(document.createTextNode(text.slice(cursor, rs)));
      var span = document.createElement("span");
      span.className = "hebi-ltr";
      span.textContent = text.slice(rs, re);
      frag.appendChild(span);
      cursor = re;
    }
    if (cursor < text.length) frag.appendChild(document.createTextNode(text.slice(cursor)));
    parent.replaceChild(frag, tn);
  }

  // Wrap technical runs inside a block that has NO RTL char of its own (a
  // pure-math block we've decided is RTL context), so its math becomes an
  // isolated LTR island and `direction: rtl` on the block is safe.
  function wrapBlockForced(block) {
    var walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, {
      acceptNode: function (n) {
        var p = n.parentElement;
        if (!p || (p.closest && p.closest(SKIP_SEL))) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    var list = [],
      n;
    while ((n = walker.nextNode())) list.push(n);
    for (var i = 0; i < list.length; i++) {
      try {
        wrapTextNode(list[i], true);
      } catch (e) {
        /* ignore a single bad node */
      }
    }
  }

  // ====================================================================
  // Block direction resolution
  // ====================================================================

  // First strong char, SKIPPING isolated islands — mirrors what the browser's
  // `plaintext`/`dir=auto` does. Returns 'rtl' | 'ltr' | 'none'.
  function resolveDir(el) {
    var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
      acceptNode: function (n) {
        var p = n.parentElement;
        if (p && p.closest && p.closest(SKIP_SEL)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    var n;
    while ((n = walker.nextNode())) {
      var t = n.nodeValue;
      for (var i = 0; i < t.length; i++) {
        var c = t.charAt(i);
        if (RTL.test(c)) return "rtl";
        if (STRONG_LTR.test(c)) return "ltr";
      }
    }
    return "none";
  }

  // For a block with no strong direction of its own (pure math / neutral),
  // inherit the surrounding MESSAGE's direction: climb a few levels and look
  // for substantial RTL text. Bounded + boundary-stopped so a neighbouring
  // message can't leak its direction in. Math never adds RTL characters, so
  // this is not fooled by math-heavy Hebrew answers.
  var CTX_BOUNDARY = /^(BODY|MAIN|ARTICLE|SECTION|NAV|HEADER|FOOTER|FORM|HTML)$/;
  function contextDir(el) {
    var node = el.parentElement,
      hops = 0;
    while (node && hops < 3 && !CTX_BOUNDARY.test(node.tagName)) {
      var mm = (node.textContent || "").match(RTL_G);
      if (mm && mm.length >= 4) return "rtl";
      node = node.parentElement;
      hops++;
    }
    return "ltr";
  }

  // A run of 4+ Latin letters = a real word → the block is English prose, not
  // math. (Math variable names and the common function names sin/cos/log/max…
  // are ≤ 3 letters, so this doesn't catch equations.) Used to keep English
  // blocks LTR even when they sit next to Hebrew, while still letting genuinely
  // math-only blocks inherit the surrounding message's RTL direction.
  var WORD = /[A-Za-z]{4,}/;

  function blockDir(el) {
    var text = el.textContent || "";
    if (RTL.test(text)) {
      var d = resolveDir(el);
      return d === "none" ? contextDir(el) : d;
    }
    // No RTL character: English prose stays LTR; pure math/neutral inherits the
    // surrounding message direction.
    if (WORD.test(text)) return "ltr";
    return contextDir(el);
  }

  function tagOneBlock(el) {
    if (!el || el.nodeType !== 1) return;
    try {
      if (el.classList.contains("hebi-rtl")) return; // already decided RTL
      if (skip(el)) return;
      if (blockDir(el) === "rtl") {
        // Pure-math RTL block: isolate its math first so direction:rtl is safe.
        if (!RTL.test(el.textContent || "")) wrapBlockForced(el);
        el.classList.add("hebi-rtl");
      }
    } catch (e) {
      /* ignore a single bad block */
    }
  }

  function tagBlocks(root) {
    if (!root) return;
    var el = root.nodeType === 3 ? root.parentElement : root;
    if (!el || el.nodeType !== 1) return;
    try {
      if (el.closest) {
        var anc = el.closest(DIR_SEL);
        if (anc) tagOneBlock(anc);
      }
      if (el.querySelectorAll) {
        var blocks = el.querySelectorAll(DIR_SEL);
        for (var i = 0; i < blocks.length; i++) tagOneBlock(blocks[i]);
      }
    } catch (e) {
      /* ignore */
    }
  }

  // ====================================================================
  // Collection + scheduling
  // ====================================================================

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
      // 1. Wrap raw math runs in Hebrew-containing nodes (creates the islands
      //    that block-direction resolution below then skips).
      for (var j = 0; j < nodes.length; j++) {
        try {
          wrapTextNode(nodes[j], false);
        } catch (e) {
          /* ignore a single bad node */
        }
      }
      // 2. Resolve + tag block direction (may force-wrap pure-math RTL blocks).
      for (var r = 0; r < roots.length; r++) tagBlocks(roots[r]);
    } finally {
      if (observer && enabled) reconnect();
    }
  }

  function schedule() {
    // Pure trailing debounce: process only after ~400 ms with no further
    // mutations. NEVER force a flush mid-stream — replacing a text node the
    // host app (React) is actively appending to can break its reconciler.
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
    // Injected spans/classes are left in place but become inert (their effect
    // is gated on html[data-hebi="on"], which is now off).
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
