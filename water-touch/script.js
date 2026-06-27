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

  // ---- カラー場（触れた場所からにじむ色）----
  var chue = null; // 各セルの色相 (0..359)
  var cstr = null; // 各セルの色の強さ (0..)
  var COLOR_DECAY = 0.975; // 毎フレームの色の減衰（約1.5〜2秒で水色に戻る）

  // 色相→RGB のルックアップテーブル（毎フレームの三角関数計算を避けて軽量化）
  var HUE_LUT = new Float32Array(360 * 3);
  (function buildHueLUT() {
    for (var h = 0; h < 360; h++) {
      // HSL(h, 48%, 62%) 相当のやわらかいパステル
      var s = 0.48,
        l = 0.62;
      var c = (1 - Math.abs(2 * l - 1)) * s;
      var hp = h / 60;
      var xx = c * (1 - Math.abs((hp % 2) - 1));
      var r1 = 0,
        g1 = 0,
        b1 = 0;
      if (hp < 1) {
        r1 = c;
        g1 = xx;
      } else if (hp < 2) {
        r1 = xx;
        g1 = c;
      } else if (hp < 3) {
        g1 = c;
        b1 = xx;
      } else if (hp < 4) {
        g1 = xx;
        b1 = c;
      } else if (hp < 5) {
        r1 = xx;
        b1 = c;
      } else {
        r1 = c;
        b1 = xx;
      }
      var m = l - c / 2;
      HUE_LUT[h * 3] = (r1 + m) * 255;
      HUE_LUT[h * 3 + 1] = (g1 + m) * 255;
      HUE_LUT[h * 3 + 2] = (b1 + m) * 255;
    }
  })();

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
      K: 0.12,
      damping: 0.955,
      spread: 0.5,
      amb: 0.035,
      flow: { x: 0, y: 0 },
      top: [96, 188, 222],
      bot: [26, 78, 118],
      hi: [206, 234, 246],
      spec: 0.18,
      grains: 14,
      leaves: 4,
    },
    flow: {
      K: 0.11,
      damping: 0.965,
      spread: 0.5,
      amb: 0.045,
      flow: { x: 0.18, y: 0.06 },
      top: [108, 204, 192],
      bot: [28, 92, 96],
      hi: [212, 240, 232],
      spec: 0.16,
      grains: 18,
      leaves: 6,
    },
    jelly: {
      K: 0.14,
      damping: 0.984, // 長めに揺れて、ぷるっと戻る
      spread: 0.46, // 重め
      amb: 0.03,
      flow: { x: 0, y: 0 },
      top: [156, 158, 232],
      bot: [66, 56, 122],
      hi: [226, 222, 244],
      spec: 0.24,
      grains: 12,
      leaves: 3,
    },
    sparkle: {
      K: 0.13,
      damping: 0.95,
      spread: 0.5,
      amb: 0.045,
      flow: { x: 0.04, y: -0.05 },
      top: [220, 168, 208],
      bot: [84, 56, 108],
      hi: [240, 230, 220],
      spec: 0.34,
      grains: 40,
      leaves: 3,
    },
  };
  var mode = MODES.clear;
  var modeName = "clear";

  // 1フレームあたりの物理サブステップ数。
  // 格子を細かくすると波が遅く見えるため、複数ステップで伝播速度（触感）を保つ。
  var SUBSTEPS = 2;

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

    // グリッド解像度：1セル ≒ 5px で細かく（高解像度）。
    // ただし総セル数に上限を設け、古い端末でも軽く保つ。
    var cell = 5;
    cols = Math.max(48, Math.min(160, Math.round(W / cell)));
    rows = Math.max(80, Math.round(cols * (H / W)));
    var maxCells = 22000;
    if (cols * rows > maxCells) {
      var sc = Math.sqrt(maxCells / (cols * rows));
      cols = Math.round(cols * sc);
      rows = Math.round(rows * sc);
    }
    grid.width = cols;
    grid.height = rows;
    gimg = gctx.createImageData(cols, rows);
    cur = new Float32Array(cols * rows);
    prev = new Float32Array(cols * rows);
    chue = new Float32Array(cols * rows);
    cstr = new Float32Array(cols * rows);

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
  // radPx は画面ピクセル単位の筆の半径（解像度が変わってもブラシの大きさは一定）。
  function disturb(px, py, amp, radPx) {
    var gx = (px / W) * cols;
    var gy = (py / H) * rows;
    var r = Math.max(1, (radPx / W) * cols);
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

  // 触れた場所に色を注入する。fade（減衰）で約1〜2秒かけて水色に戻る。
  function inkBrush(px, py, strength, radPx, hue) {
    var gx = (px / W) * cols;
    var gy = (py / H) * rows;
    var r = Math.max(1, (radPx / W) * cols);
    var x0 = Math.max(0, Math.floor(gx - r));
    var x1 = Math.min(cols - 1, Math.ceil(gx + r));
    var y0 = Math.max(0, Math.floor(gy - r));
    var y1 = Math.min(rows - 1, Math.ceil(gy + r));
    for (var y = y0; y <= y1; y++) {
      for (var x = x0; x <= x1; x++) {
        var dx = x - gx;
        var dy = y - gy;
        var d = Math.sqrt(dx * dx + dy * dy);
        if (d > r) continue;
        var f = 1 - d / r;
        var i = y * cols + x;
        var ns = cstr[i] + strength * f * f;
        cstr[i] = ns > 1.3 ? 1.3 : ns; // 上限で色飽和を抑える
        chue[i] = hue; // 直近に触れた色を採用
      }
    }
  }

  // 波の伝播（古典的なリップル法）
  function stepWater() {
    var sp = mode.spread;
    // サブステップで回す分、1ステップあたりの減衰を弱めて
    // フレーム全体での「約1〜2秒で戻る」感を保つ。
    var damp = Math.pow(mode.damping, 1 / SUBSTEPS);
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
    // 陰影の強さは解像度に追従させる（格子を細かくしても隣との
    // 高さ差が小さくなる分を補う）。ギラつき防止に控えめなスケール。
    var K = mode.K * Math.min(1.3, cols / 60);
    var amb = mode.amb;
    var spec = mode.spec;
    var fx = mode.flow.x;
    var fy = mode.flow.y;
    // コースティクスの空間周波数（画面上の見た目が解像度で変わらないよう正規化）
    var nxf = 16 / cols;
    var nyf = 28 / rows;

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

        // 触れた場所の色を基本色に混ぜる（強さに応じてにじむ）。
        // ここで減衰も行い、約1〜2秒で元の水色へ戻す。
        var cR = bR,
          cG = bG,
          cB = bB;
        var cs = cstr[i];
        if (cs > 0.004) {
          var li = (chue[i] | 0) * 3;
          var t = (cs > 1 ? 1 : cs) * 0.45;
          cR = bR + (HUE_LUT[li] - bR) * t;
          cG = bG + (HUE_LUT[li + 1] - bG) * t;
          cB = bB + (HUE_LUT[li + 2] - bB) * t;
          cstr[i] = cs * COLOR_DECAY;
        } else if (cs !== 0) {
          cstr[i] = 0;
        }

        // 高さの傾き＝疑似的な法線 → 光の当たり方
        var nx = cur[i + xl] - cur[i + xr];
        var ny = cur[i + yu] - cur[i + yd];
        var shade = (nx * 0.7 + ny) * K;
        // アイドル時のやわらかなゆらぎ（解像度に依らない周波数でスクロール）
        shade +=
          Math.sin(nxf * x + now * 0.0014 + fx * now * 0.02) *
          Math.cos(nyf * y - now * 0.0011 + fy * now * 0.02) *
          amb;
        if (shade > 1) shade = 1;
        else if (shade < -1) shade = -1;

        var light = shade > 0 ? shade : 0;
        var dark = shade < 0 ? -shade : 0;
        var l2 = light * light;
        var s3 = l2 * light; // ハイライトの芯（やわらかく広がる艶）

        var p = i * 4;
        var r = cR + hiR * light * 0.28 + 255 * s3 * spec - cR * dark * 0.4;
        var g = cG + hiG * light * 0.28 + 255 * s3 * spec - cG * dark * 0.4;
        var b = cB + hiB * light * 0.28 + 255 * s3 * spec - cB * dark * 0.4;
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
      var a = (1 - pr) * 0.28;
      ctx.beginPath();
      ctx.strokeStyle = "rgba(235,250,255," + a + ")";
      ctx.lineWidth = 1.5 * (1 - pr) + 0.5;
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
      var sa = (st.life / st.max) * 0.22;
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
      var da = (dp.life / dp.max) * 0.5;
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
      ctx.fillStyle = "rgba(255,252,235," + tw * 0.5 + ")";
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

  // 触れた位置で色相が変わる（場所ごとに違う色／斜めになぞると虹色の軌跡）。
  // 時間の項も少し混ぜて、同じ場所でもタップごとに表情が変わるように。
  function hueAt(px, py, t) {
    return (px * 0.55 + py * 0.32 + t * 0.05) % 360;
  }

  function onDown(e) {
    dismissIntro();
    var p = pos(e);
    var now = performance.now();
    pointers[e.pointerId] = { x: p.x, y: p.y, t: now };
    // タップ：小さな波紋＋触れた場所からにじむ色
    disturb(p.x, p.y, 3, 24);
    inkBrush(p.x, p.y, 0.8, 34, hueAt(p.x, p.y, now));
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
        var amp = 1.6 + fast * 3;
        var radPx = 32 - fast * 16; // ゆっくり=広く、速い=細く
        // 軌跡に沿って補間しながら水面をひらき、色も流し込む
        var steps = Math.max(1, Math.ceil(dist / 6));
        for (var s = 1; s <= steps; s++) {
          var t = s / steps;
          var sx = pr.x + dx * t;
          var sy = pr.y + dy * t;
          disturb(sx, sy, amp, radPx);
          inkBrush(sx, sy, 0.34, radPx + 6, hueAt(sx, sy, now));
        }

        if (fast > 0.6) {
          // 速い：やわらかな白い筋
          streaks.push({
            x1: pr.x,
            y1: pr.y,
            x2: p.x,
            y2: p.y,
            w: 1 + fast * 1.5,
            life: 220,
            max: 220,
          });
          // 速い：水しぶき
          var n = Math.round(fast * 2);
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
    cstr.fill(0);
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
    for (var s = 0; s < SUBSTEPS; s++) stepWater();
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
