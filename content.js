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
  var RTL = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/u;
  var RTL_G = new RegExp(RTL.source, "gu");

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
    "\\u27C0-\\u27FF\\u2980-\\u29FF\\u2A00-\\u2AFF" + // misc math + long arrows + supplemental operators
    "\\u{1D400}-\\u{1D7FF}"; // Mathematical Alphanumeric Symbols (𝑎𝑏 𝐴𝐵 — styled math-italic/bold/script/double-struck vars AI chats emit instead of real LaTeX)

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
  // keeps its negation. Also EXCLUDES "|": unlike "=+*/^~<>" it is virtually
  // always a self-pairing delimiter (absolute value "|n|", "such that" in
  // set-builder notation) rather than a binary connector to an adjacent word
  // — trimming it off a run's edge strands one bar of the pair as loose text
  // (e.g. "|n| = A" would lose its opening bar and read "n| = A").
  var EDGE =
    "\\s=+*/^~<>:;" +
    "\\u00D7\\u00F7" +
    "\\u2190-\\u21FF\\u2227\\u2228\\u27F0-\\u27FF";
  var LEAD_TRIM = new RegExp("^[" + EDGE + "]+");
  var TRAIL_TRIM = new RegExp("[" + EDGE + "]+$");

  // A single TECH character, for scanning outward from a bare "connector"
  // arrow (below) to find the nearest strong-direction neighbor.
  var TECH_CHAR = new RegExp("[" + TECH + "]", "u");

  // ====================================================================
  // Arrow flipping for bare "flow" arrows left in the natural RTL flow
  // ====================================================================
  // EDGE-trimming (above) deliberately leaves a connector arrow OUTSIDE the
  // LTR island so it sits between its two operands (e.g. "תן לי 0 → אחזיר
  // 5"). That gets the POSITION right — but real browsers do not auto-mirror
  // arrow glyphs for RTL runs (only paired brackets/quotes get that
  // treatment), so a bare "→" left in Hebrew flow still renders pointing
  // right even when the operand it points to now sits to its LEFT. Genuine
  // math notation ("¬r → ¬¬r = r") stays inside one island and is never
  // touched by this — only bare arrows that fall OUTSIDE an island are
  // candidates. Symmetric arrows (↔, ⟷) are omitted: flipping is a no-op.
  // Real relational operators (< > ≤ ≥) are NEVER included here — flipping
  // those would invert the actual mathematical claim, not just its reading
  // direction.
  //
  // The glyph is flipped via a CSS transform on a wrapper span (below),
  // rather than by substituting the Unicode character. Substitution isn't
  // safely repeatable: the same rendered text can legitimately get walked
  // more than once (a direct scan, then a forced block-level re-wrap — see
  // wrapBlockForced below), and since the candidate set includes both arrow
  // directions (so source text already using "←" is handled too), a second
  // pass over an already-substituted character would flip it right back. A
  // span is self-marking instead — SKIP_SEL (below) excludes its contents
  // from every later walk, so each arrow is only ever decided once — and
  // copy/paste still yields the original character.
  var ARROW_FLIP_RE = /[\u2190\u2192\u21D0\u21D2\u21A4\u21A6\u219E\u21A0\u27F5\u27F6\u27F8\u27F9\u2B60\u2B62]/g;

  // Scan away from `start` (dir = -1 back, +1 forward) through `s`, skipping
  // neutral characters (whitespace, quotes, punctuation, digits — anything
  // that isn't decisive), until a strong RTL char (-> true), a TECH char
  // (-> false, we've entered math/Latin territory), or the string end
  // (-> null, inconclusive) is found.
  function scanStrongDir(s, start, dir) {
    var i = start;
    while (i >= 0 && i < s.length) {
      var ch = s.charAt(i);
      if (RTL.test(ch)) return true;
      if (TECH_CHAR.test(ch)) return false;
      i += dir;
    }
    return null;
  }

  // Resolve the nearest strong direction on one side of a bare arrow,
  // falling back through sibling nodes (and the parent's siblings) when the
  // current text node itself is inconclusive right at its edge — e.g. an
  // arrow alone in its own text node between two <strong> fragments.
  // Defaults to RTL if the whole context is exhausted, since wrapTextNode
  // only ever runs inside a block already confirmed to resolve RTL.
  function contextIsRTL(tn, text, idx, dir) {
    var r = scanStrongDir(text, idx, dir);
    if (r !== null) return r;
    var node = dir === 1 ? tn.nextSibling : tn.previousSibling;
    var hops = 0;
    while (node && hops < 8) {
      var t = node.nodeType === 3 ? node.nodeValue : node.textContent || "";
      if (t) {
        var r2 = scanStrongDir(t, dir === 1 ? 0 : t.length - 1, dir);
        if (r2 !== null) return r2;
      }
      node = dir === 1 ? node.nextSibling : node.previousSibling;
      hops++;
    }
    var p = tn.parentElement;
    if (p) {
      node = dir === 1 ? p.nextSibling : p.previousSibling;
      hops = 0;
      while (node && hops < 8) {
        var t2 = node.nodeType === 3 ? node.nodeValue : node.textContent || "";
        if (t2) {
          var r3 = scanStrongDir(t2, dir === 1 ? 0 : t2.length - 1, dir);
          if (r3 !== null) return r3;
        }
        node = dir === 1 ? node.nextSibling : node.previousSibling;
        hops++;
      }
    }
    return true;
  }

  // A bare arrow flips unless BOTH sides resolve to LTR (matching bidi rule
  // N1: a neutral between two same-type strong runs takes that type; mixed
  // or RTL-adjacent falls back to the RTL embedding direction).
  function shouldFlipArrow(tn, text, idx) {
    var before = contextIsRTL(tn, text, idx - 1, -1);
    var after = contextIsRTL(tn, text, idx + 1, 1);
    return before || after;
  }

  // Append a GAP slice (text outside any LTR island) to `frag`, wrapping any
  // arrow that context calls for flipping in a <span class="hebi-arrow-flip">
  // — CSS (gated on data-hebi) does the actual visual mirroring; SKIP_SEL
  // keeps every later walk out of the span so the decision is never redone.
  // `absStart` is the slice's offset in the full node text, so context
  // scanning always sees the real surrounding characters.
  function appendGapText(frag, tn, text, absStart, slice) {
    if (!slice) return;
    if (!ARROW_FLIP_RE.test(slice)) {
      frag.appendChild(document.createTextNode(slice));
      return;
    }
    ARROW_FLIP_RE.lastIndex = 0;
    var last = 0,
      m;
    while ((m = ARROW_FLIP_RE.exec(slice)) !== null) {
      var relIdx = m.index;
      if (relIdx > last) frag.appendChild(document.createTextNode(slice.slice(last, relIdx)));
      if (shouldFlipArrow(tn, text, absStart + relIdx)) {
        var span = document.createElement("span");
        span.className = "hebi-arrow-flip";
        span.textContent = m[0];
        frag.appendChild(span);
      } else {
        frag.appendChild(document.createTextNode(m[0]));
      }
      last = relIdx + 1;
    }
    if (last < slice.length) frag.appendChild(document.createTextNode(slice.slice(last)));
  }

  // A maximal run of TECH characters, allowing single internal spaces so
  // "(p ∧ q) → ¬r" is captured as ONE run rather than several.
  var RUN = new RegExp("[" + TECH + "](?:[ \\t\\u00A0]*[" + TECH + "])*", "gu");
  var TRIGGER = new RegExp("[" + TRIG + "]");

  // Never descend into these — already-isolated islands, editors, or content
  // whose internal structure must not be touched (KaTeX/MathJax/SVG/MathML).
  var SKIP_SEL =
    "code,pre,kbd,samp,.katex,.katex-display,.katex-mathml,.katex-html," +
    "mjx-container,svg,math,script,style,noscript,textarea,.hebi-ltr," +
    ".hebi-arrow-flip";

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
  // Balance is counted GENERICALLY across bracket types, so a half-open
  // interval like "(0, 1]" or "[0, 1)" (one opener + one closer of different
  // types) counts as balanced and is kept whole, while a truly dangling
  // bracket ("(x=5" or "x=5)") is trimmed off the edge.
  function isOpenB(c) {
    return c === "(" || c === "[" || c === "{";
  }
  function isCloseB(c) {
    return c === ")" || c === "]" || c === "}";
  }
  var HAS_OPEN = /[([{]/;
  var HAS_CLOSE = /[)\]}]/;

  // All bracket types (incl. angle brackets ⟨⟩ for tuples) treated together,
  // just to find TOP-LEVEL commas below — separate from isOpenB/isCloseB
  // above, which intentionally stay ASCII-only for the edge-trim logic.
  var OPEN_CHARS = "([{⟨";
  var CLOSE_CHARS = ")]}⟩";

  // A run like "R1={⟨1,2⟩,⟨2,3⟩}, R2={⟨2,1⟩,⟨3,1⟩}" is one continuous TECH
  // run (bridged by the ", " between the two clauses), but it is really TWO
  // independent statements. Left as a single island, the browser may still
  // line-wrap in the middle of one clause when the island doesn't fit one
  // line — visually stranding a label like "R2 =" apart from its own value.
  // Splitting at commas that sit OUTSIDE any bracket (depth 0) keeps each
  // "label = {value}" clause as its own atomic island, so a wrap can only
  // ever land between clauses, never inside one. Commas inside a bracket
  // pair (a tuple "⟨1,2⟩" or a set "{1,2,3}") are depth>0 and never split.
  function topLevelCommaSplits(str) {
    var depth = 0,
      idxs = [];
    for (var i = 0; i < str.length; i++) {
      var c = str.charAt(i);
      if (OPEN_CHARS.indexOf(c) !== -1) depth++;
      else if (CLOSE_CHARS.indexOf(c) !== -1) {
        if (depth > 0) depth--;
      } else if (c === "," && depth === 0) idxs.push(i);
    }
    return idxs;
  }

  // ====================================================================
  // Raw math/logic wrapper
  // ====================================================================

  function wrapTextNode(tn, force, noTrim) {
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

      // 1. Trim edge connectors so they stay in the outer bidi flow — but NOT
      //    when noTrim (a pure-math line like "= ¬p ∨ (q → ¬r)"): there the
      //    leading "=" is part of the equation, not a connector to Hebrew, so
      //    it must stay INSIDE the island or it flips to the far side.
      if (!noTrim) {
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
      }

      // 2. Trim only a genuinely dangling bracket (an excess opener/closer
      //    whose partner is outside the run), counting bracket types together.
      //    Balanced runs like "(p ∧ q)", "¬(∃x: P(x))" and the half-open
      //    interval "(0, 1]" are left whole.
      //
      //    2a. A dangling CLOSER's opener is always outside the run and
      //    strictly BEFORE it, so once bracket accounting goes negative
      //    everything from there on is unreliable — truncate the run's END
      //    at that position, whichever character actually trails the
      //    closer. This is deliberately a full-run scan, not just "check the
      //    last character": a dangling closer can have trailing content of
      //    its own after it within the same run (e.g. a Hebrew parenthetical
      //    "(מ-ℝ ל-ℝ), מה..." captures "-ℝ)," as one run — the ")" is
      //    dangling, but a single-character edge check would miss it because
      //    the trailing "," is what's actually at the run's last position).
      var bal = 0,
        firstUnmatchedClose = -1,
        k;
      for (k = 0; k < run.length; k++) {
        if (isOpenB(run.charAt(k))) bal++;
        else if (isCloseB(run.charAt(k))) {
          bal--;
          if (bal < 0) {
            firstUnmatchedClose = k;
            break;
          }
        }
      }
      if (firstUnmatchedClose !== -1) {
        e -= run.length - firstUnmatchedClose;
        run = run.slice(0, firstUnmatchedClose);
      }

      // 2b. A dangling OPENER's closer is always outside the run and
      // strictly AFTER it — but unlike a closer, that does NOT mean "always
      // keep the same side": which side holds the useful content depends on
      // WHERE the opener sits. "(x=5" (opener at the very front) needs the
      // SUFFIX kept ("x=5"); "g(C)=g(C) (" (opener at the very back, e.g.
      // the start of a *different*, later parenthetical the run's greedy
      // whitespace-bridging swept in) needs the PREFIX kept
      // ("g(C)=g(C) "). A single "scan for any unmatched opener, always keep
      // one side" rule cannot get both right — so this is edge-only and
      // iterative, exactly mirroring the classic bracket-matching edge
      // cases: an opener literally at the end is unconditionally dangling
      // (nothing can ever close it in what remains); an opener literally at
      // the start is dangling only if openers now outnumber closers overall.
      while (run.length) {
        var f = run.charAt(0),
          l = run.charAt(run.length - 1);
        if (isOpenB(l)) {
          e--;
          run = run.slice(0, -1);
          continue;
        }
        if (isOpenB(f)) {
          var opensN = 0,
            closesN = 0;
          for (k = 0; k < run.length; k++) {
            if (isOpenB(run.charAt(k))) opensN++;
            else if (isCloseB(run.charAt(k))) closesN++;
          }
          if (opensN > closesN) {
            s++;
            run = run.slice(1);
            continue;
          }
        }
        break;
      }

      // Wrap-worthy if it has a real operator, OR it contains a bracket pair
      // (so bracketed notation like "(0, 1]" or "f(x)" is isolated and can't be
      // reversed by the RTL flow).
      var worthy = TRIGGER.test(run) || (HAS_OPEN.test(run) && HAS_CLOSE.test(run));
      if (s < e && worthy) ranges.push([s, e]);
      if (RUN.lastIndex === m.index) RUN.lastIndex++; // guard against zero-width
    }
    if (!ranges.length) {
      // No math island here, but a bare connector arrow (e.g. a lone "→"
      // between two Hebrew words, or between two <strong>-split fragments)
      // can still need flipping even though nothing gets isolated.
      if (!ARROW_FLIP_RE.test(text)) return;
      var wholeFrag = document.createDocumentFragment();
      appendGapText(wholeFrag, tn, text, 0, text);
      parent.replaceChild(wholeFrag, tn);
      return;
    }

    // Set-builder notation ("{...}") reads poorly when it's crammed directly
    // against whatever precedes it with no space — break it onto its own
    // line. If a space already separates it, that gap is enough; leave it.
    // `absStart` is this segment's start offset in the FULL text, so the
    // "what precedes it" check always looks at the real preceding character
    // (the outer Hebrew, or the separator before a split-off clause).
    function appendLtrSegment(frag, absStart, seg) {
      if (!seg) return;
      if (
        seg.indexOf("{") !== -1 &&
        text.slice(0, absStart).search(/\S/) !== -1 &&
        !/\s/.test(text.charAt(absStart - 1))
      ) {
        frag.appendChild(document.createElement("br"));
      }
      var span = document.createElement("span");
      span.className = "hebi-ltr";
      span.textContent = seg;
      frag.appendChild(span);
    }

    var frag = document.createDocumentFragment();
    var cursor = 0;
    for (var i = 0; i < ranges.length; i++) {
      var rs = ranges[i][0],
        re = ranges[i][1];
      if (rs > cursor) {
        appendGapText(frag, tn, text, cursor, text.slice(cursor, rs));
      }
      var runText = text.slice(rs, re);

      // Split into independent clauses at any top-level comma so a chain
      // like "R1={…}, R2={…}" can never wrap mid-clause (see
      // topLevelCommaSplits above). Each clause keeps its own preceding-space
      // check via absStart, and the comma+space separator stays in the
      // outer (non-isolated) flow between the two islands.
      var commaIdxs = topLevelCommaSplits(runText);
      var segStart = 0,
        absStart = rs;
      for (var ci = 0; ci <= commaIdxs.length; ci++) {
        var segEnd = ci < commaIdxs.length ? commaIdxs[ci] : runText.length;
        appendLtrSegment(frag, absStart, runText.slice(segStart, segEnd));
        if (ci < commaIdxs.length) {
          var sepMatch = /^,[ \t\u00A0]*/.exec(runText.slice(segEnd));
          var sepText = sepMatch ? sepMatch[0] : ",";
          frag.appendChild(document.createTextNode(sepText));
          segStart = segEnd + sepText.length;
          absStart = rs + segStart;
        }
      }
      cursor = re;
    }
    if (cursor < text.length) {
      appendGapText(frag, tn, text, cursor, text.slice(cursor));
    }
    parent.replaceChild(frag, tn);
  }

  // Wrap technical runs inside an RTL block so its math becomes isolated LTR
  // islands and `direction: rtl` is safe. `noTrim` is passed for a pure-math
  // block (no Hebrew) so a whole equation line "= ¬p ∨ (q → ¬r)" stays one
  // island — its leading "=" is math, not a connector to a Hebrew word.
  function wrapBlockForced(block, noTrim) {
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
        wrapTextNode(list[i], true, noTrim);
      } catch (e) {
        /* ignore a single bad node */
      }
    }
  }

  // ====================================================================
  // Block direction resolution
  // ====================================================================

  // A run of 4+ Latin letters = a real word → the block is (partly) prose, not
  // just math. Math variable names and the common function names (sin/cos/log/
  // max…) are ≤ 3 letters, so this doesn't fire on equations. A LONE Latin
  // letter is treated as a math variable, NOT as strong LTR — this is the key
  // difference from a naive first-strong scan: a Hebrew list item that happens
  // to start with a variable ("p ו ה-q הוא טאוטולוגיה") still resolves RTL.
  var WORD = /[A-Za-z]{4,}/;

  // Resolve a block's base direction the way the browser's plaintext does, but
  // skipping isolated islands AND lone math variables: the first of (a strong
  // RTL char) or (a real 4+ letter word) wins. Returns 'rtl' | 'ltr' | 'none'
  // ('none' = purely math/neutral, which then inherits the message direction).
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
      var rtlIdx = t.search(RTL);
      var wm = t.match(WORD);
      var ltrIdx = wm ? wm.index : -1;
      if (rtlIdx === -1 && ltrIdx === -1) continue; // only variables/neutrals here
      if (rtlIdx === -1) return "ltr";
      if (ltrIdx === -1) return "rtl";
      return rtlIdx < ltrIdx ? "rtl" : "ltr";
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

  function blockDir(el) {
    // resolveDir handles Hebrew blocks, English-prose blocks, and lone-variable
    // starts uniformly. Only a purely math/neutral block returns 'none' — then
    // it inherits the surrounding message's direction.
    var d = resolveDir(el);
    if (d === "none") d = contextDir(el);
    return d;
  }

  // Does the block's text live in more than one text node (split by inline
  // elements like <strong>)? A pure-math equation split this way can't be
  // captured in a single island, so direction:rtl would reorder the pieces.
  function isFragmented(el) {
    var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
      acceptNode: function (n) {
        var p = n.parentElement;
        if (p && p.closest && p.closest(SKIP_SEL)) return NodeFilter.FILTER_REJECT;
        return n.nodeValue && n.nodeValue.trim()
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_SKIP;
      },
    });
    var count = 0;
    while (walker.nextNode()) {
      if (++count > 1) return true;
    }
    return false;
  }

  function tagOneBlock(el) {
    if (!el || el.nodeType !== 1) return;
    try {
      if (el.classList.contains("hebi-rtl") || el.classList.contains("hebi-mr")) return;
      if (skip(el)) return;
      if (blockDir(el) !== "rtl") return;

      if (RTL.test(el.textContent || "")) {
        // Hebrew block: isolate its inline math fragments, then flip to rtl.
        wrapBlockForced(el, false);
        el.classList.add("hebi-rtl");
      } else if (isFragmented(el)) {
        // Pure-math equation split across <strong>/etc. — can't be one island,
        // so keeping it rtl would reorder the pieces. Keep it LTR-based (reads
        // in order) but right-aligned.
        el.classList.add("hebi-mr");
      } else {
        // Pure-math single run: wrap whole (leading "=" kept) and flip to rtl,
        // so a math-only blockquote/list still gets its bar/markers on the right.
        wrapBlockForced(el, true);
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

  // A streamed AI response can leave one logical sentence split across
  // multiple sibling Text nodes — e.g. if the model paused mid-stream right
  // when our 400ms "mutation quiet" debounce happened to fire, and the host
  // app appends the next chunk as a NEW text node instead of extending the
  // existing one. Each half then gets pattern-matched in isolation, so a
  // technical run spanning the boundary (e.g. "g:𝒫" | "(A)→𝒫(B)") never gets
  // recognized as one run — the first half looks unworthy on its own and is
  // left bare, the second half becomes its own separate island. Normalizing
  // the parent before we collect text nodes merges any such split back into
  // one Text node, so run-matching always sees the real, current text
  // regardless of how the host app happened to append it.
  function collectInto(root, out) {
    if (!root) return;
    if (root.nodeType === 3) {
      root = root.parentNode;
      if (!root) return;
    }
    if (root.nodeType !== 1 || skip(root)) return;
    try {
      root.normalize();
    } catch (e) {
      /* ignore */
    }
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

    if (observer) observer.disconnect(); // don't observe our own writes (incl. normalize())
    try {
      var nodes = [];
      for (var i = 0; i < roots.length; i++) {
        if (roots[i].isConnected !== false) collectInto(roots[i], nodes);
      }
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
