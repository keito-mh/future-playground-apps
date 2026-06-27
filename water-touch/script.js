/*
 * みずなぞり — 触って気持ちいい水面体験
 *
 * 軽量な疑似シミュレーション：
 *  - 高さ場（height field）による波の伝播でリアルな波紋・戻り
 *  - 低解像度グリッドをImageDataで描き、滑らかに拡大して水面に
 *  - なぞった速度で反応が変化（ゆっくり＝ぬるっと / 速い＝白い筋としぶき）
 *  - 波紋リング・水しぶき・光の粒・葉っぱのオーバーレイ
 *
 * 物理的な正確さよりも「触感」を優先しています。
 */
(function () {
  "use strict";

  var canvas = document.getElementById("water");
  var ctx = canvas.getContext("2d", { alpha: false });
  var intro = document.getElementById("intro");

  // ---- 画面サイズ / デバイスピクセル比 ----
  var W = 0,
    H = 0,
    DPR = 1;

  // ---- 高さ場グリッド ----
  var cols = 0,
    rows = 0,
    cur = null, // 現在の高さ
    prev = null; // 1フレーム前の高さ
  var grid = document.createElement("canvas"); // 低解像度の描画先
  var gctx = grid.getContext("2d");
  var gimg = null; // ImageData

  // ---- オーバーレイのパーティクル ----
  var rings = []; // タップの波紋リング
  var splashes = []; // 水しぶきのしずく
  var streaks = []; // 速いなぞりの白い筋
  var grains = []; // 光の粒
  var leaves = []; // 葉っぱ

  // ---- モード定義 ----
  // K        : 波のコントラスト（明暗の強さ）
  // damping  : 波の減衰（小さいほど早く静まる）— 約1〜2秒で戻る
  // spread   : 波の伝わる速さ（小さいほど重い）
  // amb      : アイドル時のゆらぎ（コースティクス）
  // flow     : 一定方向の流れ {x, y}（px/フレーム相当）
  // top/bot  : 上端/下端の基本色 [r,g,b]
  // hi       : ハイライト色 [r,g,b]
  // grains   : 光の粒の数 / leaves: 葉っぱの数
  var MODES = {
    clear: {
      K: 0.26,
      damping: 0.955,
      spread: 0.5,
      amb: 0.05,
      flow: { x: 0, y: 0 },
      top: [86, 196, 232],
      bot: [12, 58, 96],
      hi: [220, 248, 255],
      spec: 0.55,
      grains: 16,
      leaves: 4,
    },
    flow: {
      K: 0.24,
      damping: 0.965,
      spread: 0.5,
      amb: 0.07,
      flow: { x: 0.18, y: 0.06 },
      top: [96, 214, 196],
      bot: [14, 74, 78],
      hi: [224, 255, 246],
      spec: 0.5,
      grains: 22,
      leaves: 6,
    },
    jelly: {
      K: 0.3,
      damping: 0.984, // 長めに揺れて、ぷるっと戻る
      spread: 0.46, // 重め
      amb: 0.04,
      flow: { x: 0, y: 0 },
      top: [150, 150, 240],
      bot: [54, 40, 110],
      hi: [240, 232, 255],
      spec: 0.7,
      grains: 12,
      leaves: 3,
    },
    sparkle: {
      K: 0.27,
      damping: 0.95,
      spread: 0.5,
      amb: 0.06,
      flow: { x: 0.04, y: -0.05 },
      top: [224, 158, 214],
      bot: [70, 40, 96],
      hi: [255, 246, 224],
      spec: 0.85,
      grains: 64,
      leaves: 3,
    },
  };
  var mode = MODES.clear;
  var modeName = "clear";

  // ===================================================================
  // リサイズ / グリッド初期化
  // ===================================================================
  function resize() {
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth;
    H = window.innerHeight;
    canvas.width = Math.round(W * DPR);
    canvas.height = Math.round(H * DPR);
    canvas.style.width = W + "px";
    canvas.style.height = H + "px";
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.imageSmoothingEnabled = true;

    // グリッド解像度：1セル ≒ 10px、軽さ重視で上限を設定
    var cell = 10;
    cols = Math.max(24, Math.min(64, Math.round(W / cell)));
    rows = Math.max(36, Math.round(cols * (H / W)));
    grid.width = cols;
    grid.height = rows;
    gimg = gctx.createImageData(cols, rows);
    cur = new Float32Array(cols * rows);
    prev = new Float32Array(cols * rows);

    seedParticles();
  }

  // ===================================================================
  // パーティクル生成
  // ===================================================================
  function rand(a, b) {
    return a + Math.random() * (b - a);
  }

  function seedParticles() {
    grains.length = 0;
    leaves.length = 0;
    for (var i = 0; i < mode.grains; i++) grains.push(makeGrain());
    for (var j = 0; j < mode.leaves; j++) leaves.push(makeLeaf());
  }

  function makeGrain() {
    return {
      x: rand(0, W),
      y: rand(0, H),
      r: rand(0.8, 2.2),
      vx: rand(-0.05, 0.05),
      vy: rand(-0.05, 0.05),
      ph: rand(0, Math.PI * 2),
      sp: rand(0.001, 0.004),
    };
  }

  function makeLeaf() {
    return {
      x: rand(0, W),
      y: rand(0, H),
      vx: 0,
      vy: 0,
      r: rand(7, 12),
      rot: rand(0, Math.PI * 2),
      vr: rand(-0.004, 0.004),
      hue: rand(95, 135),
    };
  }

  // ===================================================================
  // 水面をなぞる / たたく
  // ===================================================================
  // 高さ場へへこみを与える。amp が大きいほど大きな波。
  function disturb(px, py, amp, rad) {
    var gx = (px / W) * cols;
    var gy = (py / H) * rows;
    var r = Math.max(1, rad);
    var x0 = Math.max(1, Math.floor(gx - r));
    var x1 = Math.min(cols - 2, Math.ceil(gx + r));
    var y0 = Math.max(1, Math.floor(gy - r));
    var y1 = Math.min(rows - 2, Math.ceil(gy + r));
    for (var y = y0; y <= y1; y++) {
      for (var x = x0; x <= x1; x++) {
        var dx = x - gx;
        var dy = y - gy;
        var d = Math.sqrt(dx * dx + dy * dy);
        if (d > r) continue;
        var f = 1 - d / r;
        cur[y * cols + x] -= amp * f * f;
      }
    }
  }

  // 波の伝播（古典的なリップル法）
  function stepWater() {
    var sp = mode.spread;
    var damp = mode.damping;
    for (var y = 1; y < rows - 1; y++) {
      var row = y * cols;
      for (var x = 1; x < cols - 1; x++) {
        var i = row + x;
        var val =
          (cur[i - 1] + cur[i + 1] + cur[i - cols] + cur[i + cols]) * sp -
          prev[i];
        prev[i] = val * damp;
      }
    }
    var t = cur;
    cur = prev;
    prev = t;
  }

  // ===================================================================
  // 水面の描画（低解像度 → 滑らかに拡大）
  // ===================================================================
  function renderWater(now) {
    var data = gimg.data;
    var topR = mode.top[0],
      topG = mode.top[1],
      topB = mode.top[2];
    var botR = mode.bot[0],
      botG = mode.bot[1],
      botB = mode.bot[2];
    var hiR = mode.hi[0],
      hiG = mode.hi[1],
      hiB = mode.hi[2];
    var K = mode.K;
    var amb = mode.amb;
    var spec = mode.spec;
    var fx = mode.flow.x;
    var fy = mode.flow.y;

    for (var y = 0; y < rows; y++) {
      var vy = y / (rows - 1);
      // 縦グラデーション（上が明るく、下が深い）
      var bR = botR + (topR - botR) * vy;
      var bG = botG + (topG - botG) * vy;
      var bB = botB + (topB - botB) * vy;
      var yu = y > 0 ? -cols : 0;
      var yd = y < rows - 1 ? cols : 0;
      for (var x = 0; x < cols; x++) {
        var i = y * cols + x;
        var xl = x > 0 ? -1 : 0;
        var xr = x < cols - 1 ? 1 : 0;
        // 高さの傾き＝疑似的な法線 → 光の当たり方
        var nx = cur[i + xl] - cur[i + xr];
        var ny = cur[i + yu] - cur[i + yd];
        var shade = (nx * 0.7 + ny) * K;
        // アイドル時のやわらかなゆらぎ（流れる方向にスクロール）
        shade +=
          Math.sin(x * 0.4 + now * 0.0014 + fx * now * 0.02) *
          Math.cos(y * 0.35 - now * 0.0011 + fy * now * 0.02) *
          amb;
        if (shade > 1) shade = 1;
        else if (shade < -1) shade = -1;

        var light = shade > 0 ? shade : 0;
        var dark = shade < 0 ? -shade : 0;
        var s3 = light * light * light; // ハイライトの芯

        var p = i * 4;
        var r = bR + hiR * light * 0.5 + 255 * s3 * spec - bR * dark * 0.45;
        var g = bG + hiG * light * 0.5 + 255 * s3 * spec - bG * dark * 0.45;
        var b = bB + hiB * light * 0.5 + 255 * s3 * spec - bB * dark * 0.45;
        data[p] = r > 255 ? 255 : r < 0 ? 0 : r;
        data[p + 1] = g > 255 ? 255 : g < 0 ? 0 : g;
        data[p + 2] = b > 255 ? 255 : b < 0 ? 0 : b;
        data[p + 3] = 255;
      }
    }
    gctx.putImageData(gimg, 0, 0);
    ctx.drawImage(grid, 0, 0, cols, rows, 0, 0, W, H);
  }

  // 高さ場の傾きをワールド座標でサンプル（葉・粒を波で動かす）
  function sampleSlope(px, py, out) {
    var gx = Math.max(1, Math.min(cols - 2, (px / W) * cols)) | 0;
    var gy = Math.max(1, Math.min(rows - 2, (py / H) * rows)) | 0;
    var i = gy * cols + gx;
    out.x = cur[i - 1] - cur[i + 1];
    out.y = cur[i - cols] - cur[i + cols];
  }

  // ===================================================================
  // オーバーレイの更新と描画
  // ===================================================================
  var slope = { x: 0, y: 0 };

  function updateAndDrawOverlay(dt) {
    var fx = mode.flow.x;
    var fy = mode.flow.y;

    // --- 波紋リング ---
    ctx.lineCap = "round";
    for (var i = rings.length - 1; i >= 0; i--) {
      var rg = rings[i];
      rg.life -= dt;
      if (rg.life <= 0) {
        rings.splice(i, 1);
        continue;
      }
      var pr = 1 - rg.life / rg.max;
      var radius = rg.r0 + (rg.r1 - rg.r0) * pr;
      var a = (1 - pr) * 0.5;
      ctx.beginPath();
      ctx.strokeStyle = "rgba(235,250,255," + a + ")";
      ctx.lineWidth = 2 * (1 - pr) + 0.5;
      ctx.arc(rg.x, rg.y, radius, 0, Math.PI * 2);
      ctx.stroke();
    }

    // --- 白い筋（速いなぞり） ---
    ctx.globalCompositeOperation = "lighter";
    for (var s = streaks.length - 1; s >= 0; s--) {
      var st = streaks[s];
      st.life -= dt;
      if (st.life <= 0) {
        streaks.splice(s, 1);
        continue;
      }
      var sa = (st.life / st.max) * 0.5;
      ctx.beginPath();
      ctx.strokeStyle = "rgba(255,255,255," + sa + ")";
      ctx.lineWidth = st.w * (st.life / st.max);
      ctx.moveTo(st.x1, st.y1);
      ctx.lineTo(st.x2, st.y2);
      ctx.stroke();
    }

    // --- 水しぶき ---
    for (var d = splashes.length - 1; d >= 0; d--) {
      var dp = splashes[d];
      dp.life -= dt;
      if (dp.life <= 0) {
        splashes.splice(d, 1);
        continue;
      }
      dp.vy += 0.0009 * dt; // ゆるい重力
      dp.x += dp.vx * dt;
      dp.y += dp.vy * dt;
      var da = (dp.life / dp.max) * 0.85;
      ctx.beginPath();
      ctx.fillStyle = "rgba(245,253,255," + da + ")";
      ctx.arc(dp.x, dp.y, dp.r, 0, Math.PI * 2);
      ctx.fill();
    }

    // --- 光の粒 ---
    for (var g = 0; g < grains.length; g++) {
      var gr = grains[g];
      sampleSlope(gr.x, gr.y, slope);
      gr.vx += slope.x * 0.02 + fx * 0.01;
      gr.vy += slope.y * 0.02 + fy * 0.01;
      gr.vx *= 0.94;
      gr.vy *= 0.94;
      gr.x += gr.vx * dt * 0.06 + fx;
      gr.y += gr.vy * dt * 0.06 + fy;
      wrap(gr);
      gr.ph += gr.sp * dt;
      var tw = 0.4 + 0.6 * (0.5 + 0.5 * Math.sin(gr.ph));
      ctx.beginPath();
      ctx.fillStyle = "rgba(255,252,235," + tw * 0.8 + ")";
      ctx.arc(gr.x, gr.y, gr.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalCompositeOperation = "source-over";

    // --- 葉っぱ ---
    for (var l = 0; l < leaves.length; l++) {
      var lf = leaves[l];
      sampleSlope(lf.x, lf.y, slope);
      lf.vx += slope.x * 0.03 + fx * 0.02;
      lf.vy += slope.y * 0.03 + fy * 0.02;
      lf.vx *= 0.92;
      lf.vy *= 0.92;
      lf.x += lf.vx * dt * 0.06 + fx * 0.6;
      lf.y += lf.vy * dt * 0.06 + fy * 0.6;
      lf.rot += lf.vr * dt + (slope.x + slope.y) * 0.004;
      wrap(lf);
      drawLeaf(lf);
    }
  }

  function wrap(p) {
    var m = 20;
    if (p.x < -m) p.x = W + m;
    else if (p.x > W + m) p.x = -m;
    if (p.y < -m) p.y = H + m;
    else if (p.y > H + m) p.y = -m;
  }

  function drawLeaf(lf) {
    ctx.save();
    ctx.translate(lf.x, lf.y);
    ctx.rotate(lf.rot);
    ctx.beginPath();
    ctx.ellipse(0, 0, lf.r, lf.r * 0.5, 0, 0, Math.PI * 2);
    ctx.fillStyle = "hsla(" + lf.hue + ",55%,55%,0.55)";
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(-lf.r, 0);
    ctx.lineTo(lf.r, 0);
    ctx.strokeStyle = "hsla(" + lf.hue + ",60%,35%,0.5)";
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();
  }

  // ===================================================================
  // 入力（ポインタ）
  // ===================================================================
  var pointers = {}; // id -> {x, y, t}
  var introGone = false;

  function dismissIntro() {
    if (introGone) return;
    introGone = true;
    intro.classList.add("hide");
  }

  function pos(e) {
    return { x: e.clientX, y: e.clientY };
  }

  function onDown(e) {
    dismissIntro();
    var p = pos(e);
    pointers[e.pointerId] = { x: p.x, y: p.y, t: performance.now() };
    // タップ：小さな波紋
    disturb(p.x, p.y, 7, 2.2);
    rings.push({
      x: p.x,
      y: p.y,
      r0: 4,
      r1: 60,
      life: 700,
      max: 700,
    });
  }

  function onMove(e) {
    var pr = pointers[e.pointerId];
    if (!pr) return;
    // 1イベントで複数の合成ポイントが取れる端末では滑らかに
    var pts = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    for (var k = 0; k < pts.length; k++) {
      var p = pos(pts[k]);
      var now = performance.now();
      var dx = p.x - pr.x;
      var dy = p.y - pr.y;
      var dist = Math.sqrt(dx * dx + dy * dy);
      var dt = Math.max(1, now - pr.t);
      var speed = dist / dt; // px/ms

      if (dist > 0.5) {
        // 速いほど強い波・細い軌跡、ゆっくりは広くやわらかく分かれる
        var fast = Math.min(1, speed / 1.6);
        var amp = 5 + fast * 9;
        var rad = 3.2 - fast * 1.4;
        // 軌跡に沿って補間しながら水面をひらく
        var steps = Math.max(1, Math.ceil(dist / 8));
        for (var s = 1; s <= steps; s++) {
          var t = s / steps;
          disturb(pr.x + dx * t, pr.y + dy * t, amp, rad);
        }

        if (fast > 0.45) {
          // 速い：白い筋
          streaks.push({
            x1: pr.x,
            y1: pr.y,
            x2: p.x,
            y2: p.y,
            w: 1 + fast * 3,
            life: 220,
            max: 220,
          });
          // 速い：水しぶき
          var n = Math.round(fast * 3);
          var nxp = -dy / (dist || 1);
          var nyp = dx / (dist || 1);
          for (var d = 0; d < n; d++) {
            var side = Math.random() < 0.5 ? 1 : -1;
            var burst = rand(0.05, 0.18) * fast;
            splashes.push({
              x: p.x,
              y: p.y,
              vx: nxp * side * burst + dx / dt * 0.15,
              vy: nyp * side * burst + dy / dt * 0.15 - rand(0.05, 0.15),
              r: rand(1.2, 3),
              life: rand(280, 500),
              max: 500,
            });
          }
        }
      }
      pr.x = p.x;
      pr.y = p.y;
      pr.t = now;
    }
  }

  function onUp(e) {
    delete pointers[e.pointerId];
  }

  canvas.addEventListener("pointerdown", onDown, { passive: true });
  canvas.addEventListener("pointermove", onMove, { passive: true });
  canvas.addEventListener("pointerup", onUp, { passive: true });
  canvas.addEventListener("pointercancel", onUp, { passive: true });
  canvas.addEventListener("pointerleave", onUp, { passive: true });

  // ===================================================================
  // UI：モード切替 / リセット
  // ===================================================================
  var modeBtns = document.querySelectorAll(".mode");
  modeBtns.forEach(function (btn) {
    btn.addEventListener("click", function () {
      var name = btn.getAttribute("data-mode");
      if (!MODES[name]) return;
      modeName = name;
      mode = MODES[name];
      modeBtns.forEach(function (b) {
        b.classList.toggle("is-active", b === btn);
      });
      seedParticles();
    });
  });

  document.getElementById("reset").addEventListener("click", function () {
    // 水面をやさしくしずめる
    cur.fill(0);
    prev.fill(0);
    rings.length = 0;
    splashes.length = 0;
    streaks.length = 0;
    seedParticles();
  });

  // ===================================================================
  // メインループ
  // ===================================================================
  var last = performance.now();
  function loop(now) {
    var dt = Math.min(40, now - last); // 大きすぎるステップを抑制
    last = now;
    stepWater();
    renderWater(now);
    updateAndDrawOverlay(dt);
    requestAnimationFrame(loop);
  }

  // ===================================================================
  // 起動
  // ===================================================================
  var resizeTimer = null;
  window.addEventListener("resize", function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(resize, 150);
  });

  resize();
  requestAnimationFrame(loop);
})();
