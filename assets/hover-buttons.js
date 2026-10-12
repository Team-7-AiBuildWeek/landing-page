/* ============================================================
   HOVER BUTTONS — the "interactive hover button" effect

   Rebuilds each .btn / .glow-btn as three layers (styles in
   walk.css, "HOVER BUTTONS"):
   • a dot before the label, which grows to fill the pill,
   • the label, which slides out to the right,
   • a copy of the label with an arrow, which slides in.
   Without JS the buttons stay as they are.
   ============================================================ */
(function () {
  var arrow = '<svg aria-hidden="true"><use href="#arrow"/></svg>';

  document.querySelectorAll('.btn, .glow-btn').forEach(function (btn) {
    var text = btn.textContent.replace(/\s+/g, ' ').trim();
    if (!text || btn.classList.contains('ih')) return;

    // The arrow now arrives on hover, so drop the resting one.
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
  });
})();
