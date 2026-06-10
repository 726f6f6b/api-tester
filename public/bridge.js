// Codi bridge — injected into every proxied page by server.js.
// Talks to the tester UI (parent window) over postMessage:
//   codi:get-html      -> replies with the page's outerHTML (bridge tags stripped)
//   codi:apply-bundle  -> evals the bundle code on this page, reports result
//   codi:pick-start    -> element picker mode; click sends the element's HTML
//   codi:pick-stop     -> cancel picker mode
(function () {
  if (window.parent === window) return; // only meaningful inside the tester iframe

  // History API shim — must run before the page's own scripts (the bridge is
  // injected at the top of <head>). With the injected <base>, SPA routers
  // resolve their URLs against the real origin; pushState/replaceState with a
  // cross-origin URL throws SecurityError and crashes React/Next hydration.
  // Retry without the URL so the state transition succeeds and the app lives.
  // NOTE: relative URLs passed to push/replaceState resolve against the
  // injected <base> (the real site's origin) and therefore throw. On failure,
  // remap the intended URL onto our own origin, keeping path+search+hash, so
  // SPA route transitions still land in the address bar instead of vanishing.
  ['pushState', 'replaceState'].forEach(function (m) {
    var orig = history[m].bind(history);
    history[m] = function (state, title, url) {
      try { return orig(state, title, url); }
      catch (e) {
        try {
          var u = new URL(url, document.baseURI);
          return orig(state, title, location.origin + u.pathname + u.search + u.hash);
        } catch (e2) { return orig(state, title); }
      }
    };
  });

  // Rewrite the visible URL from /proxy?url=... to the target's own path on
  // our origin. SPA routers read window.location at hydration and crash when
  // the pathname doesn't match any of their routes.
  try {
    var proxied = new URLSearchParams(location.search).get('url');
    if (proxied) {
      var t = new URL(/^https?:\/\//i.test(proxied) ? proxied : 'https://' + proxied);
      history.replaceState(null, '', location.origin + t.pathname + t.search + t.hash);
    }
  } catch (e) { /* leave the proxy URL as-is */ }

  // Route the page's own API calls through our proxy. Relative fetch/XHR URLs
  // resolve against the injected <base> to the real origin — a cross-origin
  // request from this document that CORS blocks. Going via /proxy keeps them
  // same-origin here, and the proxy forwards method + body server-side.
  var TARGET_ORIGIN = (function () {
    try { return new URL(document.baseURI).origin; } catch (e) { return null; }
  })();

  function toProxy(u) {
    return location.origin + '/proxy?url=' + encodeURIComponent(u.href);
  }

  if (TARGET_ORIGIN && TARGET_ORIGIN !== location.origin) {
    var realFetch = window.fetch.bind(window);
    window.fetch = function (input, init) {
      try {
        var u = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url, document.baseURI);
        if (u.origin === TARGET_ORIGIN) {
          input = (typeof input === 'string' || input instanceof URL) ? toProxy(u) : new Request(toProxy(u), input);
        }
      } catch (e) { /* pass through untouched */ }
      return realFetch(input, init);
    };

    var realOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url) {
      try {
        var u = new URL(url, document.baseURI);
        if (u.origin === TARGET_ORIGIN) arguments[1] = toProxy(u);
      } catch (e) { /* pass through untouched */ }
      return realOpen.apply(this, arguments);
    };
  }

  var PICK_OUTLINE = '2px solid #e0b341';
  var picking = false;
  var hovered = null;
  var prevOutline = '';

  function post(msg) {
    window.parent.postMessage(Object.assign({ __codi: true }, msg), '*');
  }

  function cleanHTML() {
    var clone = document.documentElement.cloneNode(true);
    var injected = clone.querySelectorAll('[data-codi-bridge]');
    for (var i = 0; i < injected.length; i++) injected[i].remove();
    return clone.outerHTML;
  }

  function cssPath(el) {
    var parts = [];
    while (el && el.nodeType === 1 && el !== document.documentElement) {
      var part = el.tagName.toLowerCase();
      if (el.id) { parts.unshift(part + '#' + el.id); break; }
      if (el.classList.length) part += '.' + Array.prototype.slice.call(el.classList, 0, 2).join('.');
      var sibs = el.parentNode ? Array.prototype.filter.call(el.parentNode.children, function (c) { return c.tagName === el.tagName; }) : [];
      if (sibs.length > 1) part += ':nth-of-type(' + (sibs.indexOf(el) + 1) + ')';
      parts.unshift(part);
      el = el.parentNode;
    }
    return parts.join(' > ');
  }

  function onHover(e) {
    if (!picking) return;
    if (hovered) hovered.style.outline = prevOutline;
    hovered = e.target;
    prevOutline = hovered.style.outline;
    hovered.style.outline = PICK_OUTLINE;
  }

  function onPickClick(e) {
    if (!picking) return;
    e.preventDefault();
    e.stopPropagation();
    stopPicking();
    var el = e.target;
    post({ type: 'picked', html: el.outerHTML, selector: cssPath(el) });
  }

  function startPicking() {
    picking = true;
    document.addEventListener('mouseover', onHover, true);
    document.addEventListener('click', onPickClick, true);
    document.documentElement.style.cursor = 'crosshair';
  }

  function stopPicking() {
    picking = false;
    if (hovered) hovered.style.outline = prevOutline;
    hovered = null;
    document.removeEventListener('mouseover', onHover, true);
    document.removeEventListener('click', onPickClick, true);
    document.documentElement.style.cursor = '';
  }

  function applyBundle(code, id) {
    try {
      (0, eval)(code); // indirect eval = global scope, same as pasting in the console
      post({ type: 'bundle-applied', id: id, ok: true });
    } catch (err) {
      post({ type: 'bundle-applied', id: id, ok: false, error: String(err && err.stack || err) });
    }
  }

  window.addEventListener('message', function (e) {
    var msg = e.data;
    if (!msg || !msg.__codi) return;
    switch (msg.type) {
      case 'get-html':
        post({ type: 'html', id: msg.id, html: cleanHTML(), url: location.href, title: document.title });
        break;
      case 'apply-bundle':
        applyBundle(msg.code, msg.id);
        break;
      case 'pick-start':
        startPicking();
        break;
      case 'pick-stop':
        stopPicking();
        break;
    }
  });

  // Surface page runtime errors (e.g. thrown by an applied bundle) in the tester log.
  window.addEventListener('error', function (e) {
    post({ type: 'page-error', error: String(e.message) + ' @ ' + String(e.filename || '') + ':' + (e.lineno || '') });
  });

  // Announce readiness only once the document is fully parsed — the bridge
  // runs at the top of <head>, and an immediate capture would see partial HTML.
  function announce() {
    post({ type: 'ready', url: location.href, title: document.title });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', announce);
  else announce();
})();
