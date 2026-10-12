/* ============================================================
   HOVER BUTTONS — the "interactive hover button" effect

   Rebuilds each .btn / .glow-btn as three layers (styles in
   assets/hover-buttons.css):
   • a dot before the label, which grows to fill the pill,
   • the label, which slides out to the right,
   • a copy of the label with an arrow, which slides in.
   Buttons added later by a page's own script are picked up too. Without JS the buttons stay as they are.
   ============================================================ */
(function () {
  var arrow = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>';

  function enhance(btn) {
    // Already built, unless a script has since replaced its text.
    if (btn.querySelector(':scope > .ih-label')) return;
    var text = btn.textContent.replace(/\s+/g, ' ').trim();
    if (!text) return;

    // The arrow now arrives on hover, so drop a resting one.
    btn.querySelectorAll('svg').forEach(function (s) { s.remove(); });

    var label = document.createElement('span');
    label.className = 'ih-label';
    while (btn.firstChild) label.appendChild(btn.firstChild);

    var dot = document.createElement('span');
    dot.className = 'ih-dot';
    dot.setAttribute('aria-hidden', 'true');

    var hover = document.createElement('span');
    hover.className = 'ih-hover';
    hover.setAttribute('aria-hidden', 'true');
    hover.textContent = text;
    hover.insertAdjacentHTML('beforeend', arrow);

    btn.append(dot, label, hover);
    btn.classList.add('ih');
    btn.style.setProperty('--ih-x', getComputedStyle(btn).paddingLeft);
  }

  function scan(root) {
    if (root.matches && root.matches('.btn, .glow-btn')) enhance(root);
    if (root.querySelectorAll) root.querySelectorAll('.btn, .glow-btn').forEach(enhance);
  }

  scan(document);
  new MutationObserver(function (records) {
    records.forEach(function (r) {
      if (r.target.matches && r.target.matches('.btn, .glow-btn')) enhance(r.target);
      r.addedNodes.forEach(function (n) { if (n.nodeType === 1) scan(n); });
    });
  }).observe(document.body, { childList: true, subtree: true });
})();
