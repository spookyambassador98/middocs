// Builds a single, self-contained HTML file that replays a document's
// writing history — a "timelapse you can hand someone," with zero
// dependencies (no Quill, no CDN scripts, nothing fetched over the
// network) so it keeps working as a plain double-clickable file forever,
// completely independent of this app. That portability is the whole
// point: it's genuinely shareable in a way an in-app "version history"
// screen never is.
export interface TimelapseFrame {
  /** Milliseconds since the first recorded operation. */
  t: number;
  html: string;
}

function escapeForScriptTag(json: string): string {
  // Prevents a literal "</script>" inside embedded content from
  // prematurely closing our <script> tag when this file is parsed as HTML.
  return json.replace(/<\/script/gi, "<\\/script");
}

export function buildTimelapseExportHtml(title: string, frames: TimelapseFrame[]): string {
  const safeTitle = title.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c]!);
  const framesJson = escapeForScriptTag(JSON.stringify(frames));

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Timelapse — ${safeTitle}</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; background: #f4f2fb; color: #201a35;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    display: flex; flex-direction: column; align-items: center; padding: 24px 16px 80px;
  }
  .tl-header { max-width: 720px; width: 100%; margin-bottom: 16px; }
  .tl-header h1 { font-size: 1.3rem; margin: 0 0 4px; }
  .tl-header p { margin: 0; color: #6b6483; font-size: 0.85rem; }
  .tl-stage {
    width: 100%; max-width: 720px; min-height: 320px; background: #fff;
    border: 1px solid #e6e2f5; border-radius: 14px; box-shadow: 0 8px 24px rgba(45,34,92,0.10);
    padding: 40px 48px; font-family: Georgia, "Source Serif 4", serif; font-size: 1.05rem; line-height: 1.7;
  }
  .tl-stage p { margin: 0 0 1em; }
  .tl-stage h1, .tl-stage h2, .tl-stage h3 { margin: 0.6em 0 0.4em; }
  .tl-stage blockquote { margin: 0 0 1em; padding-left: 14px; border-left: 3px solid #6c4fe0; color: #6b6483; }
  .tl-stage pre { background: #f4f2fb; padding: 12px 14px; border-radius: 8px; overflow-x: auto; }
  .tl-stage ul.tl-list { padding-left: 22px; }
  .tl-stage hr { border: none; border-top: 1px solid #e6e2f5; margin: 1.2em 0; }
  .tl-controls {
    width: 100%; max-width: 720px; margin-top: 18px; background: #fff; border: 1px solid #e6e2f5;
    border-radius: 14px; padding: 14px 18px; display: flex; align-items: center; gap: 12px;
  }
  .tl-controls button {
    border: none; background: #6c4fe0; color: #fff; width: 38px; height: 38px; border-radius: 999px;
    font-size: 1rem; cursor: pointer; flex-shrink: 0;
  }
  .tl-controls input[type=range] { flex: 1; accent-color: #6c4fe0; }
  .tl-controls select { border: 1px solid #e6e2f5; border-radius: 8px; padding: 6px 8px; background: #fff; }
  .tl-time { font-size: 0.78rem; color: #6b6483; min-width: 70px; text-align: right; }
  @media (prefers-color-scheme: dark) {
    body { background: #171225; color: #f1eefb; }
    .tl-header p { color: #b3aad0; }
    .tl-stage, .tl-controls { background: #221c38; border-color: #362d52; box-shadow: none; }
    .tl-stage pre { background: #171225; }
    .tl-stage hr, .tl-controls input[type=range] { border-color: #362d52; }
    .tl-controls select { background: #221c38; border-color: #362d52; color: #f1eefb; }
    .tl-time { color: #b3aad0; }
  }
</style>
</head>
<body>
  <div class="tl-header">
    <h1>🎬 ${safeTitle}</h1>
    <p>Writing timelapse — exported from middocs. Opens in any browser, offline, without the app.</p>
  </div>
  <div class="tl-stage" id="stage"></div>
  <div class="tl-controls">
    <button id="playBtn" title="Play/pause">▶</button>
    <input type="range" id="scrubber" min="0" value="0" step="1">
    <select id="speed">
      <option value="0.5">0.5×</option>
      <option value="1" selected>1×</option>
      <option value="2">2×</option>
      <option value="4">4×</option>
      <option value="8">8×</option>
    </select>
    <span class="tl-time" id="timeLabel">0:00</span>
  </div>
  <script>
    var FRAMES = ${framesJson};
  </script>
  <script>
  (function () {
    var stage = document.getElementById("stage");
    var scrubber = document.getElementById("scrubber");
    var playBtn = document.getElementById("playBtn");
    var speedSel = document.getElementById("speed");
    var timeLabel = document.getElementById("timeLabel");
    var n = FRAMES.length;
    scrubber.max = String(Math.max(0, n - 1));
    var playing = false;
    var timer = null;

    function formatTime(ms) {
      var s = Math.round(ms / 1000);
      var m = Math.floor(s / 60);
      var r = s % 60;
      return m + ":" + (r < 10 ? "0" : "") + r;
    }

    function render(i) {
      if (n === 0) { stage.innerHTML = "<p><em>This document has no timelapse history yet.</em></p>"; return; }
      i = Math.max(0, Math.min(n - 1, i));
      scrubber.value = String(i);
      stage.innerHTML = FRAMES[i].html;
      timeLabel.textContent = formatTime(FRAMES[i].t);
    }

    function stop() {
      playing = false;
      playBtn.textContent = "▶";
      if (timer) { clearInterval(timer); timer = null; }
    }

    function play() {
      if (n < 2) return;
      playing = true;
      playBtn.textContent = "⏸";
      var speed = parseFloat(speedSel.value) || 1;
      timer = setInterval(function () {
        var i = parseInt(scrubber.value, 10) + 1;
        if (i >= n) { stop(); return; }
        render(i);
      }, 220 / speed);
    }

    playBtn.addEventListener("click", function () { playing ? stop() : play(); });
    scrubber.addEventListener("input", function () { stop(); render(parseInt(scrubber.value, 10)); });
    speedSel.addEventListener("change", function () { if (playing) { stop(); play(); } });

    render(0);
  })();
  </script>
</body>
</html>
`;
}
