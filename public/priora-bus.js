/* Priora shared navigation bus — cross-module deep-link + focus.
   Loaded once (idempotent) in the shell and in each module's <helmet>. */
(function () {
  if (window.PrioraBus) return;

  function fireFocus(module, id, opts) {
    window.dispatchEvent(new CustomEvent('priora:focus', { detail: { module: module, id: id, opts: opts || {} } }));
  }

  window.PrioraBus = {
    /* Navigate to `module`, then ask it to focus process/courier `id`.
       Works whether the target view is already mounted or mounts fresh. */
    focus: function (module, id, opts) {
      opts = opts || {};
      window.__prioraPending = { module: module, id: id, opts: opts, ts: Date.now() };
      // tell the shell to switch tabs
      window.dispatchEvent(new CustomEvent('priora:navigate', { detail: { module: module } }));
      // nudge the (possibly already-mounted) view a few times as it settles
      setTimeout(function () { fireFocus(module, id, opts); }, 90);
      setTimeout(function () { fireFocus(module, id, opts); }, 320);
    },

    /* A freshly-mounted module calls this to pick up a pending focus. */
    consume: function (module) {
      var p = window.__prioraPending;
      if (p && p.module === module && (Date.now() - p.ts) < 6000) {
        window.__prioraPending = null;
        return p;
      }
      return null;
    },

    /* Smooth-scroll the window so `selector` sits below the sticky topbar.
       Retries briefly in case the element is still rendering. */
    scrollToSel: function (selector, offset) {
      offset = offset == null ? 96 : offset;
      var tries = 0;
      (function attempt() {
        var el = document.querySelector(selector);
        if (el) {
          var r = el.getBoundingClientRect();
          var y = r.top + window.scrollY - offset;
          window.scrollTo({ top: Math.max(0, y), behavior: 'smooth' });
          return;
        }
        if (tries++ < 8) setTimeout(attempt, 70);
      })();
    }
  };
})();
