/**
 * halloween.js - seasonal "Halloween" decoration for the Ticket Desk.
 *
 * Self-contained: no changes to app.js needed. It
 *  - switches itself on automatically from Oct 1 to Nov 2 (and does nothing
 *    at all outside that window),
 *  - adds a "Halloween theme" on/off button to the sidebar (choice is
 *    remembered per browser),
 *  - draws flying bats, drifting ghosts and a dangling spider as pure
 *    CSS/SVG animation (see halloween.css) - sharp at any size, tiny, and
 *    no image files to host.
 *
 * Testing outside the season: add ?halloween=1 to the URL (?halloween=0 to
 * force it off).
 */
(function () {
  "use strict";

  var KEY = "hw-theme";
  var now = new Date();
  var m = now.getMonth(), d = now.getDate();
  var inSeason = m === 9 || (m === 10 && d <= 2); // Oct 1 - Nov 2

  var q = new URLSearchParams(location.search).get("halloween");
  var stored = null;
  try { stored = localStorage.getItem(KEY); } catch (e) {}
  if (q === "1") stored = "on";
  else if (q === "0") stored = "off";

  if (!inSeason && q !== "1") return;

  var enabled = stored ? stored === "on" : true;
  var layer = null, sky = null, btn = null;

  var BAT = '<svg viewBox="0 0 64 32" aria-hidden="true"><path d="M32 9 L29.5 3 L28.5 11 C24 8 14 5 2 11 C6 13 8 17 7.5 22 C11 18 15 18 17.5 23 C20 18 25 18 28 24 L30 20 C31 22 31.5 23 32 25 C32.5 23 33 22 34 20 L36 24 C39 18 44 18 46.5 23 C49 18 53 18 56.5 22 C56 17 58 13 62 11 C50 5 40 8 35.5 11 L34.5 3 Z"/></svg>';
  var GHOST = '<svg viewBox="0 0 50 64" aria-hidden="true"><path d="M25 2 C12 2 4 12 4 26 L4 58 C4 62 7 62 9 59 L13 54 L18 61 L25 55 L32 61 L37 54 L41 59 C43 62 46 62 46 58 L46 26 C46 12 38 2 25 2 Z" fill="rgba(255,255,255,.92)" stroke="#9B8AC4" stroke-width="1.5"/><ellipse cx="18" cy="26" rx="3" ry="4.5" fill="#2A1B4D"/><ellipse cx="32" cy="26" rx="3" ry="4.5" fill="#2A1B4D"/><ellipse cx="25" cy="39" rx="3.5" ry="5" fill="#2A1B4D"/></svg>';
  var SPIDER = '<svg viewBox="0 0 40 34" aria-hidden="true"><g fill="none" stroke-width="1.6" stroke-linecap="round"><path d="M14 18 L4 10 L1 16"/><path d="M14 21 L3 22 L1 29"/><path d="M15 24 L6 31 L5 34"/><path d="M26 18 L36 10 L39 16"/><path d="M26 21 L37 22 L39 29"/><path d="M25 24 L34 31 L35 34"/></g><circle cx="20" cy="22" r="8"/><circle cx="20" cy="11" r="5"/><circle cx="18" cy="10" r="1.3" fill="#FF5B3A" stroke="none"/><circle cx="22" cy="10" r="1.3" fill="#FF5B3A" stroke="none"/></svg>';

  function el(tag, cls, html) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html) n.innerHTML = html;
    return n;
  }
  function rnd(a, b) { return a + Math.random() * (b - a); }

  function build() {
    if (layer) return;
    layer = el("div", "hw-layer");
    layer.setAttribute("aria-hidden", "true");

    for (var i = 0; i < 7; i++) {
      var dur = rnd(15, 30);
      var bat = el("div", "hw-bat" + (i % 2 ? " rtl" : ""));
      bat.style.setProperty("--top", rnd(5, 72).toFixed(1) + "%");
      bat.style.setProperty("--size", rnd(26, 46).toFixed(0) + "px");
      bat.style.setProperty("--dur", dur.toFixed(1) + "s");
      bat.style.setProperty("--delay", (-rnd(0, dur)).toFixed(1) + "s"); // already mid-flight on load
      bat.style.setProperty("--bob", rnd(1.4, 2.8).toFixed(2) + "s");
      bat.style.setProperty("--flap", rnd(0.32, 0.5).toFixed(2) + "s");
      var bob = el("div", "hw-bob", BAT);
      bat.appendChild(bob);
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

    // Moon + stars live inside the sign-in screen only.
    var auth = document.getElementById("auth-screen");
    if (auth) {
      sky = el("div", "hw-sky");
      sky.setAttribute("aria-hidden", "true");
      sky.appendChild(el("div", "hw-moon"));
      for (var s = 0; s < 30; s++) {
        var st = el("div", "hw-star");
        st.style.setProperty("--x", rnd(2, 98).toFixed(1) + "%");
        st.style.setProperty("--y", rnd(2, 70).toFixed(1) + "%");
        st.style.setProperty("--s", rnd(1.5, 3.2).toFixed(1) + "px");
        st.style.setProperty("--d", rnd(2.5, 6).toFixed(1) + "s");
        st.style.setProperty("--delay", (-rnd(0, 6)).toFixed(1) + "s");
        sky.appendChild(st);
      }
      auth.insertBefore(sky, auth.firstChild);
    }
  }

  function destroy() {
    if (layer) { layer.remove(); layer = null; }
    if (sky) { sky.remove(); sky = null; }
  }

  function apply(on, persist) {
    enabled = on;
    document.body.classList.toggle("halloween", on);
    if (on) build(); else destroy();
    if (btn) {
      btn.textContent = "\uD83C\uDF83 Halloween theme: " + (on ? "On" : "Off");
      btn.setAttribute("aria-pressed", on ? "true" : "false");
    }
    if (persist) { try { localStorage.setItem(KEY, on ? "on" : "off"); } catch (e) {} }
  }

  function addToggle() {
    var footer = document.querySelector(".sidebar-footer");
    if (!footer) return;
    btn = el("button", "btn btn-ghost btn-block hw-toggle");
    btn.type = "button";
    btn.addEventListener("click", function () { apply(!enabled, true); });
    var logout = document.getElementById("logout-btn");
    footer.insertBefore(btn, logout || null);
  }

  addToggle();
  apply(enabled, false);
})();
