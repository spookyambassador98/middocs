/*!
 * visit-gate.js — гейт «кто смотрит» + трекер визита → SalonTech /api/visits
 *
 * Подключение (одна строка в <head> или перед </body>):
 *   <script src="/visit-gate.js" data-visit-project="price-radar" data-visit-title="Price Radar" defer></script>
 *
 * Атрибуты:
 *   data-visit-project   id проекта в SalonTech (price-radar | freshrail | middocs | pulse)
 *   data-visit-title     как проект называется на гейте
 *   data-visit-endpoint  куда слать (по умолчанию https://salontech-mu.vercel.app/api/visits)
 *
 * Свои заходы не считаются: открой сайт один раз с ?visit-gate=off
 * (вернуть: ?visit-gate=on). Playwright/боты (navigator.webdriver) гейт не видят.
 */
(function () {
  "use strict";
  if (typeof window === "undefined" || window.__visitGate) return;
  window.__visitGate = true;

  var script =
    document.currentScript ||
    document.querySelector("script[data-visit-project]");
  var PROJECT = (script && script.getAttribute("data-visit-project")) || "";
  var TITLE = (script && script.getAttribute("data-visit-title")) || document.title || PROJECT;
  var ENDPOINT =
    (script && script.getAttribute("data-visit-endpoint")) ||
    "https://salontech-mu.vercel.app/api/visits";
  if (!PROJECT) return;

  var K = {
    vid: "vg-vid-" + PROJECT,
    company: "vg-company",
    name: "vg-name",
    role: "vg-role",
    start: "vg-start-" + PROJECT,
    land: "vg-land-" + PROJECT,
    off: "vg-off",
  };

  function ls(k, v) {
    try {
      if (v === undefined) return localStorage.getItem(k);
      if (v === null) localStorage.removeItem(k);
      else localStorage.setItem(k, v);
    } catch (e) {}
    return null;
  }
  function ss(k, v) {
    try {
      if (v === undefined) return sessionStorage.getItem(k);
      if (v === null) sessionStorage.removeItem(k);
      else sessionStorage.setItem(k, v);
    } catch (e) {}
    return null;
  }

  // Переключатель «это я, не считать».
  try {
    var q = new URLSearchParams(location.search).get("visit-gate");
    if (q === "off") ls(K.off, "1");
    if (q === "on") ls(K.off, null);
  } catch (e) {}
  if (ls(K.off) === "1" || navigator.webdriver) return;

  function clean(v, max) {
    return String(v || "").replace(/\s+/g, " ").trim().slice(0, max || 80);
  }
  function newVid() {
    var raw =
      (window.crypto && crypto.randomUUID && crypto.randomUUID()) ||
      "v" + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
    return raw.replace(/[^a-zA-Z0-9_-]/g, "");
  }
  // Хэш (#...) никогда не отправляем: в middocs там лежит ключ шифрования документа.
  function here() {
    return location.pathname + location.search;
  }
  function hrefNoHash() {
    return location.href.split("#")[0];
  }

  /* ───────────── отправка ───────────── */

  var identity = null; // { vid, company, name, role }

  function send(events) {
    if (!identity) return;
    var started = Number(ss(K.start) || Date.now());
    var body = JSON.stringify({
      vid: identity.vid,
      company: identity.company,
      name: identity.name,
      role: identity.role,
      project: PROJECT,
      events: events.map(function (e) {
        return { type: e.type, path: e.path || here(), detail: e.detail, at: new Date().toISOString() };
      }),
      referrer: document.referrer || null,
      landing: ss(K.land) || hrefNoHash(),
      href: hrefNoHash(),
      ua: navigator.userAgent,
      lang: navigator.language,
      tz: (Intl.DateTimeFormat().resolvedOptions() || {}).timeZone,
      screen: window.screen.width + "x" + window.screen.height,
      durationSec: Math.max(1, Math.round((Date.now() - started) / 1000)),
    });
    try {
      var blob = new Blob([body], { type: "text/plain" });
      if (navigator.sendBeacon && navigator.sendBeacon(ENDPOINT, blob)) return;
    } catch (e) {}
    try {
      fetch(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: body,
        keepalive: true,
        mode: "cors",
      }).catch(function () {});
    } catch (e) {}
  }

  /* ───────────── трекер ───────────── */

  function label(el) {
    return clean(
      el.getAttribute("data-track") ||
        el.getAttribute("aria-label") ||
        el.getAttribute("title") ||
        (el.innerText || "").trim() ||
        (el.getAttribute("href") || "").replace(/#.*/, "#") ||
        el.tagName,
      80,
    );
  }

  function startTracking(isNew) {
    if (isNew) {
      send([
        { type: "gate", detail: "unlocked" },
        { type: "page", detail: clean(document.title, 80) },
      ]);
    } else {
      send([{ type: "page", detail: clean(document.title, 80) }]);
    }

    // SPA-навигация (React Router, Next): ловим pushState / replaceState / назад.
    var lastPath = here();
    function onRoute() {
      var p = here();
      if (p === lastPath) return;
      lastPath = p;
      seenScroll = {};
      setTimeout(function () {
        send([{ type: "page", detail: clean(document.title, 80) }]);
      }, 50);
    }
    ["pushState", "replaceState"].forEach(function (fn) {
      var orig = history[fn];
      history[fn] = function () {
        var r = orig.apply(this, arguments);
        onRoute();
        return r;
      };
    });
    window.addEventListener("popstate", onRoute);

    document.addEventListener(
      "click",
      function (e) {
        var t = e.target;
        var el = t && t.closest && t.closest("a,button,[role='button'],input[type='submit'],summary,[data-track]");
        if (!el || el.closest("#visit-gate")) return;
        send([{ type: "click", detail: el.tagName.toLowerCase() + ":" + label(el) }]);
      },
      true,
    );

    document.addEventListener(
      "submit",
      function (e) {
        var f = e.target;
        if (f && f.closest && f.closest("#visit-gate")) return;
        send([{ type: "form", detail: (f && (f.getAttribute("name") || f.id)) || "submit" }]);
      },
      true,
    );

    var seenScroll = {};
    function onScroll() {
      var doc = document.documentElement;
      var max = Math.max(1, doc.scrollHeight - window.innerHeight);
      var pct = Math.min(100, Math.round((window.scrollY / max) * 100));
      [25, 50, 75, 100].forEach(function (m) {
        if (pct >= m && !seenScroll[m] && doc.scrollHeight > window.innerHeight * 1.2) {
          seenScroll[m] = true;
          send([{ type: "scroll", detail: m + "%" }]);
        }
      });
    }
    window.addEventListener("scroll", onScroll, { passive: true });

    // Пульс: пока вкладка открыта и видна — каждые 15 с. Так панель видит «смотрит сейчас».
    function ping() {
      var started = Number(ss(K.start) || Date.now());
      send([{ type: "dwell", detail: Math.max(1, Math.round((Date.now() - started) / 1000)) + "s" }]);
    }
    setInterval(function () {
      if (document.visibilityState === "visible") ping();
    }, 15000);
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "hidden") send([{ type: "leave", detail: "hidden" }]);
      else send([{ type: "back", detail: "visible" }]);
    });
    window.addEventListener("pagehide", function () {
      send([{ type: "leave", detail: "close" }]);
    });
  }

  /* ───────────── гейт ───────────── */

  var CSS =
    "#visit-gate{position:fixed;inset:0;z-index:2147483646;display:flex;align-items:center;justify-content:center;padding:16px;" +
    "background:rgba(6,6,8,.72);backdrop-filter:blur(14px) saturate(120%);-webkit-backdrop-filter:blur(14px) saturate(120%);" +
    "font-family:ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;color:#ecebe6;animation:vg-in .35s ease both}" +
    "#visit-gate *{box-sizing:border-box}#visit-gate{cursor:default}#visit-gate input{cursor:text}" +
    "#visit-gate .vg-card{width:100%;max-width:420px;background:#0e0e11;border:1px solid rgba(255,255,255,.12);border-radius:18px;" +
    "padding:28px 26px 22px;box-shadow:0 30px 80px rgba(0,0,0,.55);animation:vg-up .45s cubic-bezier(.16,1,.3,1) both}" +
    "#visit-gate .vg-kicker{font:600 10px/1 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;letter-spacing:.26em;text-transform:uppercase;color:#8a8a93}" +
    "#visit-gate h2{margin:12px 0 8px;font-size:26px;line-height:1.1;font-weight:700;letter-spacing:-.01em;color:#fff}" +
    "#visit-gate p{margin:0 0 20px;font-size:13.5px;line-height:1.5;color:#a3a3ad}" +
    "#visit-gate label{display:block;margin:0 0 12px}" +
    "#visit-gate label span{display:block;margin:0 0 6px;font:600 10px/1 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;letter-spacing:.18em;text-transform:uppercase;color:#8a8a93}" +
    "#visit-gate label span i{font-style:normal;color:#5d5d66;letter-spacing:.08em;text-transform:none}" +
    "#visit-gate input{width:100%;height:44px;padding:0 14px;border-radius:10px;border:1px solid rgba(255,255,255,.14);background:#151519;color:#fff;" +
    "font-size:15px;font-family:inherit;outline:none;transition:border-color .15s,box-shadow .15s}" +
    "#visit-gate input:focus{border-color:#e8e6df;box-shadow:0 0 0 3px rgba(232,230,223,.14)}" +
    "#visit-gate .vg-row{display:grid;grid-template-columns:1fr 1fr;gap:10px}" +
    "#visit-gate button{width:100%;height:46px;margin-top:6px;border:0;border-radius:999px;background:#ecebe6;color:#0b0b0c;" +
    "font-family:inherit;font-weight:700;font-size:13px;line-height:1;letter-spacing:.06em;text-transform:uppercase;cursor:pointer;transition:transform .15s,opacity .15s}" +
    "#visit-gate button:hover{transform:translateY(-1px)}#visit-gate button:disabled{opacity:.35;cursor:not-allowed;transform:none}" +
    "#visit-gate .vg-foot{margin-top:14px;font-size:11px;line-height:1.45;color:#6c6c75;text-align:center}" +
    "#visit-gate .vg-err{min-height:16px;margin:-4px 0 6px;font-size:12px;color:#ff8a7a}" +
    "@keyframes vg-in{from{opacity:0}to{opacity:1}}@keyframes vg-up{from{opacity:0;transform:translateY(14px) scale(.98)}to{opacity:1;transform:none}}" +
    "@media (max-width:420px){#visit-gate .vg-row{grid-template-columns:1fr}#visit-gate .vg-card{padding:24px 18px 18px}}" +
    "@media (prefers-reduced-motion:reduce){#visit-gate,#visit-gate .vg-card{animation:none}}";

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function showGate() {
    var style = document.createElement("style");
    style.id = "visit-gate-style";
    style.textContent = CSS;
    document.head.appendChild(style);

    var root = document.createElement("div");
    root.id = "visit-gate";
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-modal", "true");
    root.setAttribute("aria-labelledby", "vg-title");
    root.innerHTML =
      '<form class="vg-card" novalidate>' +
      '<div class="vg-kicker">Live demo \u00b7 ' + esc(TITLE) + "</div>" +
      '<h2 id="vg-title">Who\u2019s viewing?</h2>' +
      "<p>Tell me which company you\u2019re from and the demo opens right away.</p>" +
      '<label><span>Company</span><input name="company" autocomplete="organization" maxlength="80" required placeholder="Acme Inc."></label>' +
      '<div class="vg-row">' +
      '<label><span>Name <i>\u00b7 optional</i></span><input name="name" autocomplete="name" maxlength="80" placeholder="Jane"></label>' +
      '<label><span>Role <i>\u00b7 optional</i></span><input name="role" autocomplete="organization-title" maxlength="80" placeholder="Recruiter"></label>' +
      "</div>" +
      '<div class="vg-err" aria-live="polite"></div>' +
      '<button type="submit" disabled>Open the demo</button>' +
      '<div class="vg-foot">Used only so Rauf knows who looked. No email, no spam.</div>' +
      "</form>";

    var mount = function () {
      document.body.appendChild(root);
      var prevOverflow = document.documentElement.style.overflow;
      document.documentElement.style.overflow = "hidden";

      var form = root.querySelector("form");
      var company = form.elements.namedItem("company");
      var name = form.elements.namedItem("name");
      var role = form.elements.namedItem("role");
      var btn = form.querySelector("button");
      var err = form.querySelector(".vg-err");

      company.value = ls(K.company) || "";
      name.value = ls(K.name) || "";
      role.value = ls(K.role) || "";
      var sync = function () {
        btn.disabled = clean(company.value).length < 2;
        err.textContent = "";
      };
      company.addEventListener("input", sync);
      sync();
      setTimeout(function () {
        try {
          company.focus({ preventScroll: true });
        } catch (e) {}
      }, 60);

      // Перехватываем клавиши, чтобы горячие клавиши приложения не срабатывали под гейтом.
      root.addEventListener("keydown", function (e) {
        e.stopPropagation();
      });

      form.addEventListener("submit", function (e) {
        e.preventDefault();
        e.stopPropagation();
        var c = clean(company.value);
        if (c.length < 2) {
          err.textContent = "Company name is required.";
          company.focus();
          return;
        }
        identity = { vid: newVid(), company: c, name: clean(name.value), role: clean(role.value) };
        ls(K.company, c);
        ls(K.name, identity.name || null);
        ls(K.role, identity.role || null);
        ss(K.vid, identity.vid);
        ss(K.start, String(Date.now()));
        ss(K.land, hrefNoHash());

        document.documentElement.style.overflow = prevOverflow;
        root.style.transition = "opacity .25s ease";
        root.style.opacity = "0";
        setTimeout(function () {
          root.remove();
          style.remove();
        }, 260);
        startTracking(true);
      });
    };

    if (document.body) mount();
    else document.addEventListener("DOMContentLoaded", mount);
  }

  // Уже прошёл гейт в этой вкладке — просто продолжаем трекать.
  var existing = ss(K.vid);
  var savedCompany = ls(K.company);
  if (existing && savedCompany) {
    identity = { vid: existing, company: savedCompany, name: ls(K.name) || "", role: ls(K.role) || "" };
    startTracking(false);
  } else {
    showGate();
  }
})();
