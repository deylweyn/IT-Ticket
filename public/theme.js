/**
 * theme.js - site-wide seasonal themes (Halloween, Christmas, New Year,
 * Valentine's Day).
 *
 * The theme is chosen by a Super Admin (Accounts page -> "Site theme"),
 * stored on the server, and applied to everyone. There is no per-user
 * switch and no automatic date schedule.
 *
 *  GET  /api/theme  -> { theme: "none" | "halloween" | "christmas" | "newyear" | "valentines" }   (public,
 *                      so the sign-in screen can be themed too)
 *  POST /api/theme  -> Super Admin only
 *
 * The last theme is cached in localStorage purely to avoid a flash of the
 * plain look while the page loads; the server value always wins.
 * Styles: halloween.css / christmas.css / newyear.css / valentines.css. app.js calls AppTheme.set() right
 * after a Super Admin changes it so they see it instantly.
 */
(function () {
  "use strict";

  var CACHE_KEY = "app-theme-cache";
  var VALID = ["none", "halloween", "christmas", "newyear", "valentines"];
  var current = "none";
  var nodes = []; // everything we've injected for the current theme
  var cleanups = []; // timers etc. to stop when the theme changes

  function el(tag, cls, html) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html) n.innerHTML = html;
    return n;
  }
  function rnd(a, b) { return a + Math.random() * (b - a); }
  function track(n) { nodes.push(n); return n; }

  // ------------------------------------------------------------ Halloween
  var BAT = '<svg viewBox="0 0 64 32" aria-hidden="true"><path d="M32 9 L29.5 3 L28.5 11 C24 8 14 5 2 11 C6 13 8 17 7.5 22 C11 18 15 18 17.5 23 C20 18 25 18 28 24 L30 20 C31 22 31.5 23 32 25 C32.5 23 33 22 34 20 L36 24 C39 18 44 18 46.5 23 C49 18 53 18 56.5 22 C56 17 58 13 62 11 C50 5 40 8 35.5 11 L34.5 3 Z"/></svg>';
  var GHOST = '<svg viewBox="0 0 50 64" aria-hidden="true"><path d="M25 2 C12 2 4 12 4 26 L4 58 C4 62 7 62 9 59 L13 54 L18 61 L25 55 L32 61 L37 54 L41 59 C43 62 46 62 46 58 L46 26 C46 12 38 2 25 2 Z" fill="rgba(255,255,255,.92)" stroke="#BDBDBD" stroke-width="1.5"/><ellipse cx="18" cy="26" rx="3" ry="4.5" fill="#111"/><ellipse cx="32" cy="26" rx="3" ry="4.5" fill="#111"/><ellipse cx="25" cy="39" rx="3.5" ry="5" fill="#111"/></svg>';
  var SPIDER = '<svg viewBox="0 0 40 34" aria-hidden="true"><g fill="none" stroke-width="1.6" stroke-linecap="round"><path d="M14 18 L4 10 L1 16"/><path d="M14 21 L3 22 L1 29"/><path d="M15 24 L6 31 L5 34"/><path d="M26 18 L36 10 L39 16"/><path d="M26 21 L37 22 L39 29"/><path d="M25 24 L34 31 L35 34"/></g><circle cx="20" cy="22" r="8"/><circle cx="20" cy="11" r="5"/><circle cx="18" cy="10" r="1.3" fill="#FF5B3A" stroke="none"/><circle cx="22" cy="10" r="1.3" fill="#FF5B3A" stroke="none"/></svg>';

  function stars(parent, prefix) {
    for (var s = 0; s < 30; s++) {
      var st = el("div", "hw-star");
      st.style.setProperty("--x", rnd(2, 98).toFixed(1) + "%");
      st.style.setProperty("--y", rnd(2, 70).toFixed(1) + "%");
      st.style.setProperty("--s", rnd(1.5, 3.2).toFixed(1) + "px");
      st.style.setProperty("--d", rnd(2.5, 6).toFixed(1) + "s");
      st.style.setProperty("--delay", (-rnd(0, 6)).toFixed(1) + "s");
      parent.appendChild(st);
    }
  }

  function buildHalloween() {
    var layer = track(el("div", "hw-layer"));
    layer.setAttribute("aria-hidden", "true");
    for (var i = 0; i < 7; i++) {
      var dur = rnd(15, 30);
      var bat = el("div", "hw-bat" + (i % 2 ? " rtl" : ""));
      bat.style.setProperty("--top", rnd(5, 72).toFixed(1) + "%");
      bat.style.setProperty("--size", rnd(26, 46).toFixed(0) + "px");
      bat.style.setProperty("--dur", dur.toFixed(1) + "s");
      bat.style.setProperty("--delay", (-rnd(0, dur)).toFixed(1) + "s");
      bat.style.setProperty("--bob", rnd(1.4, 2.8).toFixed(2) + "s");
      bat.style.setProperty("--flap", rnd(0.32, 0.5).toFixed(2) + "s");
      bat.appendChild(el("div", "hw-bob", BAT));
      layer.appendChild(bat);
    }
    for (var g = 0; g < 4; g++) {
      var gd = rnd(32, 50);
      var gh = el("div", "hw-ghost", GHOST);
      gh.style.setProperty("--left", rnd(6, 90).toFixed(0) + "%");
      gh.style.setProperty("--size", rnd(34, 54).toFixed(0) + "px");
      gh.style.setProperty("--dur", gd.toFixed(1) + "s");
      gh.style.setProperty("--delay", (-rnd(0, gd)).toFixed(1) + "s");
      layer.appendChild(gh);
    }
    var sp = el("div", "hw-spider", '<div class="hw-thread"></div>' + SPIDER);
    sp.style.setProperty("--left", "52%");
    layer.appendChild(sp);
    document.body.appendChild(layer);

    var auth = document.getElementById("auth-screen");
    if (auth) {
      var sky = track(el("div", "hw-sky"));
      sky.setAttribute("aria-hidden", "true");
      sky.appendChild(el("div", "hw-moon"));
      stars(sky);
      auth.insertBefore(sky, auth.firstChild);
    }
  }

  // ------------------------------------------------------------ Christmas
  function buildChristmas() {
    var layer = track(el("div", "xm-layer"));
    layer.setAttribute("aria-hidden", "true");

    for (var i = 0; i < 40; i++) {
      var f = el("div", "xm-flake");
      var dur = rnd(9, 20);
      f.style.setProperty("--x", rnd(0, 100).toFixed(1) + "%");
      f.style.setProperty("--s", rnd(3, 7).toFixed(1) + "px");
      f.style.setProperty("--o", rnd(0.6, 0.95).toFixed(2));
      f.style.setProperty("--dur", dur.toFixed(1) + "s");
      f.style.setProperty("--delay", (-rnd(0, dur)).toFixed(1) + "s");
      layer.appendChild(f);
    }

    var lights = el("div", "xm-lights");
    var colors = ["#E53935", "#FFF3C4", "#43A047", "#1E88E5"];
    for (var c = 0; c < 4; c++) {
      var b = el("i");
      b.style.setProperty("--c", colors[c]);
      b.style.setProperty("--off", (c * 38) + "px");
      b.style.setProperty("--ph", (-c * 0.6).toFixed(1) + "s");
      lights.appendChild(b);
    }
    layer.appendChild(lights);
    document.body.appendChild(layer);

    var auth = document.getElementById("auth-screen");
    if (auth) {
      var sky = track(el("div", "xm-sky"));
      sky.setAttribute("aria-hidden", "true");
      stars(sky);
      sky.appendChild(el("div", "xm-hill a"));
      sky.appendChild(el("div", "xm-hill b"));
      auth.insertBefore(sky, auth.firstChild);
    }
  }

  // ------------------------------------------------------------ New Year
  var NY_COLORS = ["#F6C945", "#C9D1DC", "#FFFFFF", "#4C6EF5", "#F6C945", "#8FA8E8"];
  var BURST_COLORS = ["#F6C945", "#DDE6F5", "#4DABF7", "#FFD43B", "#91A7FF"];

  function fireworkBurst(layer) {
    if (document.hidden) return;
    var burst = el("div", "ny-burst");
    burst.style.left = rnd(12, 88).toFixed(0) + "%";
    burst.style.top = rnd(12, 55).toFixed(0) + "%";
    var color = BURST_COLORS[Math.floor(Math.random() * BURST_COLORS.length)];
    var n = 18, radius = rnd(55, 110);
    for (var i = 0; i < n; i++) {
      var ang = (i / n) * Math.PI * 2;
      var sp = el("div", "ny-spark");
      sp.style.setProperty("--c", i % 3 === 0 ? "#F6C945" : color);
      sp.style.setProperty("--dx", (Math.cos(ang) * radius).toFixed(0) + "px");
      sp.style.setProperty("--dy", (Math.sin(ang) * radius).toFixed(0) + "px");
      burst.appendChild(sp);
    }
    layer.appendChild(burst);
    setTimeout(function () { burst.remove(); }, 1700);
  }

  function buildNewYear() {
    var layer = track(el("div", "ny-layer"));
    layer.setAttribute("aria-hidden", "true");
    for (var i = 0; i < 36; i++) {
      var c = el("div", "ny-confetti");
      var dur = rnd(8, 17);
      c.style.setProperty("--x", rnd(0, 100).toFixed(1) + "%");
      c.style.setProperty("--w", rnd(5, 9).toFixed(0) + "px");
      c.style.setProperty("--h", rnd(8, 14).toFixed(0) + "px");
      c.style.setProperty("--c", NY_COLORS[i % NY_COLORS.length]);
      c.style.setProperty("--r", (rnd(360, 900) * (i % 2 ? 1 : -1)).toFixed(0) + "deg");
      c.style.setProperty("--dur", dur.toFixed(1) + "s");
      c.style.setProperty("--delay", (-rnd(0, dur)).toFixed(1) + "s");
      layer.appendChild(c);
    }
    document.body.appendChild(layer);

    var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!reduce) {
      fireworkBurst(layer);
      var t = setInterval(function () { fireworkBurst(layer); }, 3200);
      cleanups.push(function () { clearInterval(t); });
    }

    var auth = document.getElementById("auth-screen");
    if (auth) {
      var sky = track(el("div", "ny-sky"));
      sky.setAttribute("aria-hidden", "true");
      stars(sky);
      auth.insertBefore(sky, auth.firstChild);
    }
  }

  // ------------------------------------------------------------ Valentine's
  var VD_COLORS = ["#D6204A", "#E64980", "#FF8FAB", "#FFFFFF", "#C41E4A"];

  function buildValentines() {
    var layer = track(el("div", "vd-layer"));
    layer.setAttribute("aria-hidden", "true");
    for (var i = 0; i < 22; i++) {
      var h = el("div", "vd-heart", "\u2665");
      var dur = rnd(11, 22);
      h.style.setProperty("--x", rnd(2, 96).toFixed(1) + "%");
      h.style.setProperty("--s", rnd(14, 34).toFixed(0) + "px");
      h.style.setProperty("--c", VD_COLORS[i % VD_COLORS.length]);
      h.style.setProperty("--o", rnd(0.5, 0.85).toFixed(2));
      h.style.setProperty("--dur", dur.toFixed(1) + "s");
      h.style.setProperty("--delay", (-rnd(0, dur)).toFixed(1) + "s");
      layer.appendChild(h);
    }
    document.body.appendChild(layer);

    var auth = document.getElementById("auth-screen");
    if (auth) {
      var sky = track(el("div", "vd-sky"));
      sky.setAttribute("aria-hidden", "true");
      stars(sky);
      auth.insertBefore(sky, auth.firstChild);
    }
  }

  // ------------------------------------------------------------ switching
  var BUILDERS = { halloween: buildHalloween, christmas: buildChristmas, newyear: buildNewYear, valentines: buildValentines };

  function set(theme) {
    if (VALID.indexOf(theme) === -1) theme = "none";
    if (theme === current) return;
    nodes.forEach(function (n) { n.remove(); });
    nodes = [];
    cleanups.forEach(function (fn) { fn(); });
    cleanups = [];
    document.body.classList.remove("halloween", "christmas", "newyear", "valentines");
    current = theme;
    if (BUILDERS[theme]) {
      document.body.classList.add(theme);
      BUILDERS[theme]();
    }
    try { localStorage.setItem(CACHE_KEY, theme); } catch (e) {}
  }

  function refresh() {
    fetch("/api/theme", { credentials: "same-origin", cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) { if (d && d.theme) set(d.theme); })
      .catch(function () { /* offline / server hiccup: keep what we have */ });
  }

  // 1) instant apply from cache (no flash), 2) server is the source of truth
  try { set(localStorage.getItem(CACHE_KEY) || "none"); } catch (e) {}
  refresh();
  setInterval(refresh, 5 * 60 * 1000);
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden) refresh();
  });

  window.AppTheme = { set: set, current: function () { return current; } };
})();
