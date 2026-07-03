/* RTL Fix for AI Chats — content script (runs at document_start)
 *
 * Pure CSS does all the rendering work (see content.css). This script only
 * flips the html[data-hebi] gate on/off based on the saved preference.
 * No MutationObserver, no DOM rewriting — so streamed messages and React
 * re-renders are covered automatically by the CSS selectors.
 */
(function () {
  "use strict";

  var KEY = "hebiEnabled";

  function apply(enabled) {
    try {
      document.documentElement.dataset.hebi = enabled ? "on" : "off";
    } catch (e) {
      /* documentElement may not exist for an instant at document_start */
    }
  }

  // Default ON immediately so there's no flash of wrong (LTR) direction
  // before storage has been read.
  apply(true);

  // Read the saved preference (default true) and reconcile.
  try {
    chrome.storage.sync.get({ hebiEnabled: true }, function (res) {
      if (chrome.runtime && chrome.runtime.lastError) return;
      apply(!res || res.hebiEnabled !== false);
    });
  } catch (e) {
    /* chrome.storage unavailable — stay ON (already applied) */
  }

  // Live toggle from the popup, no reload needed.
  try {
    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area === "sync" && changes[KEY]) {
        apply(changes[KEY].newValue !== false);
      }
    });
  } catch (e) {
    /* ignore */
  }
})();
