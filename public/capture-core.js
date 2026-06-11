// Codi capture core — a single self-contained serializer used everywhere a page
// is captured (the bridge in proxy/cloud/snapshot iframes, and the browser
// extension on the real tab). Defines window.__codiCaptureHTML(opts) -> string.
//
// outerHTML alone misses external CSS *content*, shadow DOM, and live form state.
// This fills those gaps so the HTML sent to Codi reflects what's actually on screen.
//
// opts: { inlineCSS:boolean, shadow:boolean (default true), formState:boolean (default true) }
(function () {
  if (window.__codiCaptureHTML) return;

  function collectSheetCSS(sheetList, notes) {
    var out = [];
    for (var i = 0; i < sheetList.length; i++) {
      var sheet = sheetList[i];
      // skip the bridge's own / previously inlined styles
      var owner = sheet.ownerNode;
      if (owner && owner.hasAttribute && (owner.hasAttribute('data-codi-bridge') || owner.hasAttribute('data-codi-inlined'))) continue;
      var rules = null;
      try { rules = sheet.cssRules; } catch (e) { rules = null; } // cross-origin without CORS
      if (!rules) {
        if (sheet.href && notes) notes.blocked++;
        continue;
      }
      for (var j = 0; j < rules.length; j++) out.push(rules[j].cssText);
    }
    return out;
  }

  function collectCSS(doc, notes) {
    var out = collectSheetCSS(doc.styleSheets, notes);
    try { if (doc.adoptedStyleSheets) out = out.concat(collectSheetCSS(doc.adoptedStyleSheets, notes)); } catch (e) {}
    return out.join('\n');
  }

  // Reflect live form/UI state onto attributes so it survives serialization.
  function reflectFormState(root) {
    var els = root.querySelectorAll('input, textarea, select');
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      try {
        if (el.tagName === 'SELECT') {
          for (var k = 0; k < el.options.length; k++) {
            if (el.options[k].selected) el.options[k].setAttribute('selected', '');
            else el.options[k].removeAttribute('selected');
          }
        } else if (el.type === 'checkbox' || el.type === 'radio') {
          if (el.checked) el.setAttribute('checked', ''); else el.removeAttribute('checked');
        } else if (el.tagName === 'TEXTAREA') {
          el.textContent = el.value;
        } else if (el.value != null && el.type !== 'password') {
          el.setAttribute('value', el.value);
        }
      } catch (e) {}
    }
  }

  // Serialize OPEN shadow roots into declarative <template shadowrootmode>.
  // Walks the live tree (which has shadow roots) alongside the clone (which
  // doesn't, since cloneNode drops them). Closed roots are unreachable by design.
  function inlineShadow(orig, clone) {
    var oc = orig.children, cc = clone.children;
    for (var i = 0; i < oc.length && i < cc.length; i++) inlineShadow(oc[i], cc[i]);
    var sr = orig.shadowRoot;
    if (sr) {
      var tpl = document.createElement('template');
      tpl.setAttribute('shadowrootmode', sr.mode);
      var sheetCSS = '';
      try {
        if (sr.adoptedStyleSheets && sr.adoptedStyleSheets.length) {
          sheetCSS = '<style>' + collectSheetCSS(sr.adoptedStyleSheets, null).join('\n') + '</style>';
        }
      } catch (e) {}
      tpl.innerHTML = sheetCSS + sr.innerHTML;
      var so = sr.children, sc = tpl.content.children;
      for (var j = 0; j < so.length && j < sc.length; j++) inlineShadow(so[j], sc[j]);
      clone.insertBefore(tpl, clone.firstChild);
    }
  }

  window.__codiCaptureHTML = function (opts) {
    opts = opts || {};
    var doc = document;
    if (opts.formState !== false) { try { reflectFormState(doc); } catch (e) {} }

    var clone = doc.documentElement.cloneNode(true);
    var injected = clone.querySelectorAll('[data-codi-bridge]');
    for (var i = 0; i < injected.length; i++) injected[i].remove();

    if (opts.shadow !== false) { try { inlineShadow(doc.documentElement, clone); } catch (e) {} }

    if (opts.inlineCSS) {
      try {
        var notes = { blocked: 0 };
        var css = collectCSS(doc, notes);
        if (css) {
          var head = clone.querySelector('head') || clone;
          var style = doc.createElement('style');
          style.setAttribute('data-codi-inlined', '');
          if (notes.blocked) css = '/* ' + notes.blocked + ' cross-origin stylesheet(s) could not be inlined (no CORS) */\n' + css;
          style.textContent = css;
          head.appendChild(style);
        }
      } catch (e) {}
    }

    return '<!DOCTYPE html>\n' + clone.outerHTML;
  };
})();
