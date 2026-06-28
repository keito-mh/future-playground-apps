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

// ---- 光バッファ＆ブルーム（AAA風の発光）----
const lightC = document.createElement("canvas");      // 光だけを描く層（全解像度）
const lcx = lightC.getContext("2d");
const bloomC = document.createElement("canvas");       // 低解像度ブルーム
const bcx = bloomC.getContext("2d");
let BW = 0, BH = 0;
let vignette = null;                                   // 光を際立たせる周辺減光

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

// ---- お絵描き（画面に直接なぞる・軌跡は残り、消すボタンでクリア） ----
let drawMode = false;
let hasArt = false;
const artC = document.createElement("canvas"); // 描いた光の軌跡を貯める層（消えない）
const actx = artC.getContext("2d");

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
    // 白飛びを抑え、色味のあるやわらかい光に（上品）
    grd.addColorStop(0, "rgba(255,255,255,0.7)");
    grd.addColorStop(0.16, `hsla(${key},90%,78%,0.5)`);
    grd.addColorStop(0.45, `hsla(${key},85%,62%,0.16)`);
    grd.addColorStop(1, `hsla(${key},80%,58%,0)`);
    g.fillStyle = grd;
    g.fillRect(0, 0, size, size);
    glowCache[key] = c;
  }
  return glowCache[key];
}

// きらめき（star flare）：白い十字の光条＋中心。色は重ねる側に任せる
const flareSprite = (() => {
  const size = 256, c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d"), r = size / 2;
  g.translate(r, r);
  let rg = g.createRadialGradient(0, 0, 0, 0, 0, r * 0.5);
  rg.addColorStop(0, "rgba(255,255,255,0.9)");
  rg.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = rg; g.beginPath(); g.arc(0, 0, r * 0.5, 0, TAU); g.fill();
  g.globalCompositeOperation = "lighter";
  for (const ang of [0, Math.PI / 2]) {
    g.save(); g.rotate(ang);
    const lg = g.createLinearGradient(-r, 0, r, 0);
    lg.addColorStop(0, "rgba(255,255,255,0)");
    lg.addColorStop(0.5, "rgba(255,255,255,0.85)");
    lg.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = lg; g.fillRect(-r, -size * 0.012, size, size * 0.024);
    g.restore();
  }
  return c;
})();

function makeVignette() {
  const c = document.createElement("canvas");
  c.width = W; c.height = H;
  const g = c.getContext("2d");
  const cx = W / 2, cy = H / 2, r = Math.hypot(cx, cy);
  const rg = g.createRadialGradient(cx, cy, r * 0.58, cx, cy, r);
  rg.addColorStop(0, "rgba(0,0,0,0)");
  rg.addColorStop(1, "rgba(0,0,0,0.24)"); // 中心は明るいまま・周辺をほんのり締める（控えめ）
  g.fillStyle = rg; g.fillRect(0, 0, W, H);
  vignette = c;
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
  lightC.width = W; lightC.height = H;
  BW = Math.max(1, W >> 2); BH = Math.max(1, H >> 2); // 1/4解像度ブルーム
  bloomC.width = BW; bloomC.height = BH;
  makeVignette();
  artC.width = W; artC.height = H; // 注：回転時は描いた絵がクリアされます
  hasArt = false;
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
    z: o.z || 0,        // 深度：+で手前(viewer)、-で奥
    vx: o.vx || 0, vy: o.vy || 0, vz: o.vz || 0,
    drag: o.drag ?? 0.95,
    size: o.size || (5 + Math.random() * 7) * DPR,
    grow: o.grow ?? 1,
    hue: o.hue ?? themeHue(),
    life: 1,
    decay: o.decay || (0.012 + Math.random() * 0.012),
    swirl: o.swirl ?? (0.6 + Math.random() * 0.8), // 渦の効き
    orbit: o.orbit || null,
    flare: o.flare || false // きらめき（star flare）を付ける
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
    // 深度：手前/奥へ飛び、だんだん減速
    p.z += p.vz; p.vz *= 0.98;
    p.life -= p.decay;
    if (p.life <= 0) particles.splice(i, 1);
  }
}

function render() {
  // 背景＋周辺減光（光が際立つ）
  ctx.globalCompositeOperation = "source-over"; ctx.globalAlpha = 1;
  ctx.drawImage(bg, 0, 0);
  if (vignette) ctx.drawImage(vignette, 0, 0);

  // --- 光を専用バッファへ（加算）。遠近投影：画面中心が消失点、zで拡大・収束 ---
  lcx.clearRect(0, 0, W, H);
  lcx.globalCompositeOperation = "lighter";
  // 描いた軌跡（消えない層）を合成。ブルームに乗って光る
  if (hasArt) { lcx.globalAlpha = 1; lcx.drawImage(artC, 0, 0); }
  if (handOn) drawHandHints(lcx);
  const VPx = W / 2, VPy = H / 2;
  for (let pass = 0; pass < 2; pass++) {
    const wantNear = pass === 1;
    for (let i = 0; i < particles.length; i++) {
      const p = particles[i];
      if ((p.z >= 0) !== wantNear) continue;
      const ds = Math.max(0.18, Math.min(3.6, 1 + p.z));
      const sx = VPx + (p.x - VPx) * ds;
      const sy = VPy + (p.y - VPy) * ds;
      const sz = p.size * ds * (p.grow ? (0.5 + p.life * 0.9) : 1);
      const al = Math.min(1, p.life * 1.3) * Math.max(0.22, Math.min(1.25, ds * 0.85));
      const g = getGlow(p.hue);
      // 速い粒はモーションストリーク（控えめな尾）
      const spd = Math.hypot(p.vx, p.vy);
      if (spd > 4 * DPR) {
        const st = Math.min(spd * 0.5, sz * 2.2);
        lcx.save();
        lcx.globalAlpha = al * 0.3;
        lcx.translate(sx, sy);
        lcx.rotate(Math.atan2(p.vy, p.vx));
        lcx.drawImage(g, -sz - st, -sz * 0.6, (sz + st) * 2, sz * 1.2);
        lcx.restore();
      }
      lcx.globalAlpha = al;
      lcx.drawImage(g, sx - sz, sy - sz, sz * 2, sz * 2);
      // きらめき（小さく繊細に・近い粒だけ）
      if (p.flare && ds > 0.8) {
        const fr = sz * 1.6;
        lcx.globalAlpha = al * 0.35;
        lcx.drawImage(flareSprite, sx - fr, sy - fr, fr * 2, fr * 2);
      }
    }
  }
  lcx.globalAlpha = 1; lcx.globalCompositeOperation = "source-over";

  // --- ブルーム：1/4解像度に縮小→拡大で柔らかく広がる発光 ---
  bcx.globalCompositeOperation = "source-over";
  bcx.clearRect(0, 0, BW, BH);
  bcx.drawImage(lightC, 0, 0, BW, BH);
  ctx.globalCompositeOperation = "lighter";
  ctx.globalAlpha = 0.7; ctx.drawImage(bloomC, 0, 0, BW, BH, 0, 0, W, H);
  ctx.globalAlpha = 0.32; ctx.drawImage(bloomC, 0, 0, BW, BH, -6 * DPR, -6 * DPR, W + 12 * DPR, H + 12 * DPR);
  // くっきりした光を上に（やや控えめに重ねて上品に）
  ctx.globalAlpha = 0.8; ctx.drawImage(lightC, 0, 0);
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
    const isPoint = ext.index && !ext.middle && !ext.ring && !ext.pinky;
    const isThumbs = ext.thumb && !ext.index && !ext.middle && !ext.ring && !ext.pinky;

    // 手の近づき/遠ざかり（手のひらの大きさの変化）→ 奥行き方向の勢い
    if (st.palmSmooth == null) st.palmSmooth = palmSize;
    const rel = (palmSize - st.palmSmooth) / st.palmSmooth;
    st.palmSmooth += (palmSize - st.palmSmooth) * 0.35;
    const depthBias = Math.max(-0.16, Math.min(0.16, rel * 7));

    // 手をぐっと近づける／引く → 手前・奥へ弾ける
    if (rel > 0.10 && !st.pushing) { burst(palm.x, palm.y, 1.1, 1); Sound.push(); st.pushing = true; }
    if (rel < 0.04) st.pushing = false;
    if (rel < -0.10 && !st.pulling) { burst(palm.x, palm.y, 0.9, -1); Sound.pull(); st.pulling = true; }
    if (rel > -0.04) st.pulling = false;

    // 指先トレイル（伸びている指から光が流れる・奥行きの勢いを反映）
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
          vz: depthBias * 0.4 + (Math.random() - 0.5) * 0.02,
          size: (4 + Math.random() * 5) * DPR, decay: 0.018
        });
      }
      if (sp > 5 && nowMs - st.lastEmit > 110) { Sound.chime(sp / 10); st.lastEmit = nowMs; }
    }

    // 指さし（人差し指だけ）：集中した一筋の光
    if (isPoint) {
      let vx = 0, vy = 0;
      if (st.prev) { vx = L[8].x - st.prev[8].x; vy = L[8].y - st.prev[8].y; }
      pointStream(L[8], vx, vy);
    }
    // サムズアップ：金の星がパッと
    if (isThumbs && !st.wasThumbs) { starBurst(L[4]); Sound.star(); }

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
      burst(pc.x, pc.y, 1.1, 1); // 手前へ弾ける
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
    st.wasOpen = isOpen; st.wasPinch = isPinch; st.wasFist = isFist; st.wasThumbs = isThumbs;
  }
  // 両手なら、手のひらの間に光の橋を架ける
  if (liveHands.length >= 2) lightBridge(liveHands[0].palm, liveHands[1].palm);
  // 見えなくなった手の状態を掃除
  for (const k in handStates) if (!seen[k]) delete handStates[k];
}

// 光バッファ(g2)へ描く。呼び出し側が加算合成にしている前提
function drawHandHints(g2) {
  if (!liveHands.length) return;
  const hueBase = theme === "gold" ? 46 : theme === "aurora" ? 200 : 165;
  const g = getGlow(hueBase);
  for (const hnd of liveHands) {
    const r = hnd.palmSize * 0.9;
    g2.globalAlpha = 0.12;
    g2.drawImage(g, hnd.palm.x - r, hnd.palm.y - r, r * 2, r * 2);
    g2.globalAlpha = 0.5;
    const s = 7 * DPR;
    for (const tp of hnd.tips) g2.drawImage(g, tp.x - s, tp.y - s, s * 2, s * 2);
  }
  g2.globalAlpha = 1;
}

// ===================================================================
// 効果（開く・弾ける・集めた後・鎮める）
// ===================================================================
function bloomFrom(c, size) {
  const hue = themeHue();
  const n = 20;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU + Math.random() * 0.3;
    const sp = (2 + Math.random() * 4) * DPR;
    // 立体的に：手前と奥へ散らす
    const vz = (Math.random() - 0.5) * 0.16;
    addParticle(c.x, c.y, {
      vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, vz,
      size: (5 + Math.random() * 7) * DPR, hue: hue + (Math.random() - 0.5) * 20,
      decay: vz > 0 ? 0.009 : 0.014, // 手前に来る光は残留を長く
      flare: Math.random() < 0.14
    });
  }
  addParticle(c.x, c.y, { size: (size || 60) * 1.1, grow: 0, decay: 0.03, hue });
}
// dir: +1=手前へ飛ぶ / -1=奥へ飛ぶ / 0=平面
function burst(x, y, power, dir = 0) {
  const hue = themeHue();
  const n = Math.floor(16 * power);
  for (let i = 0; i < n; i++) {
    const a = Math.random() * TAU, sp = (1.5 + Math.random() * 5) * power * DPR;
    const vz = dir * (0.05 + Math.random() * 0.14) + (Math.random() - 0.5) * 0.04;
    addParticle(x, y, {
      vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, vz,
      z: dir * 0.05,
      size: (5 + Math.random() * 6) * DPR, hue: hue + (Math.random() - 0.5) * 24,
      decay: dir > 0 ? 0.009 : (dir < 0 ? 0.02 : 0.012), // 手前は残留長め・奥は短め
      flare: Math.random() < 0.16
    });
  }
}
// 指さし（人差し指）：集中した一筋の光（少し手前へ）
function pointStream(tip, vx, vy) {
  for (let k = 0; k < 2; k++) {
    addParticle(tip.x + (Math.random() - 0.5) * 4 * DPR, tip.y + (Math.random() - 0.5) * 4 * DPR, {
      vx: vx * 0.4 + (Math.random() - 0.5) * 0.4 * DPR,
      vy: vy * 0.4 + (Math.random() - 0.5) * 0.4 * DPR,
      vz: 0.02 + Math.random() * 0.02,
      size: (5 + Math.random() * 5) * DPR, decay: 0.014
    });
  }
}
// サムズアップ：金色寄りの星がパッと舞う
function starBurst(c) {
  for (let i = 0; i < 12; i++) {
    const a = Math.random() * TAU, sp = (2 + Math.random() * 4) * DPR;
    addParticle(c.x, c.y, {
      vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 1 * DPR, vz: (Math.random() - 0.3) * 0.1,
      size: (4 + Math.random() * 6) * DPR, hue: 40 + Math.random() * 16, decay: 0.012,
      flare: true
    });
  }
}
// 両手の間に光の橋を架ける
function lightBridge(a, b) {
  const d = Math.hypot(b.x - a.x, b.y - a.y);
  const n = Math.min(10, Math.floor(d / (28 * DPR)) + 1);
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const x = a.x + (b.x - a.x) * t, y = a.y + (b.y - a.y) * t;
    if (Math.random() < 0.5)
      addParticle(x + (Math.random() - 0.5) * 10 * DPR, y + (Math.random() - 0.5) * 10 * DPR, {
        size: (4 + Math.random() * 5) * DPR, decay: 0.03, swirl: 0.2
      });
  }
}
function calm() {
  // 全体をやわらかく早めにフェード（鎮める）
  for (const p of particles) { p.decay = Math.max(p.decay, 0.06); p.orbit = null; }
}

// ===================================================================
// お絵描き（光のペン）：画面をなぞると消えない軌跡が残る
// ===================================================================
function paintStroke(x0, y0, x1, y1, hue) {
  const d = Math.hypot(x1 - x0, y1 - y0);
  const brush = 11 * DPR;
  const step = Math.max(2, brush * 0.34);
  const n = Math.max(1, Math.ceil(d / step));
  const g = getGlow(hue);
  actx.globalCompositeOperation = "lighter";
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const x = x0 + (x1 - x0) * t, y = y0 + (y1 - y0) * t;
    actx.globalAlpha = 0.5;
    actx.drawImage(g, x - brush, y - brush, brush * 2, brush * 2);
  }
  actx.globalAlpha = 1;
  hasArt = true;
}
function paintDot(x, y, hue) {
  const brush = 12 * DPR, g = getGlow(hue);
  actx.globalCompositeOperation = "lighter";
  actx.globalAlpha = 0.6;
  actx.drawImage(g, x - brush, y - brush, brush * 2, brush * 2);
  actx.globalAlpha = 1;
  hasArt = true;
}
function clearArt() {
  actx.clearRect(0, 0, W, H);
  hasArt = false;
}

// ===================================================================
// メインループ
// ===================================================================
function frame() {
  const liveCamera = sourceMode === "camera" && camReady && video.videoWidth;
  const active = liveCamera || dragging || particles.length > 0 || hasArt;
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
  const p = { x: pos.x, y: pos.y, lastT: now, startT: now, moved: 0 };
  if (drawMode) { p.hue = themeHue(); paintDot(pos.x, pos.y, p.hue); Sound.chime(0.5); }
  pointers[e.pointerId] = p;
  dragging = true;
  try { stage.setPointerCapture(e.pointerId); } catch (err) {}
}, { passive: false });

stage.addEventListener("pointermove", (e) => {
  const p = pointers[e.pointerId];
  if (!p) return;
  e.preventDefault();
  const pos = getPos(e);
  const mx = pos.x - p.x, my = pos.y - p.y, d = Math.hypot(mx, my);
  if (drawMode) {
    // 画面をなぞって、消えない光の軌跡を描く
    paintStroke(p.x, p.y, pos.x, pos.y, p.hue);
    if (d > 6) Sound.chime(d / 14);
  } else {
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
  }
  p.x = pos.x; p.y = pos.y; p.moved += d;
}, { passive: false });

function endPointer(e) {
  const p = pointers[e.pointerId];
  if (!p) return;
  e.preventDefault();
  if (!drawMode && p.moved < 10 * DPR && performance.now() - p.startT < 320) { burst(p.x, p.y, 1); Sound.burst(); }
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
  Sound.setTheme(theme);
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

document.getElementById("draw").addEventListener("click", () => {
  const btn = document.getElementById("draw");
  drawMode = !drawMode;
  btn.classList.toggle("on", drawMode);
  btn.setAttribute("aria-pressed", drawMode ? "true" : "false");
  if (drawMode) { Sound.kick(); hideIntro(); toast("画面をなぞって描く（消すボタンでクリア）"); }
  else toast("お絵描き オフ");
});

document.getElementById("reset").addEventListener("click", () => {
  particles.length = 0; liveHands = [];
  clearArt();
  toast(drawMode ? "絵を消しました" : "消しました");
});
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
  let actx = null, master = null, send = null, on = true, lastChime = 0, pad = null;
  // 色テーマごとに音階・音色・残響を変える（壮大さのため低音/和音を厚めに）
  const PAL = {
    green: { scale: [523.25, 587.33, 698.46, 783.99, 880.0, 1046.5], type: "sine", wet: 0.6, chord: [261.63, 392.0, 523.25, 659.25], root: 261.63 },
    aurora: { scale: [587.33, 659.25, 739.99, 880.0, 987.77, 1174.66], type: "sine", wet: 0.85, chord: [293.66, 440.0, 587.33, 739.99], root: 293.66 },
    gold: { scale: [523.25, 587.33, 659.25, 783.99, 880.0, 1046.5], type: "triangle", wet: 0.55, chord: [261.63, 392.0, 523.25, 659.25, 783.99], root: 196.0 }
  };
  let pal = PAL.green;

  function impulse(dur, decay) {
    const rate = actx.sampleRate, len = Math.floor(rate * dur);
    const buf = actx.createBuffer(2, len, rate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        // やわらかな立ち上がり＋長い減衰の壮大なリバーブ
        const env = Math.pow(1 - i / len, decay) * (1 - Math.exp(-i / (rate * 0.02)));
        d[i] = (Math.random() * 2 - 1) * env;
      }
    }
    return buf;
  }
  function init() {
    if (actx) return;
    const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return;
    actx = new AC();
    master = actx.createGain(); master.gain.value = 0.0001;
    const comp = actx.createDynamicsCompressor(); // 全体をまとめて上品に
    comp.threshold.value = -18; comp.ratio.value = 3; comp.attack.value = 0.005; comp.release.value = 0.25;
    master.connect(comp); comp.connect(actx.destination);
    const conv = actx.createConvolver(); conv.buffer = impulse(3.6, 2.6); // 長い残響
    const wet = actx.createGain(); wet.gain.value = 0.7; conv.connect(wet); wet.connect(master); send = conv;
    master.gain.exponentialRampToValueAtTime(on ? 0.7 : 0.0001, actx.currentTime + 0.8);
  }
  function resume() { if (actx && actx.state === "suspended") actx.resume(); }

  // リッチな1音：デチューンを重ねた発振＋任意のサブ＋ローパス＋ステレオ＋残響
  function voice(freq, o = {}) {
    if (!actx || !on) return;
    const t = actx.currentTime + (o.when || 0), dur = o.dur || 1, peak = o.gain ?? 0.1;
    const g = actx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + (o.attack || 0.02));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    const lp = actx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = o.bright || 2600; lp.Q.value = 0.3;
    g.connect(lp);
    let out = lp;
    if (actx.createStereoPanner) { const pan = actx.createStereoPanner(); pan.pan.value = o.pan != null ? o.pan : (Math.random() * 1.1 - 0.55); lp.connect(pan); out = pan; }
    out.connect(master);
    if (send) { const s = actx.createGain(); s.gain.value = o.wet ?? 0.5; out.connect(s); s.connect(send); }
    const voices = o.voices || 3, det = o.detune ?? 7;
    for (let i = 0; i < voices; i++) {
      const osc = actx.createOscillator(); osc.type = o.type || "sine";
      osc.frequency.setValueAtTime(freq, t);
      osc.detune.setValueAtTime((i - (voices - 1) / 2) * det, t);
      if (o.glide) osc.frequency.exponentialRampToValueAtTime(Math.max(30, freq * o.glide), t + dur);
      osc.connect(g); osc.start(t); osc.stop(t + dur + 0.1);
    }
    if (o.sub) {
      const sub = actx.createOscillator(); sub.type = "sine"; sub.frequency.setValueAtTime(freq / 2, t);
      const sg = actx.createGain(); sg.gain.setValueAtTime(0.0001, t);
      sg.gain.exponentialRampToValueAtTime(peak * 0.7, t + (o.attack || 0.02));
      sg.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      sub.connect(sg); sg.connect(lp); sub.start(t); sub.stop(t + dur + 0.1);
    }
  }

  // 壮大さの土台：ゆっくり揺れるアンビエントの和音ドローン
  function startPad() {
    if (pad || !actx) return;
    const g = actx.createGain();
    g.gain.setValueAtTime(0.0001, actx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.03, actx.currentTime + 5);
    const lp = actx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 480; lp.Q.value = 0.5;
    const lfo = actx.createOscillator(); lfo.frequency.value = 0.05;
    const lg = actx.createGain(); lg.gain.value = 260; lfo.connect(lg); lg.connect(lp.frequency); lfo.start();
    g.connect(lp); lp.connect(master);
    const s = actx.createGain(); s.gain.value = 0.9; lp.connect(s); s.connect(send);
    const oscs = [];
    const base = pal.root / 2;
    [base, base * 1.5, base * 2].forEach((f) => [-9, 9].forEach((d) => {
      const o = actx.createOscillator(); o.type = "sawtooth"; o.frequency.value = f; o.detune.value = d;
      o.connect(g); o.start(); oscs.push(o);
    }));
    pad = { g, lp, lfo, oscs };
  }
  function retunePad() {
    if (!pad || !actx) return;
    const base = pal.root / 2, fs = [base, base * 1.5, base * 2];
    let idx = 0;
    for (let i = 0; i < fs.length; i++) for (let d = 0; d < 2; d++) {
      if (pad.oscs[idx]) pad.oscs[idx].frequency.setTargetAtTime(fs[i], actx.currentTime, 0.5);
      idx++;
    }
  }

  return {
    kick() { init(); resume(); startPad(); },
    setTheme(t) { pal = PAL[t] || PAL.green; retunePad(); },
    toggle() {
      on = !on;
      if (actx) { const t = actx.currentTime; master.gain.cancelScheduledValues(t); master.gain.setValueAtTime(Math.max(master.gain.value, 0.0001), t); master.gain.exponentialRampToValueAtTime(on ? 0.7 : 0.0001, t + 0.3); }
      return on;
    },
    // なぞり/指先：澄んだ鈴。1発振でも長い残響で上品に
    chime(speed) {
      if (!actx || !on) return;
      const now = performance.now(); if (now - lastChime < 95) return; lastChime = now;
      const f = pal.scale[(Math.random() * pal.scale.length) | 0] * (Math.random() < 0.4 ? 2 : 1);
      voice(f, { type: pal.type, dur: 1.0, gain: 0.035 + Math.min(speed, 2) * 0.012, attack: 0.006, wet: Math.min(1, pal.wet + 0.25), voices: 1, bright: 5200 });
    },
    // 弾ける：きらめく高音＋深いサブ
    burst() {
      voice(pal.scale[4], { type: "sine", dur: 1.3, gain: 0.11, glide: 0.7, attack: 0.004, wet: pal.wet + 0.2, voices: 2, bright: 4400 });
      voice(pal.root, { type: "sine", dur: 0.8, gain: 0.10, attack: 0.004, wet: 0.35, voices: 1, sub: true, bright: 1100 });
    },
    // ひらく：壮大な和音の立ち上がり
    bloom() {
      pal.chord.forEach((f, i) => voice(f, { type: pal.type, dur: 2.6, gain: 0.085 - i * 0.012, attack: 0.12 + i * 0.05, wet: pal.wet + 0.25, voices: 3, sub: i === 0, bright: 2600, when: i * 0.04 }));
    },
    gather() { voice(pal.root * 2, { type: pal.type, dur: 1.0, gain: 0.07, glide: 1.6, attack: 0.05, wet: pal.wet + 0.2, voices: 2, bright: 3200 }); },
    calm() { voice(pal.root / 2, { type: "sine", dur: 1.8, gain: 0.10, attack: 0.12, wet: pal.wet + 0.2, voices: 2, sub: true, bright: 1300 }); voice(pal.root, { type: "sine", dur: 1.6, gain: 0.06, attack: 0.18, wet: pal.wet + 0.2, voices: 2, bright: 1600 }); },
    push() { voice(pal.root, { type: pal.type, dur: 1.0, gain: 0.12, glide: 2.0, attack: 0.03, wet: pal.wet + 0.2, voices: 3, sub: true, bright: 2400 }); },
    pull() { voice(pal.root * 2, { type: "sine", dur: 1.1, gain: 0.08, glide: 0.45, attack: 0.03, wet: pal.wet + 0.3, voices: 2, bright: 3600 }); },
    star() { for (let i = 0; i < 4; i++) voice(pal.scale[i] * 2, { type: "triangle", dur: 0.9, gain: 0.06, attack: 0.004, wet: pal.wet + 0.2, voices: 2, bright: 5200, when: i * 0.08 }); }
  };
})();

// ===================================================================
// 起動
// ===================================================================
resize();
requestAnimationFrame(frame);
showGate();
