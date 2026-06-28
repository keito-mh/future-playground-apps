/*
 * ひかりなぞり — カメラ映像や写真の「空間」を、指でゆらす体験（軽量版）
 *
 * 設計の方針（とにかく軽く）:
 *  - エフェクトの主役は「背景そのものの歪み（warp）」。
 *    円形にクリップして背景を拡大／ずらして描き直すだけ＝GPU の drawImage で安い。
 *    現実の景色が水面のようにぷくっと膨らみ、なぞると流れ、タップで波紋が広がる。
 *  - 光は毎フレーム createRadialGradient…ではなく、最初に一度だけ作った
 *    「光スプライト」を drawImage で置くだけ（per-frame の重い処理を排除）。
 *  - 残光バッファ（全画面の読み書き）も廃止。各エフェクトは life で自然に消える。
 *  - 写真モードで何も触っていない時は描画自体をスキップ（電池にやさしい）。
 *  - DPR は 1.5 までに制限。warp 数・粒数にも上限。
 *
 * 画像処理はすべてブラウザ内で完結。外部送信なし。
 */
(function () {
  "use strict";
  var TAU = Math.PI * 2;

  // ---- 要素 ----
  var stage = document.getElementById("stage");
  var ctx = stage.getContext("2d", { alpha: false });
  var video = document.getElementById("cam");
  var fileInput = document.getElementById("file");
  var intro = document.getElementById("intro");
  var gate = document.getElementById("gate");
  var gateNote = document.getElementById("gateNote");
  var toastEl = document.getElementById("toast");

  // ---- オフスクリーン背景（歪みの元になる、歪んでいない景色） ----
  var bg = document.createElement("canvas");
  var bgctx = bg.getContext("2d", { alpha: false });

  // ---- 歪みを合成するための作業レイヤー（使い回す） ----
  var layer = document.createElement("canvas");
  var lctx = layer.getContext("2d");

  // ---- スプライト（一度だけ生成して使い回す） ----
  var glow = makeGlowSprite(128);
  var ring = makeRingSprite(256);
  var mask = makeMaskSprite(256); // 歪みのフチをやわらかく溶かすアルファマスク

  var DIST_MAX = 0; // 歪みを描く最大半径（resize で決定。これ以上はフチの光のみ）

  // ---- 状態 ----
  var W = 0, H = 0, DPR = 1;
  var sourceMode = "camera"; // "camera" | "photo"
  var effectMode = "veil"; // "veil" | "flow" | "lens"
  var camStream = null, camReady = false;
  var photoImg = null;
  var introHidden = false;

  // ---- エフェクト ----
  var warps = []; // 背景の歪み
  var sparks = []; // 軽い光の粒（スプライトを置くだけ）
  var MAX_WARPS = 22;
  var MAX_SPARKS = 140;

  var pointers = {};
  var dragging = false;

  // ---- 動き検出（カメラの動いた所に光が集まる・軽量） ----
  var motionOn = true;
  var motionCanvas = document.createElement("canvas");
  var mctx = motionCanvas.getContext("2d", { willReadFrequently: true });
  var MW = 64, MH = 0;
  var prevLuma = null;
  var motionFrame = 0;
  var MOTION_TH = 20; // この明るさ変化以上を「動き」とみなす

  // ===================================================================
  // 音（Web Audio で合成。素材ファイルなし＝軽い。やさしい音色）
  //  - なぞる：風鈴のような小さな粒の音（ペンタトニックでいつでも調和）
  //  - タップ：水滴のポチャン
  //  - 長押し：ふわっと上がる持続音 → 離すと和音で開く
  // 端末の自動再生制限のため、最初のユーザー操作で初期化／再開する。
  // ===================================================================
  var Sound = (function () {
    var actx = null, master = null, send = null, on = true, lastBlip = 0, hold = null;
    var SCALE = [523.25, 587.33, 698.46, 783.99, 880.0, 1046.5]; // C D F G A C(高)

    function impulse(dur, decay) {
      var rate = actx.sampleRate, len = Math.floor(rate * dur);
      var buf = actx.createBuffer(2, len, rate);
      for (var ch = 0; ch < 2; ch++) {
        var d = buf.getChannelData(ch);
        for (var i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
      }
      return buf;
    }
    function init() {
      if (actx) return;
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      actx = new AC();
      master = actx.createGain();
      master.gain.value = on ? 0.0 : 0.0;
      master.connect(actx.destination);
      // やわらかい残響
      var conv = actx.createConvolver();
      conv.buffer = impulse(1.8, 2.4);
      var wet = actx.createGain();
      wet.gain.value = 0.45;
      conv.connect(wet); wet.connect(master);
      send = conv;
      // 起動時にふわっと立ち上げる
      master.gain.setValueAtTime(0.0001, actx.currentTime);
      master.gain.exponentialRampToValueAtTime(on ? 0.8 : 0.0001, actx.currentTime + 0.6);
    }
    function resume() { if (actx && actx.state === "suspended") actx.resume(); }

    // 1音（dry + reverb send）
    function note(freq, opt) {
      if (!actx || !on) return;
      opt = opt || {};
      var t = actx.currentTime;
      var dur = opt.dur || 0.5;
      var g = actx.createGain();
      var peak = opt.gain != null ? opt.gain : 0.12;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(peak, t + (opt.attack || 0.012));
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      var o = actx.createOscillator();
      o.type = opt.type || "sine";
      o.frequency.setValueAtTime(freq, t);
      if (opt.glide) o.frequency.exponentialRampToValueAtTime(Math.max(40, freq * opt.glide), t + dur);
      o.connect(g);
      g.connect(master);
      if (send && opt.wet !== 0) { var s = actx.createGain(); s.gain.value = opt.wet || 0.6; g.connect(s); s.connect(send); }
      o.start(t);
      o.stop(t + dur + 0.05);
    }

    return {
      enabled: function () { return on; },
      kick: function () { init(); resume(); }, // 最初のユーザー操作で
      toggle: function () {
        on = !on;
        if (actx) {
          var t = actx.currentTime;
          master.gain.cancelScheduledValues(t);
          master.gain.setValueAtTime(Math.max(master.gain.value, 0.0001), t);
          master.gain.exponentialRampToValueAtTime(on ? 0.8 : 0.0001, t + 0.25);
        }
        return on;
      },
      // なぞり：軽い粒（速さで少し明るく・量は抑えめ）
      blip: function (speed) {
        if (!actx || !on) return;
        var now = performance.now();
        if (now - lastBlip < 75) return;
        lastBlip = now;
        var f = SCALE[(Math.random() * SCALE.length) | 0] * (Math.random() < 0.5 ? 1 : 2);
        note(f, { type: "triangle", dur: 0.5, gain: 0.05 + Math.min(speed, 2) * 0.02, attack: 0.005, wet: 0.7 });
      },
      // タップ：水滴
      drop: function () {
        note(880, { type: "sine", dur: 0.45, gain: 0.16, glide: 0.45, attack: 0.004, wet: 0.8 });
        note(1320, { type: "sine", dur: 0.18, gain: 0.06, glide: 0.5, attack: 0.003, wet: 0.5 });
      },
      // 長押し：安定した和音がふわっと灯る（ピッチは動かさず＝不気味にならない）
      holdStart: function () {
        if (!actx || !on || hold) return;
        var t = actx.currentTime;
        var out = actx.createGain();
        out.gain.setValueAtTime(0.0001, t);
        out.gain.exponentialRampToValueAtTime(0.06, t + 0.5); // やわらかく立ち上げ
        // やわらかいローパス（溜まるほど少しだけ明るく）
        var lp = actx.createBiquadFilter();
        lp.type = "lowpass"; lp.Q.value = 0.5;
        lp.frequency.setValueAtTime(650, t);
        lp.frequency.linearRampToValueAtTime(1500, t + 2.6);
        lp.connect(out); out.connect(master);
        if (send) { var s = actx.createGain(); s.gain.value = 0.55; out.connect(s); s.connect(send); }
        // 完全5度（C4 + G4）。わずかなデチューンでやさしいうねり
        var freqs = [261.63, 392.0];
        var oscs = [];
        for (var i = 0; i < freqs.length; i++) {
          var o = actx.createOscillator();
          o.type = "sine";
          o.frequency.value = freqs[i] * (i ? 1.004 : 1.0);
          o.connect(lp); o.start(t); oscs.push(o);
        }
        // ゆれは音量だけ（トレモロ）。ピッチは固定
        var lfo = actx.createOscillator(); lfo.frequency.value = 3.0;
        var lg = actx.createGain(); lg.gain.value = 0.015;
        lfo.connect(lg); lg.connect(out.gain); lfo.start(t);
        hold = { oscs: oscs, out: out, lfo: lfo };
      },
      holdEnd: function () {
        if (hold && actx) {
          var t = actx.currentTime;
          hold.out.gain.cancelScheduledValues(t);
          hold.out.gain.setValueAtTime(Math.max(hold.out.gain.value, 0.0001), t);
          hold.out.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
          for (var i = 0; i < hold.oscs.length; i++) hold.oscs[i].stop(t + 0.35);
          hold.lfo.stop(t + 0.35);
          hold = null;
        }
      },
      // 離したとき：やわらかい和音で開く
      bloom: function () {
        note(523.25, { type: "sine", dur: 1.1, gain: 0.12, attack: 0.03, wet: 0.9 });
        note(659.25, { type: "sine", dur: 1.1, gain: 0.09, attack: 0.05, wet: 0.9 });
        note(783.99, { type: "sine", dur: 1.2, gain: 0.07, attack: 0.07, wet: 0.9 });
      }
    };
  })();

  // ===================================================================
  // スプライト生成（緑〜シアンの発光）
  // ===================================================================
  function makeGlowSprite(size) {
    var c = document.createElement("canvas");
    c.width = c.height = size;
    var g = c.getContext("2d");
    var r = size / 2;
    var grd = g.createRadialGradient(r, r, 0, r, r, r);
    grd.addColorStop(0, "rgba(255,255,255,0.95)");
    grd.addColorStop(0.25, "rgba(150,255,210,0.7)");
    grd.addColorStop(0.55, "rgba(60,220,190,0.25)");
    grd.addColorStop(1, "rgba(40,200,180,0)");
    g.fillStyle = grd;
    g.fillRect(0, 0, size, size);
    return c;
  }
  function makeMaskSprite(size) {
    // 中心ほど不透明、外周へ向けてなだらかに透明になるアルファマスク。
    // これで歪みの境界がパキッと割れず、徐々にブラーが弱まるように溶ける。
    var c = document.createElement("canvas");
    c.width = c.height = size;
    var g = c.getContext("2d");
    var r = size / 2;
    var grd = g.createRadialGradient(r, r, 0, r, r, r);
    grd.addColorStop(0.0, "rgba(255,255,255,1)");
    grd.addColorStop(0.35, "rgba(255,255,255,0.9)");
    grd.addColorStop(0.6, "rgba(255,255,255,0.6)");
    grd.addColorStop(0.82, "rgba(255,255,255,0.22)");
    grd.addColorStop(1.0, "rgba(255,255,255,0)");
    g.fillStyle = grd;
    g.fillRect(0, 0, size, size);
    return c;
  }
  function makeRingSprite(size) {
    var c = document.createElement("canvas");
    c.width = c.height = size;
    var g = c.getContext("2d");
    var r = size / 2;
    // 中心透明・外周だけ光るリング（波紋のフチ）
    var grd = g.createRadialGradient(r, r, r * 0.55, r, r, r);
    grd.addColorStop(0, "rgba(120,255,210,0)");
    grd.addColorStop(0.78, "rgba(150,255,220,0.10)");
    grd.addColorStop(0.92, "rgba(200,255,240,0.55)");
    grd.addColorStop(1, "rgba(150,255,220,0)");
    g.fillStyle = grd;
    g.fillRect(0, 0, size, size);
    return c;
  }

  // ===================================================================
  // サイズ
  // ===================================================================
  function resize() {
    DPR = Math.min(window.devicePixelRatio || 1, 1.5);
    W = Math.floor(window.innerWidth * DPR);
    H = Math.floor(window.innerHeight * DPR);
    stage.width = W; stage.height = H;
    stage.style.width = window.innerWidth + "px";
    stage.style.height = window.innerHeight + "px";
    bg.width = W; bg.height = H;
    layer.width = W; layer.height = H;
    DIST_MAX = Math.max(W, H) * 0.5; // これ以上大きい歪みはフチの光だけにして軽さを守る
    MH = Math.max(16, Math.round(MW * H / W));
    motionCanvas.width = MW; motionCanvas.height = MH;
    prevLuma = null;
  }
  window.addEventListener("resize", resize);
  window.addEventListener("orientationchange", function () { setTimeout(resize, 250); });

  // ===================================================================
  // 背景（cover フィット）
  // ===================================================================
  function drawCover(c, srcW, srcH) {
    if (!srcW || !srcH) return;
    var scale = Math.max(W / srcW, H / srcH);
    var dw = srcW * scale, dh = srcH * scale;
    bgctx.drawImage(c, (W - dw) / 2, (H - dh) / 2, dw, dh);
  }
  function paintBackground() {
    if (sourceMode === "camera" && camReady && video.videoWidth) {
      drawCover(video, video.videoWidth, video.videoHeight);
    } else if (sourceMode === "photo" && photoImg) {
      drawCover(photoImg, photoImg.naturalWidth, photoImg.naturalHeight);
    } else {
      var g = bgctx.createLinearGradient(0, 0, 0, H);
      g.addColorStop(0, "#06140f"); g.addColorStop(1, "#02110c");
      bgctx.fillStyle = g; bgctx.fillRect(0, 0, W, H);
    }
  }

  // ===================================================================
  // エフェクト生成
  // ===================================================================
  function addWarp(o) {
    if (warps.length >= MAX_WARPS) warps.shift();
    warps.push({
      x: o.x, y: o.y,
      r: o.r, vr: o.vr || 0,
      strength: o.strength || 0, // 拡大バルジ量
      dx: o.dx || 0, dy: o.dy || 0, // 流れのずれ
      glow: o.glow || 0,
      ring: !!o.ring,
      life: 1, decay: o.decay || 0.02,
      held: !!o.held // 長押し中は減衰しない
    });
  }
  function addSpark(x, y, o) {
    if (sparks.length >= MAX_SPARKS) return;
    o = o || {};
    sparks.push({
      x: x, y: y,
      vx: o.vx || 0, vy: o.vy || 0,
      drag: o.drag || 0.94,
      size: o.size || (6 + Math.random() * 8) * DPR,
      life: 1, decay: o.decay || 0.03
    });
  }

  // ===================================================================
  // なぞる
  // ===================================================================
  function onMove(p, x, y) {
    var now = performance.now();
    var dt = Math.max(now - p.lastT, 1);
    var mx = x - p.lastX, my = y - p.lastY;
    var dist = Math.hypot(mx, my);
    // ある程度動いたときだけ warp を置く（数を抑える）
    var step = 14; // css px
    if (dist < step) return;
    var speed = dist / dt; // px/ms
    p.speed = p.speed * 0.5 + speed * 0.5;
    var sp = Math.min(p.speed, 3);
    var cx = x * DPR, cy = y * DPR;

    if (effectMode === "flow") {
      // 進行方向へ景色をずらす＝流れる歪み
      var k = Math.min(dist, 60) * DPR * 0.5;
      var ux = mx / (dist || 1), uy = my / (dist || 1);
      addWarp({
        x: cx, y: cy, r: (38 + sp * 10) * DPR,
        dx: ux * k, dy: uy * k, glow: 0.16, decay: 0.04
      });
    } else if (effectMode === "lens") {
      // 小さな波紋を点々と
      addWarp({
        x: cx, y: cy, r: 10 * DPR, vr: (1.6 + sp * 0.8) * DPR,
        strength: 0.16, glow: 0.2, ring: true, decay: 0.03
      });
    } else {
      // ベール：やわらかく膨らむ膜
      addWarp({
        x: cx, y: cy, r: (44 + sp * 14) * DPR,
        strength: 0.08 + sp * 0.02, glow: 0.14, decay: 0.025
      });
    }
    // ほんの少しだけ光の粒
    if (Math.random() < 0.5) {
      addSpark(cx + (Math.random() - 0.5) * 20 * DPR, cy + (Math.random() - 0.5) * 20 * DPR,
        { size: (5 + Math.random() * 6) * DPR, decay: 0.04 });
    }

    Sound.blip(sp);
    p.lastX = x; p.lastY = y; p.lastT = now; p.moved += dist;
  }

  // ===================================================================
  // タップ（波紋がぱっと広がる）
  // ===================================================================
  function doTap(x, y) {
    var cx = x * DPR, cy = y * DPR;
    addWarp({ x: cx, y: cy, r: 12 * DPR, vr: 5 * DPR, strength: 0.26, glow: 0.3, ring: true, decay: 0.022 });
    addWarp({ x: cx, y: cy, r: 6 * DPR, vr: 3 * DPR, strength: 0.16, glow: 0.18, ring: true, decay: 0.03 });
    var n = 8;
    for (var i = 0; i < n; i++) {
      var a = (i / n) * TAU + Math.random();
      var s = (1.5 + Math.random() * 2.5) * DPR;
      addSpark(cx, cy, { vx: Math.cos(a) * s, vy: Math.sin(a) * s, size: (5 + Math.random() * 6) * DPR });
    }
    Sound.drop();
  }

  // ===================================================================
  // 長押し（バルジが溜まる）→ 離すと波紋になって広がる
  // ===================================================================
  function startHold(p) {
    var cx = p.lastX * DPR, cy = p.lastY * DPR;
    p.hold = {
      x: cx, y: cy, r: 30 * DPR, vr: 0,
      strength: 0.1, dx: 0, dy: 0, glow: 0.18, ring: false,
      life: 1, decay: 0, held: true
    };
    warps.push(p.hold);
    Sound.holdStart();
    p.holdIv = setInterval(function () {
      if (!p.hold) return;
      p.hold.r = Math.min(p.hold.r + 1.6 * DPR, 130 * DPR);
      p.hold.strength = Math.min(p.hold.strength + 0.006, 0.34);
      p.hold.glow = Math.min(p.hold.glow + 0.004, 0.34);
      if (Math.random() < 0.4) {
        var a = Math.random() * TAU, rad = p.hold.r * (0.6 + Math.random() * 0.5);
        addSpark(p.hold.x + Math.cos(a) * rad, p.hold.y + Math.sin(a) * rad,
          { vx: -Math.cos(a) * 0.6 * DPR, vy: -Math.sin(a) * 0.6 * DPR, size: 5 * DPR, decay: 0.05 });
      }
    }, 32);
  }
  function releaseHold(p) {
    if (p.holdIv) clearInterval(p.holdIv);
    Sound.holdEnd();
    if (!p.hold) return;
    var h = p.hold;
    h.held = false;
    h.vr = 6 * DPR;       // 広がる
    h.decay = 0.02;
    h.ring = true;
    var n = Math.floor(10 + h.strength * 40);
    for (var i = 0; i < n; i++) {
      var a = Math.random() * TAU, s = (1 + Math.random() * 4) * DPR * (0.5 + h.strength);
      addSpark(h.x, h.y, { vx: Math.cos(a) * s, vy: Math.sin(a) * s, size: (5 + Math.random() * 6) * DPR });
    }
    Sound.bloom();
    p.hold = null;
  }

  // ===================================================================
  // 更新
  // ===================================================================
  function update() {
    var i, w;
    for (i = warps.length - 1; i >= 0; i--) {
      w = warps[i];
      if (w.held) continue; // 長押し中は据え置き
      w.r += w.vr; w.vr *= 0.97;
      w.life -= w.decay;
      if (w.life <= 0) warps.splice(i, 1);
    }
    for (i = sparks.length - 1; i >= 0; i--) {
      var s = sparks[i];
      s.x += s.vx; s.y += s.vy; s.vx *= s.drag; s.vy *= s.drag;
      s.life -= s.decay;
      if (s.life <= 0) sparks.splice(i, 1);
    }
  }

  // ===================================================================
  // 描画
  // ===================================================================
  function drawWarp(w) {
    var a = w.life < 0 ? 0 : w.life;
    if (a <= 0) return;
    var R = w.r;

    // --- 歪み（やわらかいフチ） ---
    var hasDist = (w.strength > 0.001 || w.dx || w.dy) && R <= DIST_MAX;
    if (hasDist) {
      var bx = Math.max(0, Math.floor(w.x - R));
      var by = Math.max(0, Math.floor(w.y - R));
      var ex = Math.min(W, Math.ceil(w.x + R));
      var ey = Math.min(H, Math.ceil(w.y + R));
      var bw = ex - bx, bh = ey - by;
      if (bw > 0 && bh > 0) {
        // 1) 作業レイヤーに、歪ませた景色を描く（処理量は枠内だけ）
        lctx.globalCompositeOperation = "source-over";
        lctx.clearRect(bx, by, bw, bh);
        lctx.save();
        lctx.beginPath();
        lctx.rect(bx, by, bw, bh);
        lctx.clip();
        if (w.dx || w.dy) {
          lctx.drawImage(bg, w.dx * a, w.dy * a, W, H); // 流れ：ずらす
        } else {
          var s = 1 + w.strength * a; // バルジ：拡大
          lctx.translate(w.x, w.y);
          lctx.scale(s, s);
          lctx.translate(-w.x, -w.y);
          lctx.drawImage(bg, 0, 0);
        }
        lctx.restore();
        // 2) アルファマスクで外周をなだらかに溶かす（枠内だけに限定）
        lctx.save();
        lctx.beginPath();
        lctx.rect(bx, by, bw, bh);
        lctx.clip();
        lctx.globalCompositeOperation = "destination-in";
        lctx.drawImage(mask, w.x - R, w.y - R, R * 2, R * 2);
        lctx.restore();
        lctx.globalCompositeOperation = "source-over";
        // 3) 本番キャンバスへ（life で全体もフェード）
        ctx.globalAlpha = a;
        ctx.drawImage(layer, bx, by, bw, bh, bx, by, bw, bh);
        ctx.globalAlpha = 1;
      }
    }

    // フチの光（波紋）
    if (w.ring) {
      ctx.globalCompositeOperation = "lighter";
      ctx.globalAlpha = 0.5 * a;
      ctx.drawImage(ring, w.x - w.r, w.y - w.r, w.r * 2, w.r * 2);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
    }
    // やわらかな発光
    if (w.glow > 0) {
      var gr = w.r * 1.1;
      ctx.globalCompositeOperation = "lighter";
      ctx.globalAlpha = w.glow * a;
      ctx.drawImage(glow, w.x - gr, w.y - gr, gr * 2, gr * 2);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
    }
  }

  // 動き検出：背景を小さく縮小し、前フレームとの明るさ差から動きを拾う
  function processMotion() {
    if (!motionOn || sourceMode !== "camera" || !camReady || !video.videoWidth) return;
    motionFrame++;
    if (motionFrame % 2) return; // 隔フレームで十分（軽く）
    mctx.drawImage(bg, 0, 0, W, H, 0, 0, MW, MH);
    var d = mctx.getImageData(0, 0, MW, MH).data;
    var n = MW * MH;
    var i;
    if (!prevLuma || prevLuma.length !== n) {
      prevLuma = new Float32Array(n);
      for (i = 0; i < n; i++) prevLuma[i] = d[i * 4] * 0.3 + d[i * 4 + 1] * 0.59 + d[i * 4 + 2] * 0.11;
      return;
    }
    var sumX = 0, sumY = 0, sumW = 0, spawns = 0;
    var MAXS = 5;
    for (var j = 0; j < MH; j++) {
      for (var ix = 0; ix < MW; ix++) {
        var idx = j * MW + ix;
        var l = d[idx * 4] * 0.3 + d[idx * 4 + 1] * 0.59 + d[idx * 4 + 2] * 0.11;
        var diff = Math.abs(l - prevLuma[idx]);
        prevLuma[idx] = l;
        if (diff > MOTION_TH) {
          sumX += ix * diff; sumY += j * diff; sumW += diff;
          // 動いた所にときどき光をともす（数は厳しく制限）
          if (spawns < MAXS && Math.random() < 0.06) {
            var sx = (ix + 0.5) / MW * W, sy = (j + 0.5) / MH * H;
            addSpark(sx, sy, {
              size: (4 + Math.min(diff / 28, 3) * 3) * DPR,
              vx: (Math.random() - 0.5) * 0.6 * DPR,
              vy: (Math.random() - 0.5) * 0.6 * DPR,
              decay: 0.05
            });
            spawns++;
          }
        }
      }
    }
    // 動きの重心にやわらかな膜（人がいる辺りに光が寄る感じ）
    if (sumW > MOTION_TH * 50 && Math.random() < 0.5) {
      addSpark(sumX / sumW / MW * W, sumY / sumW / MH * H, { size: 16 * DPR, decay: 0.06 });
    }
  }

  function render() {
    // 背景
    ctx.globalCompositeOperation = "source-over";
    ctx.drawImage(bg, 0, 0);
    // 歪み
    for (var i = 0; i < warps.length; i++) drawWarp(warps[i]);
    // 光の粒
    if (sparks.length) {
      ctx.globalCompositeOperation = "lighter";
      for (var j = 0; j < sparks.length; j++) {
        var s = sparks[j];
        var sz = s.size * (0.6 + s.life * 0.6);
        ctx.globalAlpha = Math.min(1, s.life * 1.2);
        ctx.drawImage(glow, s.x - sz, s.y - sz, sz * 2, sz * 2);
      }
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
    }
  }

  // ===================================================================
  // メインループ（必要なときだけ描く）
  // ===================================================================
  function frame() {
    var liveCamera = sourceMode === "camera" && camReady && video.videoWidth;
    var active = liveCamera || dragging || warps.length > 0 || sparks.length > 0;
    if (active) {
      paintBackground();
      processMotion();
      update();
      render();
    }
    requestAnimationFrame(frame);
  }

  // ===================================================================
  // ポインタ
  // ===================================================================
  function hideIntro() { if (!introHidden) { introHidden = true; intro.classList.add("hide"); } }
  function getPos(e) { var r = stage.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }

  stage.addEventListener("pointerdown", function (e) {
    if (!gate.classList.contains("hidden")) return;
    e.preventDefault(); hideIntro(); Sound.kick();
    var pos = getPos(e), now = performance.now();
    var p = { lastX: pos.x, lastY: pos.y, lastT: now, startT: now, moved: 0, speed: 0, hold: null };
    pointers[e.pointerId] = p; dragging = true;
    try { stage.setPointerCapture(e.pointerId); } catch (err) {}
    // 触れた瞬間にも小さなゆらぎ
    addWarp({ x: pos.x * DPR, y: pos.y * DPR, r: 26 * DPR, strength: 0.1, glow: 0.16, ring: true, decay: 0.03 });
    p.longTimer = setTimeout(function () { if (p.moved < 12) startHold(p); }, 260);
  }, { passive: false });

  stage.addEventListener("pointermove", function (e) {
    var p = pointers[e.pointerId];
    if (!p) return;
    e.preventDefault();
    var pos = getPos(e);
    if (p.hold) { // 長押し中は指元を追う
      p.lastX = pos.x; p.lastY = pos.y;
      p.hold.x = pos.x * DPR; p.hold.y = pos.y * DPR;
      return;
    }
    onMove(p, pos.x, pos.y);
  }, { passive: false });

  function endPointer(e) {
    var p = pointers[e.pointerId];
    if (!p) return;
    e.preventDefault();
    if (p.longTimer) clearTimeout(p.longTimer);
    var dt = performance.now() - p.startT;
    if (p.hold) releaseHold(p);
    else if (p.moved < 10 && dt < 320) doTap(p.lastX, p.lastY);
    delete pointers[e.pointerId];
    if (!Object.keys(pointers).length) dragging = false;
  }
  stage.addEventListener("pointerup", endPointer, { passive: false });
  stage.addEventListener("pointercancel", endPointer, { passive: false });

  document.addEventListener("touchmove", function (e) {
    if (e.target === stage) e.preventDefault();
  }, { passive: false });

  // ===================================================================
  // カメラ
  // ===================================================================
  function startCamera() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      gateNote.textContent = "この環境ではカメラが使えません。写真モードでお楽しみください。";
      return Promise.reject();
    }
    return navigator.mediaDevices
      .getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false })
      .then(function (stream) { camStream = stream; video.srcObject = stream; return video.play(); })
      .then(function () {
        camReady = true; sourceMode = "camera"; setActive("source", "camera"); hideGate();
        prevLuma = null;
        toast("カメラの景色をゆらせます");
      })
      .catch(function (err) {
        camReady = false;
        var msg = "カメラを使えませんでした。";
        if (location.protocol !== "https:" && location.hostname !== "localhost") {
          msg += " HTTPSでないとカメラは動きません。写真モードへどうぞ。";
        } else {
          msg += " 許可されなかったか、利用できない端末です。写真モードへどうぞ。";
        }
        gateNote.textContent = msg;
        throw err;
      });
  }
  function stopCamera() {
    if (camStream) { camStream.getTracks().forEach(function (t) { t.stop(); }); camStream = null; }
    camReady = false;
  }

  // ===================================================================
  // 写真
  // ===================================================================
  fileInput.addEventListener("change", function (e) {
    var f = e.target.files && e.target.files[0];
    if (!f) return;
    var url = URL.createObjectURL(f);
    var img = new Image();
    img.onload = function () {
      photoImg = img; sourceMode = "photo"; setActive("source", "photo");
      stopCamera(); hideGate(); hideIntro(); toast("写真の景色をゆらせます");
      URL.revokeObjectURL(url);
    };
    img.onerror = function () { toast("写真を読み込めませんでした"); };
    img.src = url;
  });
  function pickPhoto() { fileInput.click(); }

  // ===================================================================
  // ゲート
  // ===================================================================
  function showGate() { gate.classList.remove("hidden"); }
  function hideGate() { gate.classList.add("hidden"); }
  document.getElementById("gateCam").addEventListener("click", function () { Sound.kick(); startCamera().catch(function () {}); });
  document.getElementById("gatePhoto").addEventListener("click", function () { Sound.kick(); pickPhoto(); });

  // 音のオン/オフ
  var soundBtn = document.getElementById("sound");
  soundBtn.addEventListener("click", function () {
    Sound.kick();
    var on = Sound.toggle();
    soundBtn.classList.toggle("muted", !on);
    soundBtn.setAttribute("aria-pressed", on ? "true" : "false");
    toast(on ? "音オン" : "音オフ");
  });

  // 動きに反応のオン/オフ
  var motionBtn = document.getElementById("motion");
  motionBtn.addEventListener("click", function () {
    motionOn = !motionOn;
    prevLuma = null;
    motionBtn.classList.toggle("on", motionOn);
    motionBtn.setAttribute("aria-pressed", motionOn ? "true" : "false");
    toast(motionOn ? "動きに反応 オン" : "動きに反応 オフ");
  });

  // ===================================================================
  // ドック
  // ===================================================================
  function setActive(groupId, value) {
    var attr = groupId === "source" ? "data-src" : "data-mode";
    document.querySelectorAll("#" + groupId + " [" + attr + "]").forEach(function (b) {
      b.classList.toggle("is-active", b.getAttribute(attr) === value);
    });
  }
  document.getElementById("source").addEventListener("click", function (e) {
    var b = e.target.closest(".src"); if (!b) return;
    var v = b.getAttribute("data-src");
    if (v === "camera") {
      if (camReady) { sourceMode = "camera"; setActive("source", "camera"); }
      else startCamera().catch(function () { showGate(); });
    } else {
      if (photoImg) { sourceMode = "photo"; setActive("source", "photo"); stopCamera(); }
      else pickPhoto();
    }
  });
  document.getElementById("modes").addEventListener("click", function (e) {
    var b = e.target.closest(".mode"); if (!b) return;
    effectMode = b.getAttribute("data-mode"); setActive("modes", effectMode);
    var label = { veil: "ベール — ふくらむ膜", flow: "フロー — 流れるゆらぎ", lens: "レンズ — 水面の波紋" };
    toast(label[effectMode]);
  });

  // ===================================================================
  // リセット / 保存
  // ===================================================================
  document.getElementById("reset").addEventListener("click", function () {
    warps.length = 0; sparks.length = 0; toast("もどしました");
  });
  document.getElementById("save").addEventListener("click", function () {
    try {
      stage.toBlob(function (blob) {
        if (!blob) { toast("スクショで保存してね"); return; }
        var url = URL.createObjectURL(blob);
        var a = document.createElement("a");
        a.href = url; a.download = "hikari-nazori-" + Date.now() + ".png";
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
        toast("画像を保存しました");
      }, "image/png");
    } catch (err) { toast("スクショで保存してね"); }
  });

  // ===================================================================
  // トースト
  // ===================================================================
  var toastTimer = null;
  function toast(msg) {
    toastEl.textContent = msg; toastEl.classList.add("show");
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.remove("show"); }, 1700);
  }

  // ===================================================================
  // 起動
  // ===================================================================
  resize();
  requestAnimationFrame(frame);
  showGate();
})();
