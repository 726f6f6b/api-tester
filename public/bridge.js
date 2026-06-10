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
  ['pushState', 'replaceState'].forEach(function (m) {
    var orig = history[m].bind(history);
    history[m] = function (state, title, url) {
      try { return orig(state, title, url); }
      catch (e) { return orig(state, title); }
    };
  });

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

  post({ type: 'ready', url: location.href, title: document.title });
})();
