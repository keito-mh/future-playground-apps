/*
 * ひかりなぞり — 手をかざすと、指先・手のひらから光があふれる体験
 *
 * 体験の核：
 *  - カメラに手を写すと、指先から光の粒が流れ出す（手を動かすと光がついてくる）
 *  - 手を「ひらく」と、手のひらから光がブワッと広がる
 *  - 「つまむ」と光が集まり、「離す」とぱっと弾ける
 *  - 「にぎる（グー）」と、光がふわっと鎮まる
 *  - 光は生きているように流れ、ゆっくり咲いて消える（指を止めても動き続ける）
 *
 * 技術：
 *  - 手の認識は MediaPipe Hands（指先・手のひら・握り/開き/つまみ）。顔認識・個人特定はしない。
 *  - 光は事前生成スプライトを drawImage で重ねるだけ＝軽い（毎フレームのグラデ生成なし）。
 *  - カメラ無し／認識できない時は、指タッチでも描ける（自動フォールバック）。
 *  - 画像処理はすべてブラウザ内。映像も手のデータも保存・送信しない。
 */
const TAU = Math.PI * 2;

// ---- 要素 ----
const stage = document.getElementById("stage");
const ctx = stage.getContext("2d", { alpha: false });
const video = document.getElementById("cam");
const fileInput = document.getElementById("file");
const intro = document.getElementById("intro");
const gate = document.getElementById("gate");
const gateNote = document.getElementById("gateNote");
const toastEl = document.getElementById("toast");

// ---- オフスクリーン背景 ----
const bg = document.createElement("canvas");
const bgctx = bg.getContext("2d", { alpha: false });

// ---- 状態 ----
let W = 0, H = 0, DPR = 1;
let sourceMode = "camera"; // "camera" | "photo"
let theme = "green"; // "green" | "aurora" | "gold"
let camStream = null, camReady = false;
let facing = "user"; // 手をかざす体験は内カメラが自然
let photoImg = null;
let introHidden = false;
let handOn = true;

// ---- 光の粒（生きて流れる） ----
const particles = [];
const MAX_PARTICLES = 1000;

// ---- ポインタ（タッチ／マウスのフォールバック描画） ----
const pointers = {};
let dragging = false;

// ===================================================================
// 色つき発光スプライト（hue ごとに一度だけ生成してキャッシュ）
// ===================================================================
const glowCache = {};
function getGlow(hue) {
  const key = Math.round(hue / 12) * 12;
  if (!glowCache[key]) {
    const size = 128, c = document.createElement("canvas");
    c.width = c.height = size;
    const g = c.getContext("2d"), r = size / 2;
    const grd = g.createRadialGradient(r, r, 0, r, r, r);
    grd.addColorStop(0, "rgba(255,255,255,0.95)");
    grd.addColorStop(0.22, `hsla(${key},100%,80%,0.75)`);
    grd.addColorStop(0.5, `hsla(${key},95%,60%,0.28)`);
    grd.addColorStop(1, `hsla(${key},90%,55%,0)`);
    g.fillStyle = grd;
    g.fillRect(0, 0, size, size);
    glowCache[key] = c;
  }
  return glowCache[key];
}

// テーマごとの色相
function themeHue() {
  if (theme === "aurora") return 150 + Math.random() * 110; // 緑〜青紫
  if (theme === "gold") return 38 + Math.random() * 18; // 金
  return 150 + Math.random() * 36; // みどり〜シアン
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
window.addEventListener("orientationchange", () => setTimeout(resize, 250));

// ===================================================================
// 背景（cover フィット・内カメラは鏡像）
// ===================================================================
function drawCover(c, sw, sh) {
  if (!sw || !sh) return;
  const scale = Math.max(W / sw, H / sh);
  const dw = sw * scale, dh = sh * scale;
  bgctx.drawImage(c, (W - dw) / 2, (H - dh) / 2, dw, dh);
}
function paintBackground() {
  if (sourceMode === "camera" && camReady && video.videoWidth) {
    if (facing === "user") {
      bgctx.save();
      bgctx.translate(W, 0);
      bgctx.scale(-1, 1);
      drawCover(video, video.videoWidth, video.videoHeight);
      bgctx.restore();
    } else {
      drawCover(video, video.videoWidth, video.videoHeight);
    }
  } else if (sourceMode === "photo" && photoImg) {
    drawCover(photoImg, photoImg.naturalWidth, photoImg.naturalHeight);
  } else {
    const g = bgctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, "#06140f"); g.addColorStop(1, "#02110c");
    bgctx.fillStyle = g; bgctx.fillRect(0, 0, W, H);
  }
}

// 手のランドマーク（0..1, 映像基準）→ 画面座標（cover＋鏡像を反映）
function lmToScreen(nx, ny) {
  const sw = video.videoWidth, sh = video.videoHeight;
  const scale = Math.max(W / sw, H / sh);
  const dw = sw * scale, dh = sh * scale;
  const dx = (W - dw) / 2, dy = (H - dh) / 2;
  let x = dx + nx * dw;
  const y = dy + ny * dh;
  if (facing === "user") x = W - x; // 鏡像
  return { x, y };
}

// ===================================================================
// 光の粒
// ===================================================================
function addParticle(x, y, o = {}) {
  if (particles.length >= MAX_PARTICLES) return;
  particles.push({
    x, y,
    vx: o.vx || 0, vy: o.vy || 0,
    drag: o.drag ?? 0.95,
    size: o.size || (5 + Math.random() * 7) * DPR,
    grow: o.grow ?? 1,
    hue: o.hue ?? themeHue(),
    life: 1,
    decay: o.decay || (0.012 + Math.random() * 0.012),
    swirl: o.swirl ?? (0.6 + Math.random() * 0.8), // 渦の効き
    orbit: o.orbit || null
  });
}

function update(dt) {
  const t = performance.now() * 0.0006;
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    if (p.orbit) {
      p.vx += (p.orbit.x - p.x) * 0.012;
      p.vy += (p.orbit.y - p.y) * 0.012;
      p.vx *= 0.92; p.vy *= 0.92;
    } else {
      // やわらかな渦（curlっぽい流れ）で“生きている”動きに
      const a = Math.sin(p.x * 0.006 + t) + Math.cos(p.y * 0.006 - t);
      p.vx += Math.cos(a * Math.PI) * 0.04 * p.swirl * DPR;
      p.vy += Math.sin(a * Math.PI) * 0.04 * p.swirl * DPR;
      p.vy -= 0.02 * DPR; // ほんのり上昇
    }
    p.x += p.vx; p.y += p.vy;
    p.vx *= p.drag; p.vy *= p.drag;
    p.life -= p.decay;
    if (p.life <= 0) particles.splice(i, 1);
  }
}

function render() {
  ctx.globalCompositeOperation = "source-over";
  ctx.drawImage(bg, 0, 0);
  // 手のフィードバック（指先のかすかな印）
  if (handOn) drawHandHints();
  // 光の粒（加算）
  ctx.globalCompositeOperation = "lighter";
  for (let i = 0; i < particles.length; i++) {
    const p = particles[i];
    const sz = p.size * (p.grow ? (0.5 + p.life * 0.9) : 1);
    ctx.globalAlpha = Math.min(1, p.life * 1.3);
    ctx.drawImage(getGlow(p.hue), p.x - sz, p.y - sz, sz * 2, sz * 2);
  }
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
}

// ===================================================================
// 手の認識（MediaPipe Hands）
// ===================================================================
let handLandmarker = null;
let handReady = false;
let lastVideoTime = -1;
let handStates = {}; // handedness ごとの前フレーム状態
let liveHands = []; // 描画用：今フレームの指先

async function loadHands() {
  try {
    toast("手の認識を準備中…");
    const vision = await import(
      "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14"
    );
    const { HandLandmarker, FilesetResolver } = vision;
    const fileset = await FilesetResolver.forVisionTasks(
      "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm"
    );
    handLandmarker = await HandLandmarker.createFromOptions(fileset, {
      baseOptions: {
        modelAssetPath:
          "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
        delegate: "GPU"
      },
      runningMode: "VIDEO",
      numHands: 2
    });
    handReady = true;
    toast("手をかざしてみて");
  } catch (e) {
    handReady = false;
    handOn = false;
    document.getElementById("hand").classList.remove("on");
    toast("手の認識は使えません。指で描けます");
  }
}

function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

// 指が伸びているか（指先が、付け根より手首から遠い）
function fingerExtended(L, tip, pip) {
  return dist(L[tip], L[0]) > dist(L[pip], L[0]) * 1.05;
}

function processHands(nowMs) {
  liveHands = [];
  if (!handOn || !handReady || !handLandmarker || sourceMode !== "camera" || !camReady || !video.videoWidth) return;
  if (video.currentTime === lastVideoTime) return;
  lastVideoTime = video.currentTime;

  let res;
  try { res = handLandmarker.detectForVideo(video, nowMs); } catch (e) { return; }
  if (!res || !res.landmarks) return;

  const seen = {};
  for (let h = 0; h < res.landmarks.length; h++) {
    const lm = res.landmarks[h];
    const label = (res.handednesses?.[h]?.[0]?.categoryName || ("h" + h)) + h;
    seen[label] = true;
    // 画面座標へ
    const L = lm.map((p) => lmToScreen(p.x, p.y));
    const palm = { x: (L[0].x + L[5].x + L[17].x) / 3, y: (L[0].y + L[5].y + L[17].y) / 3 };
    const palmSize = dist(L[0], L[9]) || 1;

    const st = handStates[label] || (handStates[label] = { prev: null, wasOpen: false, wasPinch: false, wasFist: false, lastEmit: 0 });

    // 指の状態
    const ext = {
      thumb: fingerExtended(L, 4, 2),
      index: fingerExtended(L, 8, 6),
      middle: fingerExtended(L, 12, 10),
      ring: fingerExtended(L, 16, 14),
      pinky: fingerExtended(L, 20, 18)
    };
    const extCount = (ext.thumb ? 1 : 0) + (ext.index ? 1 : 0) + (ext.middle ? 1 : 0) + (ext.ring ? 1 : 0) + (ext.pinky ? 1 : 0);
    const pinchD = dist(L[4], L[8]) / palmSize;
    const isPinch = pinchD < 0.45;
    const isOpen = !isPinch && extCount >= 4;
    const isFist = !isPinch && extCount <= 1;

    // 指先トレイル（伸びている指から光が流れる）
    const tips = [[4, ext.thumb], [8, ext.index], [12, ext.middle], [16, ext.ring], [20, ext.pinky]];
    for (const [ti, on] of tips) {
      if (!on) continue;
      let vx = 0, vy = 0;
      if (st.prev) { vx = (L[ti].x - st.prev[ti].x); vy = (L[ti].y - st.prev[ti].y); }
      const sp = Math.hypot(vx, vy);
      const n = sp > 6 ? 2 : 1;
      for (let k = 0; k < n; k++) {
        addParticle(L[ti].x + (Math.random() - 0.5) * 8 * DPR, L[ti].y + (Math.random() - 0.5) * 8 * DPR, {
          vx: vx * 0.35 + (Math.random() - 0.5) * 0.6 * DPR,
          vy: vy * 0.35 + (Math.random() - 0.5) * 0.6 * DPR,
          size: (4 + Math.random() * 5) * DPR, decay: 0.018
        });
      }
      if (sp > 5 && nowMs - st.lastEmit > 110) { Sound.chime(sp / 10); st.lastEmit = nowMs; }
    }

    // つまむ：集める
    if (isPinch) {
      const pc = { x: (L[4].x + L[8].x) / 2, y: (L[4].y + L[8].y) / 2 };
      for (let k = 0; k < 2; k++) {
        const a = Math.random() * TAU, r = (60 + Math.random() * 80) * DPR;
        addParticle(pc.x + Math.cos(a) * r, pc.y + Math.sin(a) * r, {
          size: (4 + Math.random() * 4) * DPR, decay: 0.01, orbit: pc
        });
      }
      if (!st.wasPinch) Sound.gather();
    }
    // 離した瞬間：弾ける
    if (!isPinch && st.wasPinch) {
      const pc = st.prev ? { x: (st.prev[4].x + st.prev[8].x) / 2, y: (st.prev[4].y + st.prev[8].y) / 2 } : palm;
      burst(pc.x, pc.y, 1.0);
      Sound.burst();
    }

    // ひらく：手のひらから広がる
    if (isOpen && !st.wasOpen) {
      bloomFrom(palm, palmSize);
      Sound.bloom();
    }
    if (isOpen && Math.random() < 0.5) {
      const a = Math.random() * TAU, r = palmSize * (0.4 + Math.random() * 0.6);
      addParticle(palm.x + Math.cos(a) * r, palm.y + Math.sin(a) * r, {
        vx: Math.cos(a) * 1.2 * DPR, vy: Math.sin(a) * 1.2 * DPR, size: (5 + Math.random() * 6) * DPR
      });
    }

    // にぎる：鎮める
    if (isFist && !st.wasFist) { calm(); Sound.calm(); }

    // 手のひらのやわらかなオーラ
    liveHands.push({ palm, palmSize, tips: tips.filter(t => t[1]).map(t => L[t[0]]) });

    st.prev = L;
    st.wasOpen = isOpen; st.wasPinch = isPinch; st.wasFist = isFist;
  }
  // 見えなくなった手の状態を掃除
  for (const k in handStates) if (!seen[k]) delete handStates[k];
}

function drawHandHints() {
  if (!liveHands.length) return;
  const hueBase = theme === "gold" ? 46 : theme === "aurora" ? 200 : 165;
  ctx.globalCompositeOperation = "lighter";
  for (const hnd of liveHands) {
    // 手のひらのオーラ
    const g = getGlow(hueBase);
    const r = hnd.palmSize * 0.9;
    ctx.globalAlpha = 0.10;
    ctx.drawImage(g, hnd.palm.x - r, hnd.palm.y - r, r * 2, r * 2);
    // 指先の小さな印
    ctx.globalAlpha = 0.5;
    const s = 7 * DPR;
    for (const tp of hnd.tips) {
      ctx.drawImage(g, tp.x - s, tp.y - s, s * 2, s * 2);
    }
  }
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
}

// ===================================================================
// 効果（開く・弾ける・集めた後・鎮める）
// ===================================================================
function bloomFrom(c, size) {
  const hue = themeHue();
  const n = 26;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU + Math.random() * 0.3;
    const sp = (2 + Math.random() * 4) * DPR;
    addParticle(c.x, c.y, { vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, size: (5 + Math.random() * 7) * DPR, hue: hue + (Math.random() - 0.5) * 20, decay: 0.012 });
  }
  addParticle(c.x, c.y, { size: (size || 60) * 1.1, grow: 0, decay: 0.03, hue });
}
function burst(x, y, power) {
  const hue = themeHue();
  const n = Math.floor(22 * power);
  for (let i = 0; i < n; i++) {
    const a = Math.random() * TAU, sp = (1.5 + Math.random() * 5) * power * DPR;
    addParticle(x, y, { vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, size: (5 + Math.random() * 6) * DPR, hue: hue + (Math.random() - 0.5) * 24, decay: 0.012 });
  }
}
function calm() {
  // 全体をやわらかく早めにフェード（鎮める）
  for (const p of particles) { p.decay = Math.max(p.decay, 0.06); p.orbit = null; }
}

// ===================================================================
// メインループ
// ===================================================================
function frame() {
  const liveCamera = sourceMode === "camera" && camReady && video.videoWidth;
  const active = liveCamera || dragging || particles.length > 0;
  if (active) {
    paintBackground();
    processHands(performance.now());
    update();
    render();
  }
  requestAnimationFrame(frame);
}

// ===================================================================
// タッチ／マウスのフォールバック描画
// ===================================================================
function hideIntro() { if (!introHidden) { introHidden = true; intro.classList.add("hide"); } }
function getPos(e) { const r = stage.getBoundingClientRect(); return { x: (e.clientX - r.left) * DPR, y: (e.clientY - r.top) * DPR }; }

stage.addEventListener("pointerdown", (e) => {
  if (!gate.classList.contains("hidden")) return;
  e.preventDefault(); hideIntro(); Sound.kick();
  const pos = getPos(e), now = performance.now();
  pointers[e.pointerId] = { x: pos.x, y: pos.y, lastT: now, startT: now, moved: 0 };
  dragging = true;
  try { stage.setPointerCapture(e.pointerId); } catch (err) {}
}, { passive: false });

stage.addEventListener("pointermove", (e) => {
  const p = pointers[e.pointerId];
  if (!p) return;
  e.preventDefault();
  const pos = getPos(e);
  const mx = pos.x - p.x, my = pos.y - p.y, d = Math.hypot(mx, my);
  const steps = Math.min(8, Math.floor(d / (6 * DPR)) + 1);
  for (let i = 0; i < steps; i++) {
    const t = i / steps;
    addParticle(p.x + mx * t, p.y + my * t, {
      vx: mx * 0.1 + (Math.random() - 0.5) * 0.6 * DPR,
      vy: my * 0.1 + (Math.random() - 0.5) * 0.6 * DPR,
      size: (4 + Math.random() * 5) * DPR, decay: 0.018
    });
  }
  if (d > 4) Sound.chime(d / 14);
  p.x = pos.x; p.y = pos.y; p.moved += d;
}, { passive: false });

function endPointer(e) {
  const p = pointers[e.pointerId];
  if (!p) return;
  e.preventDefault();
  if (p.moved < 10 * DPR && performance.now() - p.startT < 320) { burst(p.x, p.y, 1); Sound.burst(); }
  delete pointers[e.pointerId];
  if (!Object.keys(pointers).length) dragging = false;
}
stage.addEventListener("pointerup", endPointer, { passive: false });
stage.addEventListener("pointercancel", endPointer, { passive: false });
document.addEventListener("touchmove", (e) => { if (e.target === stage) e.preventDefault(); }, { passive: false });

// ===================================================================
// カメラ
// ===================================================================
function startCamera() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    gateNote.textContent = "この環境ではカメラが使えません。写真モードでお楽しみください。";
    return Promise.reject();
  }
  return navigator.mediaDevices
    .getUserMedia({ video: { facingMode: { ideal: facing }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false })
    .then((stream) => { camStream = stream; video.srcObject = stream; return video.play(); })
    .then(() => {
      camReady = true; sourceMode = "camera"; setActive("source", "camera"); hideGate();
      if (handOn && !handReady && !handLandmarker) loadHands();
      else if (handOn && handReady) toast("手をかざしてみて");
    })
    .catch((err) => {
      camReady = false;
      let msg = "カメラを使えませんでした。";
      if (location.protocol !== "https:" && location.hostname !== "localhost") msg += " HTTPSでないとカメラは動きません。写真モードへどうぞ。";
      else msg += " 許可されなかったか、利用できない端末です。写真モードへどうぞ。";
      gateNote.textContent = msg;
      throw err;
    });
}
function stopCamera() {
  if (camStream) { camStream.getTracks().forEach((t) => t.stop()); camStream = null; }
  camReady = false;
}
function flipCamera() {
  Sound.kick();
  const prev = facing;
  facing = facing === "environment" ? "user" : "environment";
  stopCamera();
  startCamera().then(() => toast(facing === "user" ? "内カメラ" : "外カメラ"))
    .catch(() => { facing = prev; toast("切り替えできませんでした"); startCamera().catch(() => {}); });
}

// ===================================================================
// 写真
// ===================================================================
fileInput.addEventListener("change", (e) => {
  const f = e.target.files && e.target.files[0];
  if (!f) return;
  const url = URL.createObjectURL(f);
  const img = new Image();
  img.onload = () => {
    photoImg = img; sourceMode = "photo"; setActive("source", "photo");
    stopCamera(); hideGate(); hideIntro(); toast("写真の上を指で描けます");
    URL.revokeObjectURL(url);
  };
  img.onerror = () => toast("写真を読み込めませんでした");
  img.src = url;
});
function pickPhoto() { fileInput.click(); }

// ===================================================================
// ゲート
// ===================================================================
function showGate() { gate.classList.remove("hidden"); }
function hideGate() { gate.classList.add("hidden"); }
document.getElementById("gateCam").addEventListener("click", () => { Sound.kick(); startCamera().catch(() => {}); });
document.getElementById("gatePhoto").addEventListener("click", () => { Sound.kick(); pickPhoto(); });

// ===================================================================
// 上部・下部 UI
// ===================================================================
function setActive(groupId, value) {
  const attr = groupId === "source" ? "data-src" : "data-mode";
  document.querySelectorAll(`#${groupId} [${attr}]`).forEach((b) => {
    b.classList.toggle("is-active", b.getAttribute(attr) === value);
  });
}
document.getElementById("source").addEventListener("click", (e) => {
  const b = e.target.closest(".src"); if (!b) return;
  const v = b.getAttribute("data-src");
  if (v === "camera") {
    if (camReady) { sourceMode = "camera"; setActive("source", "camera"); }
    else startCamera().catch(() => showGate());
  } else {
    if (photoImg) { sourceMode = "photo"; setActive("source", "photo"); stopCamera(); }
    else pickPhoto();
  }
});
document.getElementById("modes").addEventListener("click", (e) => {
  const b = e.target.closest(".mode"); if (!b) return;
  theme = b.getAttribute("data-mode"); setActive("modes", theme);
  toast({ green: "みどり", aurora: "オーロラ", gold: "ゴールド" }[theme]);
});

document.getElementById("flip").addEventListener("click", () => {
  if (sourceMode !== "camera" || !camReady) { facing = "user"; startCamera().then(() => toast("内カメラ")).catch(() => showGate()); return; }
  flipCamera();
});

document.getElementById("hand").addEventListener("click", () => {
  const btn = document.getElementById("hand");
  handOn = !handOn;
  btn.classList.toggle("on", handOn);
  btn.setAttribute("aria-pressed", handOn ? "true" : "false");
  if (handOn) {
    if (!handLandmarker && camReady) loadHands();
    toast("手で あやつる：オン");
  } else {
    liveHands = [];
    toast("手で あやつる：オフ（指で描けます）");
  }
});

const soundBtn = document.getElementById("sound");
soundBtn.addEventListener("click", () => {
  Sound.kick();
  const on = Sound.toggle();
  soundBtn.classList.toggle("muted", !on);
  soundBtn.setAttribute("aria-pressed", on ? "true" : "false");
  toast(on ? "音オン" : "音オフ");
});

document.getElementById("reset").addEventListener("click", () => { particles.length = 0; liveHands = []; toast("消しました"); });
document.getElementById("save").addEventListener("click", () => {
  try {
    stage.toBlob((blob) => {
      if (!blob) { toast("スクショで保存してね"); return; }
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = "hikari-nazori-" + Date.now() + ".png";
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      toast("画像を保存しました");
    }, "image/png");
  } catch (err) { toast("スクショで保存してね"); }
});

// ===================================================================
// トースト
// ===================================================================
let toastTimer = null;
function toast(msg) {
  toastEl.textContent = msg; toastEl.classList.add("show");
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove("show"), 1700);
}

// ===================================================================
// 音（Web Audio・やさしい音色・素材ファイルなし）
// ===================================================================
const Sound = (() => {
  let actx = null, master = null, send = null, on = true, lastChime = 0;
  const SCALE = [523.25, 587.33, 698.46, 783.99, 880.0, 1046.5];
  function impulse(dur, decay) {
    const rate = actx.sampleRate, len = Math.floor(rate * dur);
    const buf = actx.createBuffer(2, len, rate);
    for (let ch = 0; ch < 2; ch++) { const d = buf.getChannelData(ch); for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay); }
    return buf;
  }
  function init() {
    if (actx) return;
    const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return;
    actx = new AC();
    master = actx.createGain(); master.gain.value = 0.0001; master.connect(actx.destination);
    const conv = actx.createConvolver(); conv.buffer = impulse(1.8, 2.4);
    const wet = actx.createGain(); wet.gain.value = 0.4; conv.connect(wet); wet.connect(master); send = conv;
    master.gain.exponentialRampToValueAtTime(on ? 0.8 : 0.0001, actx.currentTime + 0.6);
  }
  function resume() { if (actx && actx.state === "suspended") actx.resume(); }
  function note(freq, o = {}) {
    if (!actx || !on) return;
    const t = actx.currentTime, dur = o.dur || 0.5, g = actx.createGain();
    const peak = o.gain ?? 0.12;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + (o.attack || 0.012));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    const osc = actx.createOscillator(); osc.type = o.type || "sine";
    osc.frequency.setValueAtTime(freq, t);
    if (o.glide) osc.frequency.exponentialRampToValueAtTime(Math.max(40, freq * o.glide), t + dur);
    osc.connect(g); g.connect(master);
    if (send && o.wet !== 0) { const s = actx.createGain(); s.gain.value = o.wet || 0.6; g.connect(s); s.connect(send); }
    osc.start(t); osc.stop(t + dur + 0.05);
  }
  return {
    kick() { init(); resume(); },
    toggle() {
      on = !on;
      if (actx) { const t = actx.currentTime; master.gain.cancelScheduledValues(t); master.gain.setValueAtTime(Math.max(master.gain.value, 0.0001), t); master.gain.exponentialRampToValueAtTime(on ? 0.8 : 0.0001, t + 0.25); }
      return on;
    },
    chime(speed) {
      if (!actx || !on) return;
      const now = performance.now(); if (now - lastChime < 80) return; lastChime = now;
      const f = SCALE[(Math.random() * SCALE.length) | 0] * (Math.random() < 0.5 ? 1 : 2);
      note(f, { type: "triangle", dur: 0.5, gain: 0.045 + Math.min(speed, 2) * 0.02, attack: 0.005, wet: 0.7 });
    },
    burst() { note(880, { type: "sine", dur: 0.45, gain: 0.16, glide: 0.45, attack: 0.004, wet: 0.8 }); note(1320, { type: "sine", dur: 0.18, gain: 0.06, glide: 0.5, attack: 0.003, wet: 0.5 }); },
    bloom() { note(523.25, { dur: 1.1, gain: 0.12, attack: 0.03, wet: 0.9 }); note(659.25, { dur: 1.1, gain: 0.09, attack: 0.05, wet: 0.9 }); note(783.99, { dur: 1.2, gain: 0.07, attack: 0.07, wet: 0.9 }); },
    gather() { note(392, { dur: 0.6, gain: 0.08, glide: 1.5, attack: 0.04, wet: 0.8 }); },
    calm() { note(196, { dur: 0.9, gain: 0.09, attack: 0.06, wet: 0.8 }); note(261.63, { dur: 0.9, gain: 0.05, attack: 0.08, wet: 0.8 }); }
  };
})();

// ===================================================================
// 起動
// ===================================================================
resize();
requestAnimationFrame(frame);
showGate();
