/**
 * vivash.s — Content Protection Layer
 * Stacks on top of rt.js
 */
(function () {
  'use strict';

  /* ── 1. Image drag / save prevention ─────────────────── */
  function lockImages() {
    document.querySelectorAll('img').forEach(applyImageLock);
    // Also lock images loaded dynamically after page load
    new MutationObserver(function (mutations) {
      mutations.forEach(function (m) {
        m.addedNodes.forEach(function (node) {
          if (node.nodeType !== 1) return;
          if (node.tagName === 'IMG') applyImageLock(node);
          node.querySelectorAll && node.querySelectorAll('img').forEach(applyImageLock);
        });
      });
    }).observe(document.body || document.documentElement, { childList: true, subtree: true });
  }

  function applyImageLock(img) {
    img.setAttribute('draggable', 'false');
    img.setAttribute('oncontextmenu', 'return false');
    img.style.userSelect = 'none';
    img.style.webkitUserSelect = 'none';
    img.style.pointerEvents = 'none'; // overlay handles clicks
    img.addEventListener('dragstart', function (e) { e.preventDefault(); return false; });
    img.addEventListener('mousedown', function (e) { if (e.button === 2) e.preventDefault(); });
  }

  /* ── 2. Transparent overlay on every image container ─── */
  function addOverlays() {
    var containers = document.querySelectorAll(
      '.instagram-img-c, .portfolio-card, .image-container span, .bio-image'
    );
    containers.forEach(function (el) {
      if (el.querySelector('.__img-guard')) return;
      var guard = document.createElement('div');
      guard.className = '__img-guard';
      guard.style.cssText = [
        'position:absolute', 'inset:0', 'z-index:9999',
        'user-select:none', '-webkit-user-select:none',
        'pointer-events:auto', 'background:transparent',
        'cursor:default'
      ].join(';');
      guard.addEventListener('contextmenu', function (e) { e.preventDefault(); return false; });
      guard.addEventListener('dragstart', function (e) { e.preventDefault(); return false; });
      el.style.position = el.style.position || 'relative';
      el.appendChild(guard);
    });
  }

  /* ── 3. Block keyboard shortcuts ────────────────────────
     (Ctrl/Cmd + S, U, P, Shift+I, F12 already in rt.js
      — this adds Print Screen awareness & drag-image) */
  function blockPrintScreen(e) {
    if (e.key === 'PrintScreen') {
      // Can't fully block, but wipe clipboard immediately
      try { navigator.clipboard && navigator.clipboard.writeText(''); } catch (_) {}
    }
  }

  /* ── 4. Disable text selection globally (CSS already does
     user-select:none, this is a JS fallback) ───────────── */
  function noSelect(e) {
    if (e.target.closest('input, textarea, select')) return; // allow in forms
    e.preventDefault();
    return false;
  }

  /* ── 5. Disable view-source shortcut (belt-and-suspenders) */
  function blockViewSource(e) {
    var k = e.keyCode || e.which;
    // Ctrl+U  (85)  Ctrl+Shift+I (73)  Ctrl+Shift+J (74)  Ctrl+Shift+C (67)  F12 (123)
    var blocked = [85, 73, 74, 67];
    if ((e.ctrlKey || e.metaKey) && blocked.indexOf(k) !== -1) {
      e.preventDefault(); e.stopPropagation(); return false;
    }
    if (k === 123) { // F12
      e.preventDefault(); e.stopPropagation(); return false;
    }
  }

  /* ── 6. Disable right-click globally ────────────────────  */
  function noContextMenu(e) {
    e.preventDefault(); return false;
  }

  /* ── 7. Prevent copy / cut ──────────────────────────────  */
  function noCopy(e) {
    if (e.target.closest('input, textarea')) return; // allow in forms
    e.preventDefault(); return false;
  }

  /* ── 8. Hidden copyright watermark in DOM ───────────────  */
  function injectCopyrightMeta() {
    var existing = document.getElementById('__vs_copyright');
    if (existing) return;
    var m = document.createElement('meta');
    m.id = '__vs_copyright';
    m.name = 'copyright';
    m.content = '© vivash.s — All rights reserved. Unauthorised reproduction strictly prohibited.';
    document.head && document.head.appendChild(m);

    // Also stamp the HTML comment signature (visible in source)
    var stamp = document.createComment(
      ' © vivash.s | vivashsingh.com | All images and content are copyright protected. '
    );
    document.documentElement.insertBefore(stamp, document.documentElement.firstChild);
  }

  /* ── 9. Bind everything once DOM is ready ───────────────  */
  function init() {
    lockImages();
    addOverlays();
    injectCopyrightMeta();

    document.addEventListener('contextmenu', noContextMenu, true);
    document.addEventListener('copy', noCopy, true);
    document.addEventListener('cut', noCopy, true);
    document.addEventListener('selectstart', noSelect, true);
    document.addEventListener('keydown', blockViewSource, true);
    window.addEventListener('keyup', blockPrintScreen, true);

    // Re-run overlays after dynamic content loads
    document.addEventListener('content-loaded', function () {
      setTimeout(function () { lockImages(); addOverlays(); }, 300);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
