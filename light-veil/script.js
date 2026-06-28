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

  // ---- 光スプライト（一度だけ生成して使い回す） ----
  var glow = makeGlowSprite(128);
  var ring = makeRingSprite(256);

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
    ctx.save();
    ctx.beginPath();
    ctx.arc(w.x, w.y, w.r, 0, TAU);
    ctx.clip();
    if (w.dx || w.dy) {
      // 流れ：景色を少しずらして描き直す
      ctx.drawImage(bg, w.dx * a, w.dy * a, W, H);
    } else if (w.strength > 0.001) {
      // バルジ：中心基準で拡大＝ぷくっと膨らむ
      var s = 1 + w.strength * a;
      ctx.translate(w.x, w.y);
      ctx.scale(s, s);
      ctx.translate(-w.x, -w.y);
      ctx.drawImage(bg, 0, 0);
    }
    ctx.restore();

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
    e.preventDefault(); hideIntro();
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
  document.getElementById("gateCam").addEventListener("click", function () { startCamera().catch(function () {}); });
  document.getElementById("gatePhoto").addEventListener("click", pickPhoto);

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
