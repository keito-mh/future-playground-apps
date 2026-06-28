/* ぷるぷるゼリー
 * Canvas 2D の擬似ソフトボディ（リング状のばねメッシュ）で、
 * タップ＝ぷにっ / ドラッグ＝ぐにーっ / 離す＝ぷるん / シェイク＝ぷるぷる を表現する。
 * 触り方の傾向に応じて色・泡・光の粒・揺れ方が育ち、最後に「自分だけのゼリー」が完成する。
 */
(() => {
  "use strict";

  const canvas = document.getElementById("stage");
  const ctx = canvas.getContext("2d", { alpha: false });
  const wrap = document.getElementById("wrap");
  const intro = document.getElementById("intro");
  const meterWrap = document.getElementById("meterWrap");
  const meterFill = document.querySelector("#meter i");
  const soundBtn = document.getElementById("sound");
  const resetBtn = document.getElementById("reset");
  const jiggleBtn = document.getElementById("jiggle");
  const musicBtn = document.getElementById("music");
  const finishBtn = document.getElementById("finish");
  const resultEl = document.getElementById("result");
  const resultName = document.querySelector(".resultName");
  const resultDesc = document.querySelector(".resultDesc");
  const againBtn = document.getElementById("again");
  const remakeBtn = document.getElementById("remake");

  // ---- キャンバスサイズ ----
  let W = 0, H = 0, DPR = 1;
  function resize() {
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth;
    H = window.innerHeight;
    canvas.width = Math.round(W * DPR);
    canvas.height = Math.round(H * DPR);
    canvas.style.width = W + "px";
    canvas.style.height = H + "px";
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    layout();
  }

  // ---- ゼリー本体（リングばねメッシュ）----
  const N = 56;            // 輪郭の点の数
  const ang = new Float32Array(N);
  const r = new Float32Array(N);   // 静止半径からの変位
  const v = new Float32Array(N);   // 変位の速度
  const rest = new Float32Array(N); // いま目指す形（押し込み/伸びをここに入れる）
  for (let i = 0; i < N; i++) ang[i] = (i / N) * Math.PI * 2;

  let cx = 0, cy = 0;     // 中央
  let R = 120;            // 基本半径
  let baseY = 0;          // 設置面（影の位置）
  let extent = R;         // いちばん外側までの距離（伸び対応の描画用）

  // 全体オフセット（ドラッグでぬるっと付いてくる）
  let ox = 0, oy = 0, ovx = 0, ovy = 0;
  // 全体のスカッシュ（縦つぶれ / 横ひろがり）
  let squash = 0, squashV = 0;
  // にじみ用の脈動位相
  let breathe = 0;

  function layout() {
    cx = W / 2;
    R = Math.max(86, Math.min(W, H) * 0.3);
    cy = H * 0.44;
    baseY = cy + R * 1.02;
  }

  // ---- 泡・光の粒 ----
  const bubbles = [];   // 中の泡（透明な丸）
  const sparks = [];    // 中のきらきら粒
  const ripples = [];   // 背景の波紋スタンプ
  const floaters = [];  // 完成時にふわっと浮くもの

  function addBubble() {
    bubbles.push({
      a: Math.random() * Math.PI * 2,
      d: Math.random() * 0.78,           // 中心からの距離（0..1）
      rad: 3 + Math.random() * 9,
      rise: 0.04 + Math.random() * 0.06, // 上昇速度
      wob: Math.random() * Math.PI * 2,
      ws: 0.6 + Math.random() * 0.8,
    });
  }
  function addSpark() {
    sparks.push({
      a: Math.random() * Math.PI * 2,
      d: Math.random() * 0.82,
      rad: 1 + Math.random() * 2.2,
      tw: Math.random() * Math.PI * 2,
      ts: 1.5 + Math.random() * 2.5,
      drift: (Math.random() - 0.5) * 0.3,
    });
  }
  for (let i = 0; i < 5; i++) addBubble();

  // ---- ゼリーの「個性」（触るほど育つ）----
  const personality = {
    hue: 200,        // 色相
    accent: 230,     // もう一色（二色グラデ・きみだけの配色に）
    sat: 62,         // 彩度
    light: 72,       // 明るさ
    alpha: 0.5,      // 透明感（小さいほど澄む）
    rainbow: 0,      // 虹色寄り（0..1）
    milky: 0,        // ミルキー寄り（0..1）
    glow: 0.3,       // 光り方（0..1）
    wob: 1,          // 揺れやすさ（もちもちで下がる）
    lobe: 0,         // 輪郭のくせ（0..1 触るほど自分だけの形に）
    star: 0,         // 光の粒が星形になる度合い（0..1）
  };
  // 目標値（じわっと近づく）
  const target = Object.assign({}, personality);

  // ---- きみだけの輪郭（低周波のうねり。触り方で形がちがってくる）----
  const shapeOff = new Float32Array(N);   // 現在の輪郭くせ
  const shapeTgt = new Float32Array(N);   // 目標の輪郭くせ
  let lobeA = 3, lobeB = 2, phA = 0, phB = 0;
  function updateTraits() {
    lobeA = 3 + (stats.drag % 3);          // 3..5
    lobeB = 2 + (stats.shake % 4);         // 2..5
    phA = stats.tap * 0.7 + stats.combo * 0.4;
    phB = stats.longpress * 0.9 + stats.shake * 0.5;
  }

  // ---- 操作の傾向カウント ----
  const stats = { tap: 0, drag: 0, longpress: 0, shake: 0, combo: 0 };
  let growth = 0;          // ぷるぷるメーター（0..1）
  let finished = false;    // 完成済みか
  let finishReady = false; // 完成ボタン表示済みか
  let lastTapTime = 0;
  let trembleAmp = 0;      // シェイク中の細かい震え（止めると余韻を残して減衰）
  let beatFlash = 0;       // 音楽の拍に合わせた発光（毎拍たかまり減衰）

  // ====================================================================
  //  揺らす系のインパルス
  // ====================================================================

  // 指定角度を中心に、内側へ「ぷにっ」と押し込む
  function poke(theta, strength, spread) {
    spread = spread || 0.9;
    for (let i = 0; i < N; i++) {
      let dA = ang[i] - theta;
      while (dA > Math.PI) dA -= Math.PI * 2;
      while (dA < -Math.PI) dA += Math.PI * 2;
      const w = Math.exp(-(dA * dA) / (2 * spread * spread));
      v[i] -= strength * w;        // マイナス＝内側へ
    }
  }

  // 全体がぷるぷる震える（シェイク / ぷるぷるボタン）
  function jiggle(power) {
    power = power || 1;
    const phase = Math.random() * Math.PI * 2;
    const lobes = 3 + Math.floor(Math.random() * 4);   // 細かいさざ波で「プルルルン」
    for (let i = 0; i < N; i++) {
      v[i] += Math.sin(ang[i] * lobes + phase) * 9 * power;
      v[i] += (Math.random() - 0.5) * 5 * power;
    }
    ovx += (Math.random() - 0.5) * 60 * power;
    ovy += (Math.random() - 0.5) * 60 * power;
    // 震えをためる（シェイクを続けると持続、止めると余韻でゆっくり収まる）
    trembleAmp = Math.min(11, trembleAmp + 5 * power);
  }

  // 全体がふくらんで弾む（長押し離し）
  function bounce(power) {
    for (let i = 0; i < N; i++) v[i] += 14 * power;
    squashV -= 0.9 * power;
    ovy -= 80 * power;
  }

  // 背景の波紋スタンプ
  function stampRipple(x, y, tint) {
    ripples.push({ x, y, r: 6, max: 90 + Math.random() * 60, life: 1, tint });
  }

  // ====================================================================
  //  入力処理
  // ====================================================================
  let active = false;        // ポインタが押されているか
  let grabbed = false;       // ゼリーに触れて掴んでいるか（外側スタートは掴まない）
  let mode = null;           // "tap" | "drag" | "long"
  let downX = 0, downY = 0, downT = 0;
  let curX = 0, curY = 0;
  let moved = 0;
  let longTimer = 0;
  let longHeld = false;
  let pid = null;
  let dragSpeed = 0;         // 直近のドラッグ速度（フリックの判定に使う）

  function localPoint(e) {
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  // その座標がゼリーの内側か（変形・うねりも考慮、少し甘め）
  function insideJelly(x, y) {
    const dx = x - (cx + ox), dy = y - (cy + oy);
    const a = Math.atan2(dy, dx);
    let idx = Math.round(((a + Math.PI * 2) % (Math.PI * 2)) / (Math.PI * 2) * N) % N;
    const sx = 1 + squash, sy = 1 - squash;
    const rad = R + r[idx] + shapeOff[idx];
    const ex = Math.cos(a) * rad * sx, ey = Math.sin(a) * rad * sy;
    return Math.hypot(dx, dy) <= Math.hypot(ex, ey) * 1.1 + 14;
  }

  function onDown(e) {
    if (finished) return;
    if (pid !== null) return;
    pid = e.pointerId;
    try { canvas.setPointerCapture(pid); } catch (_) {}
    hideIntro();
    active = true;
    moved = 0;
    longHeld = false;
    mode = "tap";
    const p = localPoint(e);
    downX = curX = p.x;
    downY = curY = p.y;
    downT = performance.now();
    grabbed = insideJelly(p.x, p.y);
    if (!grabbed) {
      // ゼリーの外から押した時は本体に触らない（背景に小さな波紋だけ）
      stampRipple(p.x, p.y, hueColor(0.25));
      return;
    }
    // 押した瞬間に軽くぷにっ（あとは押している間ぐっと凹む）
    const theta = Math.atan2(p.y - (cy + oy), p.x - (cx + ox));
    poke(theta, 4, 0.6);
    buzz(7);
    touchSound("press");
    longTimer = window.setTimeout(() => {
      if (active && grabbed && moved < 16) {
        mode = "long";
        longHeld = true;
        target.alpha = Math.max(0.28, target.alpha - 0.05);
        touchSound("long");
      }
    }, 280);
  }

  function onMove(e) {
    if (!active || e.pointerId !== pid) return;
    const p = localPoint(e);
    const dx = p.x - curX, dy = p.y - curY;
    moved += Math.hypot(dx, dy);
    dragSpeed = dragSpeed * 0.6 + Math.hypot(dx, dy) * 0.4;
    curX = p.x;
    curY = p.y;
    if (grabbed && mode !== "long" && moved > 16) mode = "drag";
  }

  function onUp(e) {
    if (e.pointerId !== pid) return;
    try { canvas.releasePointerCapture(pid); } catch (_) {}
    pid = null;
    if (!active) return;
    active = false;
    window.clearTimeout(longTimer);
    if (!grabbed) { mode = null; return; }   // 外側スタートは本体に作用しない
    const held = performance.now() - downT;

    if (mode === "drag") {
      registerDrag();
      // 離した瞬間：ばねでぷるんと戻る。素早く引いた（フリック）ほど大きく弾む
      const flick = Math.min(1.1, dragSpeed * 0.08);
      jiggle(0.25 + flick * 0.6);
      buzz(14 + Math.round(flick * 14));
      touchSound("drag");
    } else if (mode === "long" && longHeld) {
      registerLong();
      bounce(1);
      stampRipple(cx + ox, baseY, hueColor(0.5));
      buzz(22);
      touchSound("long");
    } else {
      registerTap(held);
      // 離した瞬間：押し込んだ所が外へぷるんと跳ね返る（長く押すほど強く）
      const theta = Math.atan2(curY - (cy + oy), curX - (cx + ox));
      const popStr = 7 + Math.min(8, held / 36);
      poke(theta, -popStr, 0.55);   // マイナス＝外向きに弾ける
      squashV -= 0.28 + Math.min(0.25, held / 800);
      buzz(13);
      stampRipple(curX, curY, hueColor(0.4));
      spawnPop(curX, curY);
      touchSound("tap");
    }
    dragSpeed = 0;
    mode = null;
  }

  // ---- 操作ごとの「育ち」 ----
  function bumpGrowth(amount) {
    if (finished) return;
    growth = Math.min(1, growth + amount);
    meterWrap.classList.add("show");
    meterFill.style.width = (growth * 100).toFixed(1) + "%";
    if (!finishReady && (growth >= 1 || totalTouches() >= 16)) {
      finishReady = true;
      finishBtn.hidden = false;
    }
  }
  function totalTouches() {
    return stats.tap + stats.drag + stats.longpress + stats.shake;
  }

  function registerTap(held) {
    stats.tap++;
    const now = performance.now();
    if (now - lastTapTime < 420) {
      stats.combo++;
      // 連続タップ：きらきら粒（星）が増える
      target.glow = Math.min(1, target.glow + 0.05);
      target.star = Math.min(1, target.star + 0.06);
      if (sparks.length < 30) addSpark();
    }
    lastTapTime = now;
    // タップ：明るいソーダ系へ、泡が増える
    target.hue = wrapHue(target.hue + (185 - target.hue) * 0.04 + 3);
    target.accent = wrapHue(target.hue + 22);   // ソーダのハイライト色（控えめな二色）
    target.light = Math.min(80, target.light + 0.6);
    target.milky = Math.max(0, target.milky - 0.02);
    if (bubbles.length < 30 && Math.random() < 0.8) addBubble();
    growTraits();
    bumpGrowth(0.05);
  }

  function registerDrag() {
    stats.drag++;
    // ドラッグ：もちもち（戻りが遅い）、ミルキー系へ
    target.milky = Math.min(1, target.milky + 0.08);
    target.wob = Math.max(0.62, target.wob - 0.03);
    target.hue = wrapHue(target.hue + (335 - target.hue) * 0.015);
    target.accent += (target.hue - target.accent) * 0.2;  // 単色ミルキー寄り
    target.sat = Math.max(40, target.sat - 1.2);
    target.star = Math.max(0, target.star - 0.02);
    growTraits();
    bumpGrowth(0.06);
  }

  function registerLong() {
    stats.longpress++;
    // 長押し：透明感が増え、静かな光り方へ
    target.alpha = Math.max(0.24, target.alpha - 0.04);
    target.sat = Math.max(38, target.sat - 1.5);
    target.glow = Math.max(0.15, target.glow - 0.02);
    target.accent += (target.hue - target.accent) * 0.15;  // 静かな単色
    growTraits();
    bumpGrowth(0.06);
  }

  function registerShake() {
    stats.shake++;
    // シェイク：色が混ざり、虹色寄りに（二色グラデが大きく開く）
    target.rainbow = Math.min(1, target.rainbow + 0.06);
    target.hue = wrapHue(target.hue + 12);
    target.accent = wrapHue(target.hue + 64);
    target.glow = Math.min(1, target.glow + 0.02);
    growTraits();
    bumpGrowth(0.045);
  }

  // 触るほど「自分だけの形」が育つ（輪郭のくせを少しずつ強める）
  function growTraits() {
    target.lobe = Math.min(0.55, totalTouches() / 36);
    updateTraits();
  }

  // ---- タップ時に泡がふわっと出る ----
  function spawnPop(x, y) {
    const la = Math.atan2(y - (cy + oy), x - (cx + ox));
    const ld = Math.min(0.85, Math.hypot(x - (cx + ox), y - (cy + oy)) / R);
    for (let k = 0; k < 3; k++) {
      bubbles.push({
        a: la + (Math.random() - 0.5) * 0.5,
        d: Math.max(0.1, ld - Math.random() * 0.2),
        rad: 2 + Math.random() * 5,
        rise: 0.08 + Math.random() * 0.06,
        wob: Math.random() * Math.PI * 2,
        ws: 0.8 + Math.random() * 0.8,
      });
    }
    while (bubbles.length > 36) bubbles.shift();
  }

  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerup", onUp);
  canvas.addEventListener("pointercancel", onUp);
  canvas.addEventListener("contextmenu", (e) => e.preventDefault());

  // ====================================================================
  //  シェイク（加速度センサー）
  // ====================================================================
  let lastAcc = { x: 0, y: 0, z: 0 };
  let shakeCooldown = 0;
  function handleMotion(e) {
    const a = e.accelerationIncludingGravity || e.acceleration;
    if (!a) return;
    const dx = (a.x || 0) - lastAcc.x;
    const dy = (a.y || 0) - lastAcc.y;
    const dz = (a.z || 0) - lastAcc.z;
    lastAcc = { x: a.x || 0, y: a.y || 0, z: a.z || 0 };
    const delta = Math.hypot(dx, dy, dz);
    const now = performance.now();
    // 軽い揺れでも反応（しきい値低め）。連発しすぎないようクールダウン。
    if (delta > 7 && now > shakeCooldown && !finished) {
      shakeCooldown = now + 220;
      hideIntro();
      jiggle(Math.min(1.4, delta / 16));
      registerShake();
      buzz(10);
      touchSound("shake");
    }
  }
  function enableMotion() {
    const DM = window.DeviceMotionEvent;
    if (DM && typeof DM.requestPermission === "function") {
      // iOS：ユーザー操作内で許可要求（ぷるぷるボタンから呼ぶ）
      DM.requestPermission().then((s) => {
        if (s === "granted") window.addEventListener("devicemotion", handleMotion);
      }).catch(() => {});
    } else if (DM) {
      window.addEventListener("devicemotion", handleMotion);
    }
  }
  // 許可不要な端末では即購読。iOS は最初のボタン操作で要求。
  if (window.DeviceMotionEvent && typeof window.DeviceMotionEvent.requestPermission !== "function") {
    enableMotion();
  }

  // ====================================================================
  //  ボタン
  // ====================================================================
  let motionAsked = false;
  jiggleBtn.addEventListener("click", () => {
    if (finished) return;
    if (!motionAsked) { enableMotion(); motionAsked = true; }
    hideIntro();
    jiggle(1);
    registerShake();
    buzz(12);
    touchSound("shake");
  });

  finishBtn.addEventListener("click", doFinish);
  resetBtn.addEventListener("click", () => reset(false));
  remakeBtn.addEventListener("click", () => reset(true));
  againBtn.addEventListener("click", () => {
    // 完成画面を閉じて、そのままのゼリーで遊び続ける
    resultEl.classList.remove("show");
    setTimeout(() => { resultEl.hidden = true; }, 500);
    finished = false;
  });

  function hideIntro() {
    if (!intro.classList.contains("hide")) intro.classList.add("hide");
  }

  // ====================================================================
  //  完成演出
  // ====================================================================
  let finishPhase = 0;   // 0=なし 1=ぎゅっ 2=ぷるん 3=余韻
  let finishT = 0;

  function doFinish() {
    if (finished) return;
    finished = true;
    finishBtn.hidden = true;
    jiggleBtn.style.opacity = "0";
    jiggleBtn.style.pointerEvents = "none";
    finishPhase = 1;
    finishT = performance.now();
    buzz([0, 18, 60, 40]);
  }

  function runFinish(now) {
    const t = now - finishT;
    if (finishPhase === 1) {
      // ぎゅっと縮む
      squash = Math.min(0.42, squash + 0.02);
      for (let i = 0; i < N; i++) v[i] -= 0.6;
      if (t > 360) { finishPhase = 2; finishT = now; bigBloom(); }
    } else if (finishPhase === 2) {
      // 大きくぷるん
      if (t < 20) {
        for (let i = 0; i < N; i++) v[i] += 26;
        squashV -= 1.4;
        for (let k = 0; k < 10; k++) addSpark();
      }
      if (t > 520) { finishPhase = 3; finishT = now; showResult(); }
    }
  }

  // 泡・粒がふわっと浮く＋背景に光
  function bigBloom() {
    floaters.length = 0;
    const c = bubbles.concat(sparks);
    for (let i = 0; i < Math.min(26, c.length + 12); i++) {
      floaters.push({
        x: cx + ox + (Math.random() - 0.5) * R * 1.4,
        y: cy + oy + (Math.random() - 0.5) * R * 1.2,
        vy: -(0.4 + Math.random() * 1.1),
        vx: (Math.random() - 0.5) * 0.5,
        rad: 2 + Math.random() * 7,
        life: 1,
        spark: Math.random() < 0.5,
      });
    }
    for (let k = 0; k < 3; k++) {
      ripples.push({ x: cx + ox, y: cy + oy, r: 20, max: Math.max(W, H) * 0.9, life: 1, tint: hueColor(0.5), big: true });
    }
  }

  // ---- 完成タイプの判定 ----
  function decideType() {
    const s = stats;
    const scores = {
      kira: s.combo * 1.6 + s.tap * 0.2 + personality.glow * 4,
      niji: s.shake * 1.4 + personality.rainbow * 6,
      mochi: s.drag * 1.5 + personality.milky * 5,
      toumei: s.longpress * 1.6 + (0.5 - personality.alpha) * 8,
      puru: s.tap * 1.0,
    };
    let best = "puru", bv = -Infinity;
    for (const k in scores) if (scores[k] > bv) { bv = scores[k]; best = k; }

    const names = {
      puru: ["ぷるぷるソーダ", "ぽよぽよラムネ", "ふるふるサイダー"],
      mochi: ["もちもちミルク", "のびのびミント", "むにむにミルク"],
      kira: ["きらきらラムネ", "ぴかぴかピーチ", "きらりんソーダ"],
      niji: ["にじいろぷるん", "ゆらゆらレインボー", "なないろしずく"],
      toumei: ["とうめいしずく", "すきとおるゼリー", "しずかなしずく"],
    };
    const descs = {
      puru: "よく揺れて、明るくて、泡いっぱい。",
      mochi: "ゆっくり戻る、ミルキーでまある〜い。",
      kira: "光の粒がいっぱい。ふちまできらきら。",
      niji: "色がまざって、ゆらゆらにじいろ。",
      toumei: "すきとおって、しずかにきれい。",
    };
    const list = names[best];
    return { name: list[Math.floor(Math.random() * list.length)], desc: descs[best] };
  }

  function showResult() {
    const t = decideType();
    resultName.textContent = t.name;
    resultDesc.textContent = t.desc;
    resultEl.hidden = false;
    // 反映猶予を1フレーム
    requestAnimationFrame(() => resultEl.classList.add("show"));
    blip(720, 0.06);
    setTimeout(() => blip(900, 0.05), 120);
  }

  // ====================================================================
  //  リセット
  // ====================================================================
  function reset(soft) {
    finished = false;
    finishPhase = 0;
    growth = 0;
    finishReady = false;
    stats.tap = stats.drag = stats.longpress = stats.shake = stats.combo = 0;
    for (let i = 0; i < N; i++) { r[i] = 0; v[i] = 0; }
    ox = oy = ovx = ovy = 0;
    squash = squashV = 0;
    bubbles.length = 0;
    sparks.length = 0;
    ripples.length = 0;
    floaters.length = 0;
    for (let i = 0; i < 5; i++) addBubble();
    Object.assign(personality, { hue: 200, accent: 230, sat: 62, light: 72, alpha: 0.5, rainbow: 0, milky: 0, glow: 0.3, wob: 1, lobe: 0, star: 0 });
    Object.assign(target, personality);
    shapeOff.fill(0);
    shapeTgt.fill(0);
    lobeA = 3; lobeB = 2; phA = 0; phB = 0;
    growth = 0;
    meterFill.style.width = "0%";
    meterWrap.classList.remove("show");
    finishBtn.hidden = true;
    jiggleBtn.style.opacity = "";
    jiggleBtn.style.pointerEvents = "";
    resultEl.classList.remove("show");
    setTimeout(() => { resultEl.hidden = true; }, soft ? 500 : 0);
    if (!soft) resultEl.hidden = true;
    // 出だしのぷるん
    jiggle(0.6);
  }

  // ====================================================================
  //  色ユーティリティ
  // ====================================================================
  function wrapHue(h) { return ((h % 360) + 360) % 360; }
  function hueColor(alphaScale) {
    return `hsla(${personality.hue.toFixed(0)},${personality.sat}%,${personality.light}%,${(personality.alpha * (alphaScale || 1)).toFixed(3)})`;
  }
  // 個性を目標値へじわっと近づける
  function easePersonality() {
    const k = 0.05;
    personality.sat += (target.sat - personality.sat) * k;
    personality.light += (target.light - personality.light) * k;
    personality.alpha += (target.alpha - personality.alpha) * k;
    personality.rainbow += (target.rainbow - personality.rainbow) * k;
    personality.milky += (target.milky - personality.milky) * k;
    personality.glow += (target.glow - personality.glow) * k;
    personality.wob += (target.wob - personality.wob) * k;
    personality.lobe += (target.lobe - personality.lobe) * k;
    personality.star += (target.star - personality.star) * k;
    // 色相は最短経路で
    personality.hue = wrapHue(personality.hue + shortHue(target.hue - personality.hue) * k);
    personality.accent = wrapHue(personality.accent + shortHue(target.accent - personality.accent) * k);

    // きみだけの輪郭をゆっくり育てる（ドーム型を崩さないごく控えめなうねり）
    const amp = personality.lobe * R * 0.035;
    for (let i = 0; i < N; i++) {
      shapeTgt[i] = amp * (0.62 * Math.sin(ang[i] * lobeA + phA) + 0.38 * Math.sin(ang[i] * lobeB + phB));
      shapeOff[i] += (shapeTgt[i] - shapeOff[i]) * 0.04;
    }
  }
  function shortHue(dh) {
    while (dh > 180) dh -= 360;
    while (dh < -180) dh += 360;
    return dh;
  }

  // ====================================================================
  //  物理ステップ
  // ====================================================================
  function physics(dt) {
    const stiff = 300 * personality.wob;   // ばね定数（高いほど速い「プルルルン」）
    const damp = 3.7;                       // 減衰（小さいほど余韻が長い）
    const spread = 0.34;                    // 隣どうしの伝播（波）

    // いま目指す形（rest）を毎フレーム作り直す。ばねはこの形へ向かう。
    rest.fill(0);

    // ドラッグ中：本体は指へほどよく追従し、指の方へ「細い舌」が伸びる。
    // 引っ張った所がふくらむのではなく、くびれて本体の体積は中心に残る。
    if (active && grabbed && mode === "drag") {
      const fx = curX - cx;   // 指（静止中心からの位置）
      const fy = curY - cy;
      // 本体は控えめに付いていく（spring の遅れが弾力に）。出すぎないよう低め。
      const bodyFollow = 0.4;
      ovx += (fx * bodyFollow - ox) * 55 * dt;
      ovy += (fy * bodyFollow - oy) * 55 * dt;
      // 本体のふち〜指までのすき間を「舌」が橋渡しする（伸びすぎない量）
      const lagx = curX - (cx + ox);
      const lagy = curY - (cy + oy);
      const lag = Math.hypot(lagx, lagy);
      const stretchAng = Math.atan2(lagy, lagx);
      const stretchAmt = Math.max(0, Math.min(lag - R * 0.85, R * 0.8));
      for (let i = 0; i < N; i++) {
        let dA = ang[i] - stretchAng;
        while (dA > Math.PI) dA -= Math.PI * 2;
        while (dA < -Math.PI) dA += Math.PI * 2;
        const ad = Math.abs(dA);
        const tip = Math.exp(-(dA * dA) / (2 * 0.34 * 0.34));        // 指へ細く伸びる舌
        const neck = Math.exp(-((ad - 0.62) * (ad - 0.62)) / (2 * 0.34 * 0.34)); // 舌の根元をくびれさせる
        const waist = Math.exp(-((ad - 1.5708) * (ad - 1.5708)) / (2 * 0.55 * 0.55)); // 横をしぼり体積を中心に保つ
        rest[i] = tip * stretchAmt - neck * stretchAmt * 0.42 - waist * stretchAmt * 0.26;
      }
    }
    // タップ（押している間）：接点をぐっと押し込み続ける → 離すと跳ね返る
    else if (active && grabbed && mode === "tap") {
      const theta = Math.atan2(curY - (cy + oy), curX - (cx + ox));
      const held = performance.now() - downT;
      const depth = Math.min(R * 0.45, R * 0.45 * (held / 140));
      for (let i = 0; i < N; i++) {
        let dA = ang[i] - theta;
        while (dA > Math.PI) dA -= Math.PI * 2;
        while (dA < -Math.PI) dA += Math.PI * 2;
        const w = Math.exp(-(dA * dA) / (2 * 0.5 * 0.5));
        rest[i] = -depth * w;          // 接点を凹ませ、反対側は少しふくらむ
        rest[i] += depth * 0.12 * Math.max(0, -Math.cos(dA));
      }
      squashV += (0.06 - squash) * 14 * dt;
    }
    // 長押し中：むにっと沈む
    if (active && grabbed && mode === "long" && longHeld) {
      squashV += (0.26 - squash) * 30 * dt;
      oy += (Math.min(R * 0.18, 22) - oy) * 6 * dt;
    }

    // シェイクの細かい震え（持続中はぷるぷる、止めると余韻を残して減衰）
    if (trembleAmp > 0.04) {
      for (let i = 0; i < N; i++) v[i] += (Math.random() - 0.5) * trembleAmp;
      ovx += (Math.random() - 0.5) * trembleAmp * 1.4;
      ovy += (Math.random() - 0.5) * trembleAmp * 1.4;
      trembleAmp *= Math.exp(-1.9 * dt);
    } else {
      trembleAmp = 0;
    }

    // リングばね（rest の形へ向かう。離すと rest=0 に戻りぷるん）
    for (let i = 0; i < N; i++) {
      const left = r[(i - 1 + N) % N];
      const right = r[(i + 1) % N];
      const neighbor = (left + right) * 0.5 - r[i];
      let f = -stiff * (r[i] - rest[i]) + spread * stiff * neighbor;
      v[i] += f * dt;
      v[i] *= Math.exp(-damp * dt);
      r[i] += v[i] * dt;
    }

    // いちばん外側までの距離（伸びた分の描画グラデを滑らかにするため）
    let mx = 0;
    for (let i = 0; i < N; i++) if (r[i] > mx) mx = r[i];
    extent = R + mx;

    // 全体オフセットのばね戻り（ぷるん）
    if (!(active && grabbed && mode === "drag")) {
      ovx += (-ox) * 130 * dt;
      ovy += (-oy) * 130 * dt;
    }
    ovx *= Math.exp(-5 * dt);
    ovy *= Math.exp(-5 * dt);
    ox += ovx * dt;
    oy += ovy * dt;

    // スカッシュのばね戻り
    if (!(active && mode === "long" && longHeld)) {
      squashV += (-squash) * 120 * dt;
    }
    squashV *= Math.exp(-7 * dt);
    squash += squashV * dt;
    squash = Math.max(-0.4, Math.min(0.5, squash));

    breathe += dt;
  }

  // ====================================================================
  //  描画
  // ====================================================================
  function blobPoint(i, rScale) {
    const breath = Math.sin(breathe * 1.6 + i * 0.5) * R * 0.012;
    const rad = (R + r[i] + breath + shapeOff[i]) * (rScale || 1);
    const sx = 1 + squash;
    const sy = 1 - squash;
    const x = cx + ox + Math.cos(ang[i]) * rad * sx;
    const y = cy + oy + Math.sin(ang[i]) * rad * sy;
    return { x, y };
  }

  function traceBlob(rScale) {
    const pts = [];
    for (let i = 0; i < N; i++) pts.push(blobPoint(i, rScale));
    ctx.beginPath();
    // Catmull-Rom でなめらかな閉曲線
    for (let i = 0; i < N; i++) {
      const p0 = pts[(i - 1 + N) % N];
      const p1 = pts[i];
      const p2 = pts[(i + 1) % N];
      const p3 = pts[(i + 2) % N];
      if (i === 0) ctx.moveTo(p1.x, p1.y);
      const c1x = p1.x + (p2.x - p0.x) / 6;
      const c1y = p1.y + (p2.y - p0.y) / 6;
      const c2x = p2.x - (p3.x - p1.x) / 6;
      const c2y = p2.y - (p3.y - p1.y) / 6;
      ctx.bezierCurveTo(c1x, c1y, c2x, c2y, p2.x, p2.y);
    }
    ctx.closePath();
    return pts;
  }

  function drawBackground() {
    const g = ctx.createLinearGradient(0, 0, 0, H);
    const h = personality.hue;
    // 背景は淡く控えめに（ゼリーの色が映えるよう、彩度は低め・色味は薄く乗せる程度）
    g.addColorStop(0, `hsl(${wrapHue(h + 30)},38%,97%)`);
    g.addColorStop(0.55, `hsl(${wrapHue(h)},30%,95%)`);
    g.addColorStop(1, `hsl(${wrapHue(h - 30)},34%,93%)`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);

    // 淡いふわっとした光
    const rg = ctx.createRadialGradient(cx, cy * 0.82, 0, cx, cy * 0.82, Math.max(W, H) * 0.7);
    rg.addColorStop(0, "hsla(0,0%,100%,0.55)");
    rg.addColorStop(1, "hsla(0,0%,100%,0)");
    ctx.fillStyle = rg;
    ctx.fillRect(0, 0, W, H);
  }

  function drawRipples(dt) {
    for (let i = ripples.length - 1; i >= 0; i--) {
      const rp = ripples[i];
      rp.r += (rp.max - rp.r) * (rp.big ? 2.2 : 3) * dt;
      rp.life -= dt * (rp.big ? 0.6 : 1.1);
      if (rp.life <= 0) { ripples.splice(i, 1); continue; }
      ctx.beginPath();
      ctx.arc(rp.x, rp.y, rp.r, 0, Math.PI * 2);
      ctx.strokeStyle = `hsla(${personality.hue},80%,82%,${(rp.life * 0.5).toFixed(3)})`;
      ctx.lineWidth = rp.big ? 3 : 2;
      ctx.stroke();
    }
  }

  function drawShadow() {
    const w = R * (1.05 + squash * 0.4);
    ctx.save();
    ctx.translate(cx + ox * 0.4, baseY + 6);
    ctx.scale(1, 0.26);
    const sg = ctx.createRadialGradient(0, 0, 0, 0, 0, w);
    sg.addColorStop(0, "rgba(90,140,180,0.32)");
    sg.addColorStop(1, "rgba(90,140,180,0)");
    ctx.fillStyle = sg;
    ctx.beginPath();
    ctx.arc(0, 0, w, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function drawJelly(dt) {
    const h = personality.hue;
    const sat = personality.sat;
    const light = personality.light;
    const alpha = personality.alpha;

    // 影
    drawShadow();

    // 本体
    const pts = traceBlob(1);
    ctx.save();

    // グロー（音楽の拍でふわっと強まる）
    ctx.shadowColor = `hsla(${wrapHue(h)},90%,80%,${0.25 + personality.glow * 0.5 + beatFlash * 0.25})`;
    ctx.shadowBlur = 24 + personality.glow * 36 + beatFlash * 22;

    const ah = personality.accent;
    // 塗り：にじいろ なら円錐風グラデを近似（複数色の放射）
    let fill;
    if (personality.rainbow > 0.05) {
      const rad = R * 1.4;
      fill = ctx.createLinearGradient(cx + ox - rad, cy + oy - rad, cx + ox + rad, cy + oy + rad);
      const rb = personality.rainbow;
      for (let s = 0; s <= 5; s++) {
        const hh = wrapHue(h + (s / 5 - 0.5) * 180 * rb);
        fill.addColorStop(s / 5, `hsla(${hh},${sat}%,${light}%,${alpha})`);
      }
    } else {
      // 伸びた舌が暗くならないよう、コントラストは控えめ＆固定半径
      const fr = R * 1.45;
      fill = ctx.createRadialGradient(
        cx + ox - R * 0.32, cy + oy - R * 0.42, R * 0.12,
        cx + ox, cy + oy, fr
      );
      const milkBoost = personality.milky * 12;
      const edgeA = Math.min(0.86, alpha + 0.26);  // ふちはしっかり色を出して輪郭の浮きを防ぐ
      const midA = Math.min(0.8, alpha + 0.16);
      // 上は明るいツヤ、ふち〜舌はアクセント色（控えめな二色グラデ）
      fill.addColorStop(0, `hsla(${wrapHue(h + 12)},${sat - personality.milky * 16}%,${Math.min(97, light + 18 + milkBoost)}%,${Math.min(0.7, alpha + 0.04)})`);
      fill.addColorStop(0.5, `hsla(${h},${sat + 4}%,${light + 2}%,${midA})`);
      fill.addColorStop(1, `hsla(${wrapHue(ah)},${sat + 8}%,${light - 4}%,${edgeA})`);
    }
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.restore();

    // 中身（泡・粒）はゼリー内にクリップ
    ctx.save();
    traceBlob(0.99);
    ctx.clip();

    // ミルキーな中心の濁り
    if (personality.milky > 0.05) {
      const mg = ctx.createRadialGradient(cx + ox, cy + oy + R * 0.2, 0, cx + ox, cy + oy, R);
      mg.addColorStop(0, `hsla(${h},30%,97%,${0.5 * personality.milky})`);
      mg.addColorStop(1, "hsla(0,0%,100%,0)");
      ctx.fillStyle = mg;
      ctx.fillRect(0, 0, W, H);
    }

    // 立体感：本体の内側だけをふんわり丸く陰影づけ（クールな影で濁らせない）
    const ish = ctx.createRadialGradient(
      cx + ox, cy + oy - R * 0.1, R * 0.45,
      cx + ox, cy + oy + R * 0.1, R * 1.02
    );
    ish.addColorStop(0, "hsla(0,0%,100%,0)");
    ish.addColorStop(0.62, "hsla(0,0%,100%,0)");
    ish.addColorStop(0.86, `hsla(${wrapHue(h)},38%,${Math.max(50, light - 18)}%,0.22)`);
    ish.addColorStop(1, "hsla(0,0%,100%,0)");
    ctx.fillStyle = ish;
    ctx.fillRect(0, 0, W, H);

    // 透過：底の内側に光が抜ける明るいにじみ（白っぽく澄んだ抜け）
    const cg = ctx.createRadialGradient(
      cx + ox, cy + oy + R * 0.6, 0,
      cx + ox, cy + oy + R * 0.6, R * 0.8
    );
    cg.addColorStop(0, `hsla(${wrapHue(h + 12)},85%,96%,${0.4 + personality.glow * 0.2})`);
    cg.addColorStop(1, "hsla(0,0%,100%,0)");
    ctx.fillStyle = cg;
    ctx.fillRect(0, 0, W, H);

    drawBubbles(dt);
    drawSparks(dt);
    ctx.restore();

    // ハイライト（つやつや）
    ctx.save();
    traceBlob(0.99);
    ctx.clip();
    const hl = ctx.createRadialGradient(
      cx + ox - R * 0.34, cy + oy - R * 0.5, 0,
      cx + ox - R * 0.34, cy + oy - R * 0.5, R * 0.8
    );
    hl.addColorStop(0, `rgba(255,255,255,${0.55 + personality.glow * 0.25})`);
    hl.addColorStop(0.4, "rgba(255,255,255,0.12)");
    hl.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = hl;
    ctx.fillRect(0, 0, W, H);
    // 小さな光点
    ctx.beginPath();
    ctx.ellipse(cx + ox - R * 0.4, cy + oy - R * 0.52, R * 0.16, R * 0.1, -0.5, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(255,255,255,0.85)";
    ctx.fill();
    ctx.restore();

    // ふち光り（きらきら / にじいろ / 音楽の拍で強まる）
    traceBlob(1);
    ctx.strokeStyle = `hsla(${wrapHue(h + 20)},90%,92%,${0.4 + personality.glow * 0.5 + beatFlash * 0.25})`;
    ctx.lineWidth = 1.5 + personality.glow * 2 + beatFlash * 1.5;
    ctx.stroke();
  }

  function drawBubbles(dt) {
    const sx = 1 + squash, sy = 1 - squash;
    for (let i = bubbles.length - 1; i >= 0; i--) {
      const b = bubbles[i];
      b.d -= b.rise * dt;          // ゆっくり上昇（中心へ＝上へ）
      b.wob += dt * b.ws;
      if (b.d <= 0.04) {
        // 上まで来たら消えて、たまに新規
        bubbles.splice(i, 1);
        if (bubbles.length < 18 && !finished) addBubble();
        continue;
      }
      const wobX = Math.sin(b.wob) * 4;
      // 泡は中心より少し上に集まるよう、角度は固定だが上昇
      const px = cx + ox + Math.cos(b.a) * R * b.d * sx + wobX;
      const py = cy + oy + Math.sin(b.a) * R * b.d * sy - (1 - b.d) * R * 0.15;
      ctx.beginPath();
      ctx.arc(px, py, b.rad, 0, Math.PI * 2);
      ctx.fillStyle = `hsla(${wrapHue(personality.hue + 15)},60%,98%,0.45)`;
      ctx.fill();
      ctx.beginPath();
      ctx.arc(px - b.rad * 0.3, py - b.rad * 0.3, b.rad * 0.4, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(255,255,255,0.7)";
      ctx.fill();
    }
  }

  function drawSparks(dt) {
    const sx = 1 + squash, sy = 1 - squash;
    const star = personality.star;   // 高いほど粒が星形に
    for (let i = 0; i < sparks.length; i++) {
      const s = sparks[i];
      s.tw += dt * s.ts;
      s.a += s.drift * dt;
      const tw = (Math.sin(s.tw) + 1) * 0.5;
      const px = cx + ox + Math.cos(s.a) * R * s.d * sx;
      const py = cy + oy + Math.sin(s.a) * R * s.d * sy;
      const rad = s.rad * (0.6 + tw * 0.8);
      ctx.fillStyle = `hsla(${wrapHue(personality.hue + 40)},100%,95%,${0.4 + tw * 0.6})`;
      if (star > 0.4) {
        // きらきら：4方向にとがる光の粒
        const len = rad * (1.6 + star * 1.4);
        drawStar(px, py, len, rad * 0.5, s.tw * 0.3);
      } else {
        ctx.beginPath();
        ctx.arc(px, py, rad, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
  // 4方向にのびる光の粒（中心はまるく明るい）
  function drawStar(x, y, len, w, rot) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rot);
    ctx.beginPath();
    for (let k = 0; k < 4; k++) {
      const a = (k / 4) * Math.PI * 2;
      const ax = Math.cos(a), ay = Math.sin(a);
      const px = -Math.sin(a), py = Math.cos(a);
      ctx.moveTo(0, 0);
      ctx.quadraticCurveTo(px * w * 0.5 + ax * len * 0.4, py * w * 0.5 + ay * len * 0.4, ax * len, ay * len);
      ctx.quadraticCurveTo(-px * w * 0.5 + ax * len * 0.4, -py * w * 0.5 + ay * len * 0.4, 0, 0);
    }
    ctx.fill();
    ctx.beginPath();
    ctx.arc(0, 0, w * 0.7, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function drawFloaters(dt) {
    for (let i = floaters.length - 1; i >= 0; i--) {
      const f = floaters[i];
      f.x += f.vx;
      f.y += f.vy;
      f.vy *= 0.99;
      f.life -= dt * 0.35;
      if (f.life <= 0) { floaters.splice(i, 1); continue; }
      ctx.beginPath();
      ctx.arc(f.x, f.y, f.rad, 0, Math.PI * 2);
      if (f.spark) {
        ctx.fillStyle = `hsla(${wrapHue(personality.hue + 40)},100%,94%,${(f.life * 0.8).toFixed(3)})`;
      } else {
        ctx.fillStyle = `hsla(${wrapHue(personality.hue + 15)},70%,97%,${(f.life * 0.6).toFixed(3)})`;
      }
      ctx.fill();
    }
  }

  // ====================================================================
  //  メインループ
  // ====================================================================
  let last = performance.now();
  function frame(now) {
    let dt = (now - last) / 1000;
    last = now;
    if (dt > 0.034) dt = 0.034;   // タブ復帰などで飛ばない＆ばねの安定化

    easePersonality();
    if (musicOn) musicScheduler();
    beatFlash *= Math.exp(-4 * dt);
    if (finishPhase > 0 && finishPhase < 3) runFinish(now);
    physics(dt);

    drawBackground();
    drawRipples(dt);
    drawJelly(dt);
    if (floaters.length) drawFloaters(dt);

    requestAnimationFrame(frame);
  }

  // ====================================================================
  //  音（初期ミュート。ON のときだけ小さなぷるん音）
  // ====================================================================
  let audioCtx = null;
  let soundOn = false;
  soundBtn.addEventListener("click", () => {
    soundOn = !soundOn;
    soundBtn.setAttribute("aria-pressed", soundOn ? "true" : "false");
    if (soundOn && !audioCtx) {
      try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch (_) {}
    }
    if (soundOn && audioCtx && audioCtx.state === "suspended") audioCtx.resume();
  });
  // やわらかい「ぷるん／ぽよん」音：軽く跳ねるピッチ＋ビブラート＋ローパス
  function blip(freq, gain) {
    if (!soundOn || !audioCtx) return;
    const t = audioCtx.currentTime;
    const base = freq;
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    const lp = audioCtx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.setValueAtTime(2200, t);
    lp.frequency.exponentialRampToValueAtTime(700, t + 0.22);
    o.type = "sine";
    // ぴょこんと上がって落ちるピッチ（ボヨン感）
    o.frequency.setValueAtTime(base * 0.75, t);
    o.frequency.exponentialRampToValueAtTime(base * 1.18, t + 0.035);
    o.frequency.exponentialRampToValueAtTime(base * 0.82, t + 0.2);
    // ぷるぷるしたビブラート
    const lfo = audioCtx.createOscillator();
    const lfoG = audioCtx.createGain();
    lfo.type = "sine";
    lfo.frequency.setValueAtTime(24, t);
    lfoG.gain.setValueAtTime(base * 0.05, t);
    lfo.connect(lfoG).connect(o.frequency);
    const vol = (gain || 0.05) * 1.1;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.26);
    o.connect(lp).connect(g).connect(audioCtx.destination);
    o.start(t);
    lfo.start(t);
    o.stop(t + 0.3);
    lfo.stop(t + 0.3);
  }

  // スマホの触覚（対応端末のみ。iOS Safari は無反応だが無害）
  function buzz(pattern) {
    if (navigator.vibrate) {
      try { navigator.vibrate(pattern); } catch (_) {}
    }
  }

  // 触ったときの音。おんがくONなら音階に乗った音＝触るほど曲になる（気持ちよさ加速）。
  // おんがくOFFなら従来のやわらかい「ぷるん」。
  const SCALE = [0, 2, 4, 7, 9, 12, 14, 16, 19, 21]; // メジャーペンタ（必ず気持ちいい音）
  let melodyStep = 0;
  function touchSound(kind) {
    if (musicOn && audioCtx) {
      const t = audioCtx.currentTime;
      if (kind === "tap" || kind === "release") {
        const i = melodyStep++ % SCALE.length;          // 触るたびに音階を上っていく
        playTone(semiHz(SCALE[i] + 12), t, 0.06, 0.45, "triangle");
        if (stats.combo % 4 === 3) playTone(semiHz(SCALE[i] + 19), t, 0.03, 0.4, "sine"); // 連打でハモる
      } else if (kind === "drag") {
        playTone(semiHz(SCALE[(melodyStep++ % 4) + 1] + 12), t, 0.05, 0.55, "triangle");
      } else if (kind === "long") {
        playTone(semiHz(SCALE[0]), t, 0.06, 0.8, "sine");
      } else if (kind === "shake") {
        for (let k = 0; k < 3; k++) playTone(semiHz(SCALE[k + 2] + 12), t + k * 0.05, 0.045, 0.4, "triangle");
      } else if (kind === "press") {
        playTone(semiHz(SCALE[0] + 12), t, 0.025, 0.3, "sine");
      }
    } else if (soundOn) {
      const map = { press: 360, release: 540, drag: 450, long: 560, shake: 480, tap: 540 };
      blip((map[kind] || 500) + (kind === "tap" ? Math.random() * 90 : 0), kind === "press" ? 0.03 : 0.055);
    }
  }

  // ====================================================================
  //  おんがく（任意・初期OFF）：やさしいループに合わせてゼリーが脈動する
  // ====================================================================
  let musicOn = false;
  let musicNext = 0;        // 次の音の時刻（AudioContext時間）
  let musicStep = 0;
  const beatQ = [];         // 拍の視覚演出キュー
  const STEP = 0.3;         // 1ステップ＝約100BPMの8分音符
  const ROOT = 264;         // C4 あたり
  const MEL = [0, 7, 12, 7, 9, 7, 4, 0, 2, 4, 7, 4, 5, 4, 2, 0];   // ペンタ風のやさしい旋律
  const BASS = [0, 0, 5, 5, 9, 9, 5, 5, 2, 2, 7, 7, 5, 5, 7, 7];
  function semiHz(s) { return ROOT * Math.pow(2, s / 12); }
  function playTone(freq, t, vol, dur, type) {
    if (!audioCtx) return;
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    const lp = audioCtx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 1700;
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(lp).connect(g).connect(audioCtx.destination);
    o.start(t);
    o.stop(t + dur + 0.05);
  }
  function musicScheduler() {
    if (!musicOn || !audioCtx) return;
    const now = audioCtx.currentTime;
    // 少し先まで音を予約
    while (musicNext < now + 0.12) {
      if (musicNext < now) musicNext = now;
      const s = musicStep % MEL.length;
      const strong = s % 4 === 0;
      playTone(semiHz(MEL[s] + 12), musicNext, strong ? 0.05 : 0.038, 0.5, "triangle");
      if (strong) playTone(semiHz(BASS[s] - 12), musicNext, 0.06, 0.45, "sine");
      beatQ.push({ t: musicNext, strong });
      musicNext += STEP;
      musicStep++;
    }
    // 時刻が来た拍でゼリーをぷるんと脈動
    for (let i = beatQ.length - 1; i >= 0; i--) {
      if (now >= beatQ[i].t) {
        const strong = beatQ[i].strong;
        if (!finished) {
          for (let k = 0; k < N; k++) v[k] += strong ? 4.2 : 2.0;
          squashV -= strong ? 0.15 : 0.06;
        }
        beatFlash = Math.max(beatFlash, strong ? 1 : 0.5);
        if (strong && sparks.length < 34 && !finished) addSpark();
        beatQ.splice(i, 1);
      }
    }
  }
  musicBtn.addEventListener("click", () => {
    if (!audioCtx) {
      try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch (_) {}
    }
    if (audioCtx && audioCtx.state === "suspended") audioCtx.resume();
    musicOn = !musicOn;
    musicBtn.classList.toggle("on", musicOn);
    musicBtn.setAttribute("aria-pressed", musicOn ? "true" : "false");
    if (musicOn && audioCtx) {
      musicNext = audioCtx.currentTime + 0.1;
      musicStep = 0;
      hideIntro();
    } else {
      beatQ.length = 0;
    }
  });

  // ====================================================================
  //  起動
  // ====================================================================
  window.addEventListener("resize", resize, { passive: true });
  window.addEventListener("orientationchange", () => setTimeout(resize, 200));
  resize();
  jiggle(0.5); // 出だしに軽くぷるん
  requestAnimationFrame(frame);
})();
