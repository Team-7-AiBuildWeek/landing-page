/* ============================================================
   AMBIENT BACKGROUND — cursor tracking

   How it stays cheap:
   • pointermove does nothing but store two numbers. No DOM reads,
     no writes, so it can never thrash layout.
   • A single requestAnimationFrame loop does all the writing, and
     it only ever writes `transform` — composited, no reflow.
   • The loop stops itself once the glow has caught up, so an idle
     page burns zero frames. A pointermove wakes it again.
   ============================================================ */
(function () {
  "use strict";

  /* ── TUNING ────────────────────────────────────────────────
     EASE  How quickly a layer catches the cursor, per frame.
           1 = welded to the pointer, 0.02 = a slow tide.
     DEPTH How far a layer travels relative to the cursor.
           1 = full range, 0.4 = stays near the middle.
           The gap between the two DEPTH values is the parallax.
     ─────────────────────────────────────────────────────────── */
  var LAYERS = [
    { selector: ".ambient-glow-near", ease: 0.070, depth: 1.0 },
    { selector: ".ambient-glow-far",  ease: 0.028, depth: 0.45 },
  ];

  var stage = document.querySelector(".ambient");
  if (!stage) return;

  var root = document.documentElement;
  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  // A real cursor, not a finger. Touch devices keep the CSS drift.
  var finePointer = window.matchMedia("(hover: hover) and (pointer: fine)");

  var layers = [];
  for (var i = 0; i < LAYERS.length; i++) {
    var el = stage.querySelector(LAYERS[i].selector);
    if (el) {
      layers.push({
        el: el,
        ease: LAYERS[i].ease,
        depth: LAYERS[i].depth,
        x: 0,
        y: 0,
      });
    }
  }
  if (!layers.length) return;

  var centreX = 0;
  var centreY = 0;
  var targetX = 0;
  var targetY = 0;
  var running = false;
  var active = false;

  function measure() {
    centreX = window.innerWidth / 2;
    centreY = window.innerHeight / 2;
  }

  function centreAll() {
    targetX = centreX;
    targetY = centreY;
    for (var i = 0; i < layers.length; i++) {
      layers[i].x = centreX;
      layers[i].y = centreY;
    }
  }

  function draw() {
    var moving = false;

    for (var i = 0; i < layers.length; i++) {
      var l = layers[i];
      // Scale the travel around the centre — this is the depth.
      var toX = centreX + (targetX - centreX) * l.depth;
      var toY = centreY + (targetY - centreY) * l.depth;

      l.x += (toX - l.x) * l.ease;
      l.y += (toY - l.y) * l.ease;

      // Sub-pixel movement is invisible; treat it as arrived so the
      // loop can stop instead of easing toward the target forever.
      if (Math.abs(toX - l.x) > 0.15 || Math.abs(toY - l.y) > 0.15) {
        moving = true;
      } else {
        l.x = toX;
        l.y = toY;
      }

      l.el.style.transform =
        "translate3d(" + l.x.toFixed(1) + "px, " + l.y.toFixed(1) + "px, 0)";
    }

    running = moving;
    if (moving) requestAnimationFrame(draw);
  }

  function wake() {
    if (!running) {
      running = true;
      requestAnimationFrame(draw);
    }
  }

  function onPointerMove(event) {
    // Ignore synthetic pointer events from taps and pens.
    if (event.pointerType && event.pointerType !== "mouse") return;
    targetX = event.clientX;
    targetY = event.clientY;
    wake();
  }

  // Cursor gone (left the window, switched tabs) — settle back to
  // the middle rather than freezing at the last known edge.
  function onPointerOut() {
    targetX = centreX;
    targetY = centreY;
    wake();
  }

  function onResize() {
    measure();
    wake();
  }

  function activate() {
    if (active) return;
    active = true;
    measure();
    centreAll();
    root.classList.add("ambient-live"); // switches the CSS drift off
    window.addEventListener("pointermove", onPointerMove, { passive: true });
    window.addEventListener("pointerout", onPointerOut, { passive: true });
    window.addEventListener("blur", onPointerOut);
    window.addEventListener("resize", onResize, { passive: true });
    wake();
  }

  function deactivate() {
    if (!active) return;
    active = false;
    root.classList.remove("ambient-live");
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerout", onPointerOut);
    window.removeEventListener("blur", onPointerOut);
    window.removeEventListener("resize", onResize);
    // Hand the transform back to the stylesheet so the CSS drift can
    // resume from a clean slate.
    for (var i = 0; i < layers.length; i++) layers[i].el.style.transform = "";
  }

  function sync() {
    if (finePointer.matches && !reduceMotion.matches) activate();
    else deactivate();
  }

  // Preferences can change mid-session: a system motion setting gets
  // flipped, or a 2-in-1 is detached from its keyboard.
  var onChange = function () { sync(); };
  if (reduceMotion.addEventListener) {
    reduceMotion.addEventListener("change", onChange);
    finePointer.addEventListener("change", onChange);
  } else if (reduceMotion.addListener) {
    reduceMotion.addListener(onChange); // Safari < 14
    finePointer.addListener(onChange);
  }

  sync();
})();
