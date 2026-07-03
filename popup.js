/* Popup — binds the toggle switch to chrome.storage.sync.hebiEnabled.
 * The content script listens for storage changes and flips the page live. */
(function () {
  "use strict";

  var KEY = "hebiEnabled";
  var toggle = document.getElementById("toggle");
  var status = document.getElementById("status");

  function setStatus(enabled) {
    status.textContent = enabled
      ? "On — RTL fix active."
      : "Off — pages render normally.";
  }

  // Load current value (default true).
  try {
    chrome.storage.sync.get({ hebiEnabled: true }, function (res) {
      var enabled = !res || res.hebiEnabled !== false;
      toggle.checked = enabled;
      setStatus(enabled);
    });
  } catch (e) {
    toggle.checked = true;
    setStatus(true);
  }

  // Save on change.
  toggle.addEventListener("change", function () {
    var enabled = toggle.checked;
    setStatus(enabled);
    try {
      chrome.storage.sync.set({ hebiEnabled: enabled });
    } catch (e) {
      /* ignore */
    }
  });
})();
