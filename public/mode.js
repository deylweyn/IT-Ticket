/**
 * mode.js - light / dark mode toggle (small icon beside the bell, plus the
 * same icon in the corner of the sign-in screen).
 *
 * Each person picks their own mode; it's remembered on this device in
 * localStorage ("ui-mode"). Default is light. The <head> of index.html sets
 * data-mode before the page paints (no flash on load); this file wires the
 * buttons and plays the circular reveal that grows out of the clicked icon.
 */
(function () {
  "use strict";
  var KEY = "ui-mode";
  var root = document.documentElement;
  var btns = document.querySelectorAll(".mode-toggle-btn");

  function current() { return root.getAttribute("data-mode") === "dark" ? "dark" : "light"; }

  function sync() {
    var dark = current() === "dark";
    var label = dark ? "Switch to light mode" : "Switch to dark mode";
    btns.forEach(function (b) {
      b.setAttribute("aria-label", label);
      b.setAttribute("title", label);
      b.setAttribute("aria-pressed", dark ? "true" : "false");
    });
  }

  function apply(mode) {
    if (mode === "dark") root.setAttribute("data-mode", "dark");
    else root.removeAttribute("data-mode");
    try { localStorage.setItem(KEY, mode); } catch (e) {}
    sync();
  }

  // Switch with a circle that expands from (x, y). Falls back to an instant
  // switch where View Transitions aren't supported or motion is reduced.
  function switchTo(mode, x, y) {
    var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!document.startViewTransition || reduce) { apply(mode); return; }
    var r = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
    var t = document.startViewTransition(function () { apply(mode); });
    t.ready.then(function () {
      root.animate(
        { clipPath: ["circle(0px at " + x + "px " + y + "px)", "circle(" + r + "px at " + x + "px " + y + "px)"] },
        { duration: 550, easing: "ease-in-out", pseudoElement: "::view-transition-new(root)" }
      );
    }).catch(function () { /* transition skipped: the mode is already applied */ });
  }

  btns.forEach(function (b) {
    b.addEventListener("click", function () {
      var rect = b.getBoundingClientRect();
      switchTo(current() === "dark" ? "light" : "dark", rect.left + rect.width / 2, rect.top + rect.height / 2);
    });
  });
  sync();
})();
