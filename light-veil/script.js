/*
 * ひかりなぞり — カメラ映像や写真の上に、指で光の膜を描く体験
 *
 * 設計のポイント（軽量・気持ちよさ優先）:
 *  - 背景（カメラ video / アップロード写真）と光のエフェクトを1枚のキャンバスに合成
 *    → そのまま toBlob() で保存できる
 *  - エフェクトは「残光バッファ(fxCanvas)」に加算合成し、毎フレーム少しずつ薄める
 *    → なぞった軌跡が彗星のように尾を引き、数秒でふわっと消える
 *  - なぞる速度で粒の量と帯の太さが変化。ゆっくりだと遅れて集まる（ラグ点）
 *  - タップで泡がぱっと咲き、長押しで粒が溜まり、離すとふわっと散る
 *  - レンズモードは背景を局所的に拡大して水面のような揺れを作る（顔は変形させない弱い演出）
 *
 * 画像処理はすべてブラウザ内で完結。外部送信なし。
 */
(function () {
  "use strict";

  // ---- 要素 ----
  var stage = document.getElementById("stage");
  var ctx = stage.getContext("2d", { alpha: false });
  var video = document.getElementById("cam");
  var fileInput = document.getElementById("file");
  var intro = document.getElementById("intro");
  var gate = document.getElementById("gate");
  var gateNote = document.getElementById("gateNote");
  var toastEl = document.getElementById("toast");

  // ---- オフスクリーン ----
  var bg = document.createElement("canvas"); // 背景（カメラ/写真）の現フレーム
  var bgctx = bg.getContext("2d", { alpha: false });
  var fx = document.createElement("canvas"); // 光の残光バッファ
  var fxctx = fx.getContext("2d");

  // ---- 状態 ----
  var W = 0, H = 0, DPR = 1;
  var sourceMode = "camera"; // "camera" | "photo"
  var effectMode = "veil"; // "veil" | "flow" | "lens"
  var camStream = null;
  var camReady = false;
  var photoImg = null; // アップロードされた写真
  var introHidden = false;

  // ---- 粒子・泡・波紋 ----
  var motes = []; // 光の粒
  var bubbles = []; // 泡（リング）
  var lenses = []; // レンズ揺れ（背景の局所歪み）
  var MAX_MOTES = 1400; // 上限（端末保護）
  var MAX_BUBBLES = 90;
  var MAX_LENSES = 26;

  // ---- ポインタごとの状態（マルチタッチ・マウス両対応） ----
  var pointers = {};

  // ===================================================================
  // サイズ調整
  // ===================================================================
  function resize() {
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    W = Math.floor(window.innerWidth * DPR);
    H = Math.floor(window.innerHeight * DPR);
    stage.width = W; stage.height = H;
    stage.style.width = window.innerWidth + "px";
    stage.style.height = window.innerHeight + "px";
    bg.width = W; bg.height = H;
    fx.width = W; fx.height = H;
    fxctx.clearRect(0, 0, W, H);
  }
  window.addEventListener("resize", resize);
  window.addEventListener("orientationchange", function () {
    setTimeout(resize, 250);
  });

  // ===================================================================
  // 背景描画（cover フィット）
  // ===================================================================
  function drawCover(srcW, srcH, drawFn) {
    if (!srcW || !srcH) return;
    var scale = Math.max(W / srcW, H / srcH);
    var dw = srcW * scale, dh = srcH * scale;
    var dx = (W - dw) / 2, dy = (H - dh) / 2;
    drawFn(dx, dy, dw, dh);
  }

  function paintBackground() {
    if (sourceMode === "camera" && camReady && video.videoWidth) {
      drawCover(video.videoWidth, video.videoHeight, function (dx, dy, dw, dh) {
        bgctx.drawImage(video, dx, dy, dw, dh);
      });
    } else if (sourceMode === "photo" && photoImg) {
      drawCover(photoImg.naturalWidth, photoImg.naturalHeight, function (dx, dy, dw, dh) {
        bgctx.drawImage(photoImg, dx, dy, dw, dh);
      });
    } else {
      // プレースホルダ（落ち着いた暗緑のグラデ）
      var g = bgctx.createLinearGradient(0, 0, 0, H);
      g.addColorStop(0, "#06140f");
      g.addColorStop(1, "#02110c");
      bgctx.fillStyle = g;
      bgctx.fillRect(0, 0, W, H);
    }
  }

  // ===================================================================
  // 色（緑〜シアンの発光）
  // ===================================================================
  function pickHue() {
    // 148(緑) 〜 186(シアン) を中心に
    return 148 + Math.random() * 38;
  }

  // ===================================================================
  // 粒子の生成
  // ===================================================================
  function addMote(x, y, opt) {
    if (motes.length >= MAX_MOTES) return;
    opt = opt || {};
    motes.push({
      x: x, y: y,
      vx: opt.vx || 0, vy: opt.vy || 0,
      drag: opt.drag != null ? opt.drag : 0.94,
      r: opt.r || (1.5 + Math.random() * 2.5) * DPR,
      hue: opt.hue != null ? opt.hue : pickHue(),
      life: 1,
      decay: opt.decay || (0.006 + Math.random() * 0.01),
      soft: opt.soft || 0, // 1 に近いほど大きく淡い膜状
      orbit: opt.orbit || null // 長押しで指に集まる
    });
  }

  function addBubble(x, y, opt) {
    if (bubbles.length >= MAX_BUBBLES) return;
    opt = opt || {};
    bubbles.push({
      x: x, y: y,
      r: opt.r || 4 * DPR,
      vr: opt.vr || (0.6 + Math.random() * 1.2) * DPR, // 膨張速度
      vx: opt.vx || 0, vy: opt.vy || (-0.15 * DPR),
      hue: opt.hue != null ? opt.hue : pickHue(),
      life: 1,
      decay: opt.decay || (0.012 + Math.random() * 0.01),
      width: opt.width || (1.2 + Math.random() * 1.4) * DPR
    });
  }

  function addLens(x, y, opt) {
    if (effectMode !== "lens") return;
    if (lenses.length >= MAX_LENSES) lenses.shift();
    opt = opt || {};
    lenses.push({
      x: x, y: y,
      r: opt.r || 6 * DPR,
      vr: opt.vr || (1.2 + Math.random() * 1.6) * DPR,
      amp: opt.amp || (0.12 + Math.random() * 0.10), // 拡大の強さ
      life: 1,
      decay: opt.decay || (0.012 + Math.random() * 0.008)
    });
  }

  // ===================================================================
  // 操作：なぞる
  // ===================================================================
  function onMove(p, x, y) {
    var now = performance.now();
    var dt = Math.max(now - p.lastT, 1);
    var dx = x - p.lastX, dy = y - p.lastY;
    var dist = Math.hypot(dx, dy);
    var speed = dist / dt; // px(css)/ms
    p.speed = p.speed * 0.6 + speed * 0.4;

    // 進行方向
    var ang = Math.atan2(dy, dx);

    // 速いほど粒が多く帯が太い。距離に沿って撒く
    var sp = Math.min(p.speed, 4);
    var density = effectMode === "flow" ? 0.5 : 0.4;
    var count = Math.min(28, Math.floor(dist * DPR * density) + 1);
    var band = (effectMode === "flow" ? 6 : 10) * DPR * (0.6 + sp * 0.5);

    for (var i = 0; i < count; i++) {
      var t = i / count;
      var px = (p.lastX + dx * t) * DPR;
      var py = (p.lastY + dy * t) * DPR;
      // 帯の幅方向にばらつかせる
      var off = (Math.random() - 0.5) * band;
      var perp = ang + Math.PI / 2;
      var sx = px + Math.cos(perp) * off;
      var sy = py + Math.sin(perp) * off;

      if (effectMode === "flow") {
        // 流れ：進行方向に沿って粒が流れる
        var s = (0.6 + Math.random() * 1.2 + sp * 0.6) * DPR;
        addMote(sx, sy, {
          vx: Math.cos(ang) * s, vy: Math.sin(ang) * s,
          drag: 0.97, r: (1 + Math.random() * 2) * DPR,
          decay: 0.01 + Math.random() * 0.01
        });
      } else if (effectMode === "lens") {
        addMote(sx, sy, {
          vx: Math.cos(perp) * off * 0.02, vy: Math.sin(perp) * off * 0.02,
          r: (1.2 + Math.random() * 2) * DPR, decay: 0.012
        });
      } else {
        // ベール：その場でじわっと
        addMote(sx, sy, {
          vx: (Math.random() - 0.5) * 0.4 * DPR,
          vy: (Math.random() - 0.5) * 0.4 * DPR,
          r: (1.4 + Math.random() * 2.4) * DPR,
          decay: 0.008 + Math.random() * 0.008
        });
      }
    }

    // ラグ点：少し遅れて追従する位置から、膜（大きく淡い粒）を出す
    p.lagX += ((x * DPR) - p.lagX) * 0.16;
    p.lagY += ((y * DPR) - p.lagY) * 0.16;
    if (Math.random() < 0.65) {
      addMote(p.lagX + (Math.random() - 0.5) * band, p.lagY + (Math.random() - 0.5) * band, {
        r: (10 + Math.random() * 18) * DPR,
        soft: 1, decay: 0.01 + Math.random() * 0.008,
        drag: 0.9
      });
    }

    // ときどき小さな泡
    if (Math.random() < 0.12 + sp * 0.04) {
      addBubble(x * DPR, y * DPR, { r: (3 + Math.random() * 5) * DPR });
    }

    // レンズの揺れを点々と
    if (effectMode === "lens" && Math.random() < 0.5) {
      addLens(x * DPR, y * DPR, { r: (8 + Math.random() * 10) * DPR, amp: 0.10 + Math.random() * 0.08 });
    }

    p.lastX = x; p.lastY = y; p.lastT = now;
    p.moved += dist;
  }

  // ===================================================================
  // 操作：タップ（泡がぱっと咲く）
  // ===================================================================
  function doTap(x, y) {
    var cx = x * DPR, cy = y * DPR;
    var hue = pickHue();
    // 波紋リング
    addBubble(cx, cy, { r: 6 * DPR, vr: 3.2 * DPR, width: 2.4 * DPR, hue: hue, decay: 0.016 });
    addBubble(cx, cy, { r: 2 * DPR, vr: 2.0 * DPR, width: 1.6 * DPR, hue: hue + 14, decay: 0.02 });
    // 外へ広がる光の粒
    var n = 26;
    for (var i = 0; i < n; i++) {
      var a = (i / n) * Math.PI * 2 + Math.random() * 0.3;
      var sp = (1.5 + Math.random() * 3.5) * DPR;
      addMote(cx, cy, {
        vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
        r: (1.5 + Math.random() * 2.5) * DPR, drag: 0.93,
        hue: hue + (Math.random() - 0.5) * 20, decay: 0.012
      });
    }
    // 中心のやわらかな膜
    addMote(cx, cy, { r: 26 * DPR, soft: 1, decay: 0.02, hue: hue });
    addLens(cx, cy, { r: 10 * DPR, vr: 3.4 * DPR, amp: 0.18 });
  }

  // ===================================================================
  // 操作：長押し（指元に粒が集まる）→ 離すとふわっと散る
  // ===================================================================
  function gatherTick(p) {
    var cx = p.lastX * DPR, cy = p.lastY * DPR;
    // 周囲に粒を湧かせ、指へ引き寄せる
    for (var i = 0; i < 3; i++) {
      var a = Math.random() * Math.PI * 2;
      var rad = (50 + Math.random() * 90) * DPR;
      addMote(cx + Math.cos(a) * rad, cy + Math.sin(a) * rad, {
        r: (1.4 + Math.random() * 2.2) * DPR,
        decay: 0.004,
        orbit: { tx: cx, ty: cy, pull: 0.05 + Math.random() * 0.04 }
      });
    }
    p.charge = Math.min(p.charge + 1, 120);
  }

  function release(p) {
    var cx = p.lastX * DPR, cy = p.lastY * DPR;
    var power = 0.5 + p.charge / 120; // 溜めた分だけ大きく
    var hue = pickHue();
    var n = Math.floor(20 + p.charge * 0.5);
    for (var i = 0; i < n; i++) {
      var a = Math.random() * Math.PI * 2;
      var sp = (1 + Math.random() * 4) * power * DPR;
      addMote(cx, cy, {
        vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
        r: (1.5 + Math.random() * 3) * DPR, drag: 0.94,
        hue: hue + (Math.random() - 0.5) * 24, decay: 0.01
      });
    }
    addBubble(cx, cy, { r: 8 * DPR, vr: 3 * power * DPR, width: 2.6 * DPR, hue: hue, decay: 0.014 });
    addMote(cx, cy, { r: 30 * power * DPR, soft: 1, decay: 0.018, hue: hue });
    addLens(cx, cy, { r: 12 * DPR, vr: 3.5 * DPR, amp: 0.2 * power });
  }

  // ===================================================================
  // 更新
  // ===================================================================
  function update() {
    var i, p;
    for (i = motes.length - 1; i >= 0; i--) {
      p = motes[i];
      if (p.orbit) {
        // 指へ引き寄せ
        p.vx += (p.orbit.tx - p.x) * p.orbit.pull * 0.06;
        p.vy += (p.orbit.ty - p.y) * p.orbit.pull * 0.06;
        p.vx *= 0.9; p.vy *= 0.9;
      }
      p.x += p.vx; p.y += p.vy;
      p.vx *= p.drag; p.vy *= p.drag;
      p.life -= p.decay;
      if (p.life <= 0) motes.splice(i, 1);
    }
    for (i = bubbles.length - 1; i >= 0; i--) {
      p = bubbles[i];
      p.r += p.vr; p.vr *= 0.985;
      p.x += p.vx; p.y += p.vy;
      p.life -= p.decay;
      if (p.life <= 0) bubbles.splice(i, 1);
    }
    for (i = lenses.length - 1; i >= 0; i--) {
      p = lenses[i];
      p.r += p.vr; p.vr *= 0.97;
      p.life -= p.decay;
      if (p.life <= 0) lenses.splice(i, 1);
    }
  }

  // ===================================================================
  // 描画
  // ===================================================================
  function drawFx() {
    // 残光をゆっくり薄める（数秒でふわっと消える）
    fxctx.globalCompositeOperation = "destination-out";
    fxctx.fillStyle = "rgba(0,0,0,0.055)";
    fxctx.fillRect(0, 0, W, H);

    // 光は加算合成
    fxctx.globalCompositeOperation = "lighter";

    var i, p, g;
    for (i = 0; i < motes.length; i++) {
      p = motes[i];
      var a = Math.max(0, p.life);
      var rad = p.r * (p.soft ? (1.2 - a * 0.2) : 1);
      g = fxctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, rad);
      var l = 70;
      if (p.soft) {
        // 膜：白を抑え、淡い緑シアンで広く
        g.addColorStop(0, "hsla(" + p.hue + ",90%,72%," + (0.10 * a) + ")");
        g.addColorStop(0.5, "hsla(" + p.hue + ",90%,60%," + (0.06 * a) + ")");
        g.addColorStop(1, "hsla(" + p.hue + ",90%,55%,0)");
      } else {
        g.addColorStop(0, "hsla(" + p.hue + ",100%,92%," + (0.9 * a) + ")");
        g.addColorStop(0.35, "hsla(" + p.hue + ",100%,70%," + (0.55 * a) + ")");
        g.addColorStop(1, "hsla(" + p.hue + ",100%,60%,0)");
      }
      fxctx.fillStyle = g;
      fxctx.beginPath();
      fxctx.arc(p.x, p.y, rad, 0, Math.PI * 2);
      fxctx.fill();
    }

    for (i = 0; i < bubbles.length; i++) {
      p = bubbles[i];
      var ba = Math.max(0, p.life);
      // 泡のリング
      fxctx.lineWidth = p.width;
      fxctx.strokeStyle = "hsla(" + p.hue + ",100%,80%," + (0.5 * ba) + ")";
      fxctx.beginPath();
      fxctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      fxctx.stroke();
      // 淡い内側の膜
      g = fxctx.createRadialGradient(p.x, p.y, p.r * 0.2, p.x, p.y, p.r);
      g.addColorStop(0, "hsla(" + p.hue + ",90%,70%,0)");
      g.addColorStop(0.7, "hsla(" + p.hue + ",90%,65%," + (0.04 * ba) + ")");
      g.addColorStop(1, "hsla(" + p.hue + ",95%,80%," + (0.14 * ba) + ")");
      fxctx.fillStyle = g;
      fxctx.beginPath();
      fxctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      fxctx.fill();
      // 小さなハイライト（泡の艶）
      var hx = p.x - p.r * 0.34, hy = p.y - p.r * 0.34;
      g = fxctx.createRadialGradient(hx, hy, 0, hx, hy, p.r * 0.32);
      g.addColorStop(0, "hsla(0,0%,100%," + (0.35 * ba) + ")");
      g.addColorStop(1, "hsla(0,0%,100%,0)");
      fxctx.fillStyle = g;
      fxctx.beginPath();
      fxctx.arc(hx, hy, p.r * 0.32, 0, Math.PI * 2);
      fxctx.fill();
    }
    fxctx.globalCompositeOperation = "source-over";
  }

  // レンズ歪み：背景の局所を拡大して水面の揺れを作る
  function applyLens() {
    if (!lenses.length) return;
    for (var i = 0; i < lenses.length; i++) {
      var p = lenses[i];
      var a = Math.max(0, p.life);
      var amp = p.amp * a;
      if (amp < 0.01 || p.r < 2) continue;
      var s = 1 + amp; // 拡大率
      ctx.save();
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.clip();
      // 中心を基準に背景を拡大して描き直す＝ぷくっと膨らむレンズ
      ctx.translate(p.x, p.y);
      ctx.scale(s, s);
      ctx.translate(-p.x, -p.y);
      ctx.drawImage(bg, 0, 0);
      ctx.restore();
    }
  }

  // ===================================================================
  // メインループ
  // ===================================================================
  function frame() {
    paintBackground();
    update();

    // 背景を下地に
    ctx.globalCompositeOperation = "source-over";
    ctx.drawImage(bg, 0, 0);

    // レンズ歪み（背景の上に局所的に）
    if (effectMode === "lens") applyLens();

    // 光のエフェクトを合成
    drawFx();
    ctx.globalCompositeOperation = "lighter";
    ctx.drawImage(fx, 0, 0);
    ctx.globalCompositeOperation = "source-over";

    requestAnimationFrame(frame);
  }

  // ===================================================================
  // ポインタ操作
  // ===================================================================
  function hideIntro() {
    if (introHidden) return;
    introHidden = true;
    intro.classList.add("hide");
  }

  function getPos(e) {
    var r = stage.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  stage.addEventListener("pointerdown", function (e) {
    if (!gate.classList.contains("hidden")) return;
    e.preventDefault();
    hideIntro();
    var pos = getPos(e);
    var now = performance.now();
    var p = {
      lastX: pos.x, lastY: pos.y, lastT: now,
      lagX: pos.x * DPR, lagY: pos.y * DPR,
      startX: pos.x, startY: pos.y, startT: now,
      moved: 0, speed: 0, charge: 0,
      longTimer: null, gathering: false
    };
    pointers[e.pointerId] = p;
    try { stage.setPointerCapture(e.pointerId); } catch (err) {}

    // ひとまず指元に少し光を出す
    addMote(pos.x * DPR, pos.y * DPR, { r: 8 * DPR, soft: 1, decay: 0.02 });
    addLens(pos.x * DPR, pos.y * DPR, { r: 8 * DPR, amp: 0.12 });

    // 長押し判定
    p.longTimer = setTimeout(function () {
      if (p.moved < 12) {
        p.gathering = true;
        p.gatherIv = setInterval(function () { gatherTick(p); }, 32);
      }
    }, 280);
  }, { passive: false });

  stage.addEventListener("pointermove", function (e) {
    var p = pointers[e.pointerId];
    if (!p) return;
    e.preventDefault();
    var pos = getPos(e);
    if (p.gathering) {
      // 集めている間は指元を追うだけ
      p.lastX = pos.x; p.lastY = pos.y;
      return;
    }
    onMove(p, pos.x, pos.y);
  }, { passive: false });

  function endPointer(e) {
    var p = pointers[e.pointerId];
    if (!p) return;
    e.preventDefault();
    if (p.longTimer) clearTimeout(p.longTimer);
    if (p.gatherIv) clearInterval(p.gatherIv);

    var dt = performance.now() - p.startT;
    if (p.gathering) {
      release(p); // 長押し → 離してふわっと
    } else if (p.moved < 10 * DPR && dt < 320) {
      doTap(p.lastX, p.lastY); // タップ
    }
    delete pointers[e.pointerId];
  }
  stage.addEventListener("pointerup", endPointer, { passive: false });
  stage.addEventListener("pointercancel", endPointer, { passive: false });

  // ページ全体のスクロール暴発を抑える
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
      .then(function (stream) {
        camStream = stream;
        video.srcObject = stream;
        return video.play();
      })
      .then(function () {
        camReady = true;
        sourceMode = "camera";
        setActive("source", "camera");
        hideGate();
        toast("カメラの上に描けます");
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
    if (camStream) {
      camStream.getTracks().forEach(function (t) { t.stop(); });
      camStream = null;
    }
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
      photoImg = img;
      sourceMode = "photo";
      setActive("source", "photo");
      stopCamera();
      hideGate();
      hideIntro();
      toast("写真の上に描けます");
      URL.revokeObjectURL(url);
    };
    img.onerror = function () { toast("写真を読み込めませんでした"); };
    img.src = url;
  });

  function pickPhoto() {
    fileInput.click();
  }

  // ===================================================================
  // ゲート（最初の案内）
  // ===================================================================
  function showGate() { gate.classList.remove("hidden"); }
  function hideGate() { gate.classList.add("hidden"); }

  document.getElementById("gateCam").addEventListener("click", function () {
    startCamera().catch(function () {});
  });
  document.getElementById("gatePhoto").addEventListener("click", pickPhoto);

  // ===================================================================
  // ドック（ソース / モード切替）
  // ===================================================================
  function setActive(groupId, value) {
    var btns = document.querySelectorAll("#" + groupId + " [data-" + (groupId === "source" ? "src" : "mode") + "]");
    btns.forEach(function (b) {
      var v = b.getAttribute(groupId === "source" ? "data-src" : "data-mode");
      b.classList.toggle("is-active", v === value);
    });
  }

  document.getElementById("source").addEventListener("click", function (e) {
    var b = e.target.closest(".src");
    if (!b) return;
    var v = b.getAttribute("data-src");
    if (v === "camera") {
      if (camReady) { sourceMode = "camera"; setActive("source", "camera"); }
      else { startCamera().catch(function () { showGate(); }); }
    } else {
      if (photoImg) { sourceMode = "photo"; setActive("source", "photo"); stopCamera(); }
      else { pickPhoto(); }
    }
  });

  document.getElementById("modes").addEventListener("click", function (e) {
    var b = e.target.closest(".mode");
    if (!b) return;
    effectMode = b.getAttribute("data-mode");
    setActive("modes", effectMode);
    var label = { veil: "ベール — 泡と膜", flow: "フロー — 流れる光", lens: "レンズ — 水面の揺れ" };
    toast(label[effectMode]);
  });

  // ===================================================================
  // リセット / 保存
  // ===================================================================
  document.getElementById("reset").addEventListener("click", function () {
    motes.length = 0; bubbles.length = 0; lenses.length = 0;
    fxctx.clearRect(0, 0, W, H);
    toast("消しました");
  });

  document.getElementById("save").addEventListener("click", function () {
    // 現フレームを1枚に焼き込んで保存
    try {
      stage.toBlob(function (blob) {
        if (!blob) { toast("スクショで保存してね"); return; }
        var url = URL.createObjectURL(blob);
        var a = document.createElement("a");
        a.href = url;
        a.download = "hikari-nazori-" + Date.now() + ".png";
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
        toast("画像を保存しました");
      }, "image/png");
    } catch (err) {
      toast("スクショで保存してね");
    }
  });

  // ===================================================================
  // トースト
  // ===================================================================
  var toastTimer = null;
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add("show");
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.remove("show"); }, 1700);
  }

  // ===================================================================
  // 起動
  // ===================================================================
  resize();
  requestAnimationFrame(frame);
  // 最初はカメラ/写真の選択ゲートを表示（カメラ権限はユーザー操作後に要求）
  showGate();
})();
