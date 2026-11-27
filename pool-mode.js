/*
 * Depth Studio V9.0 — 泳池平潛 (pool dynamic apnea) mode for the web.
 *
 * Same features as the iOS app's PoolModeView: import a pool video, mark the start, each turn,
 * optional checkpoints and the surfacing point, then export a 4K MP4 with a distance / lap /
 * speed HUD. Calculations come from pool-timeline.js (a port of PoolTimeline.swift).
 *
 * The HUD is drawn by one canvas function, drawPoolHud(), for both the on-screen preview and
 * every exported frame, so the preview is exactly what ends up in the video. Item sizes follow
 * the iOS export layer (PoolVideoHUDLayer.swift): all sizes are fractions of the frame width.
 *
 * Depends on globals from index.html: $, FLAG_IMAGES, COUNTRY_NAMES, IDENTITY_KEY,
 * exportVideo(), exportBusy.
 */
(function () {
  'use strict';
  const P = window.DepthStudioPool;
  if (!P) { console.error('pool-timeline.js 未載入'); return; }
  const { PoolSession, PoolTimeline, PoolFormat, PoolProfileGeometry, HUD_ITEMS, LIVE_IDS } = P;

  const STORAGE_KEY = 'depthstudio.web.pool-hud-settings.v1';
  const WHITE = 'rgb(240,252,255)';
  const CYAN = 'rgb(97,232,255)';
  const MUTED = 'rgb(189,237,250)';
  const YELLOW = 'rgb(255,204,89)';
  const GLOW = 'rgba(51,209,255,0.75)';
  const FONT = '"SF Pro Rounded","SF Pro Display",-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang TC","Microsoft JhengHei",Arial,sans-serif';
  const W_BOLD = 700, W_SEMI = 600, W_HEAVY = 800, W_BLACK = 900;

  /* ---------------- State ---------------- */
  let session = PoolSession.demo();
  let hud = loadSettings();
  let selectedItem = 'distanceValue';
  let editing = true;
  let videoFile = null;
  let videoURL = null;
  let currentTime = 0;
  let active = false;
  let drag = null;
  let hitBoxes = [];
  let rafId = null;
  let timeEntryNodeId = null;
  let errorMessage = null;
  let lastStatus = '已載入示範數據（50 m 泳池、150 m）。匯入平潛影片後，依序標記出發、轉身與出水時間。';

  const flagCache = {};
  function flagImage(country) {
    if (!FLAG_IMAGES[country]) return null;
    if (!flagCache[country]) {
      const img = new Image();
      img.onload = () => requestDraw();
      img.src = FLAG_IMAGES[country];
      flagCache[country] = img;
    }
    const img = flagCache[country];
    return img.complete && img.naturalWidth ? img : null;
  }

  const timelineResult = () => PoolTimeline.tryCreate(session);
  const hasVideo = () => !!videoFile;

  /* ---------------- Settings persistence ---------------- */
  function loadSettings() {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'); } catch (_) { saved = null; }
    if (saved && typeof saved === 'object') return P.mergeHudDefaults(saved);
    // First use: take the athlete name and flag from depth mode so they are not entered twice.
    const settings = P.defaultHudSettings();
    try {
      const depth = JSON.parse(localStorage.getItem(IDENTITY_KEY) || 'null');
      if (depth && typeof depth === 'object') {
        if (typeof depth.name === 'string' && depth.name.trim()) settings.displayName = depth.name;
        if (P.COUNTRIES.includes(depth.country)) settings.country = depth.country;
        if (Number.isFinite(Number(depth.scale))) settings.identityScale = Number(depth.scale) / 100;
      }
    } catch (_) { /* ignore */ }
    return P.mergeHudDefaults(settings);
  }
  function saveSettings() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(hud)); }
    catch (_) { setStatus('瀏覽器未允許儲存泳池 HUD 設定；本次操作仍可使用。'); }
  }

  /* ---------------- Canvas HUD drawing (shared by preview and export) ---------------- */

  function setFont(ctx, weight, size) { ctx.font = `${weight} ${size}px ${FONT}`; }

  function measureSpaced(ctx, text, spacing) {
    if (!spacing) return ctx.measureText(text).width;
    const chars = Array.from(text);
    return chars.reduce((sum, ch) => sum + ctx.measureText(ch).width, 0) + Math.max(0, chars.length - 1) * spacing;
  }
  function fillSpaced(ctx, text, centerX, y, spacing) {
    if (!spacing) { ctx.textAlign = 'center'; ctx.fillText(text, centerX, y); return; }
    const chars = Array.from(text);
    const widths = chars.map((ch) => ctx.measureText(ch).width);
    const total = widths.reduce((a, b) => a + b, 0) + Math.max(0, chars.length - 1) * spacing;
    let cursor = centerX - total / 2;
    ctx.textAlign = 'left';
    chars.forEach((ch, i) => { ctx.fillText(ch, cursor, y); cursor += widths[i] + spacing; });
  }

  /** Text style per item: [font size as a fraction of frame width, weight, colour, tracked]. */
  function textSpec(id) {
    switch (id) {
      case 'hudBrand': return [0.027, W_BOLD, MUTED, true];
      case 'hudClock': return [0.030, W_SEMI, WHITE, false];
      case 'distanceValue': return [0.13, W_HEAVY, WHITE, false];
      case 'distanceUnit': return [0.038, W_HEAVY, CYAN, false];
      case 'elapsedValue': return [0.055, W_HEAVY, WHITE, false];
      case 'elapsedLabel': return [0.023, W_BOLD, MUTED, false];
      case 'lapValue': return [0.055, W_HEAVY, WHITE, false];
      case 'lapLabel': return [0.023, W_BOLD, MUTED, false];
      case 'speedValue': return [0.050, W_HEAVY, WHITE, false];
      case 'speedLabel': return [0.023, W_BOLD, MUTED, false];
      case 'profileTitle': return [0.025, W_BOLD, MUTED, true];
      case 'footerBrand': return [0.025, W_BOLD, MUTED, true];
      case 'totalDistance': return [0.025, W_BOLD, MUTED, true];
      case 'averageSpeed': return [0.025, W_BOLD, MUTED, true];
      default: return [0.03, W_BOLD, WHITE, false];
    }
  }

  function itemText(id, reading, timeline) {
    switch (id) {
      case 'hudBrand': return '● FREEDIVE / POOL DYNAMIC';
      case 'hudClock': return PoolFormat.clock(reading ? reading.videoTime : 0);
      case 'distanceValue': return reading ? PoolFormat.distance(reading.distance) : '--.-';
      case 'distanceUnit': return 'M';
      case 'elapsedValue': return reading ? PoolFormat.clock(reading.elapsedSeconds) : '--:--';
      case 'elapsedLabel': return 'DIVE TIME';
      case 'lapValue': return reading ? PoolFormat.lap(reading) : '-- / --';
      case 'lapLabel': return 'LAP';
      case 'speedValue': return `${PoolFormat.speed(reading ? reading.speed : 0)} m/s`;
      case 'speedLabel': return 'SPEED';
      case 'profileTitle': return 'DISTANCE / SPEED PROFILE';
      case 'footerBrand': return P.FOOTER_TEXT;
      case 'totalDistance': return `TOTAL ${PoolFormat.distance(timeline ? timeline.finalDistance : 0)} M`;
      case 'averageSpeed': return `AVG ${PoolFormat.speed(timeline ? timeline.averageSpeed : 0)} M/S`;
      default: return '';
    }
  }

  /** Identity group: flag, name and discipline drawn centred at the origin. Returns its size. */
  function drawIdentity(ctx, W, settings, flag) {
    const boxW = W * 0.78;
    const fontSize = Math.max(12, boxW * 0.047 * settings.identityScale);
    const name = settings.displayName.trim() ? settings.displayName : 'name';
    const discipline = settings.discipline;
    setFont(ctx, W_HEAVY, fontSize);
    const nameW = ctx.measureText(name).width;
    setFont(ctx, W_BLACK, fontSize * 0.96);
    const typeW = ctx.measureText(discipline).width;
    const flagH = fontSize * 1.28;
    const flagW = flag ? flagH * flag.naturalWidth / Math.max(1, flag.naturalHeight) : 0;
    const flagGap = flagW > 0 ? fontSize * 0.42 : 0;
    const typeGap = fontSize * 0.9;
    const total = flagW + flagGap + nameW + typeGap + typeW;
    let x = -total / 2;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    if (flag) {
      ctx.save();
      ctx.shadowColor = 'transparent';
      try { ctx.drawImage(flag, x, -flagH / 2, flagW, flagH); } catch (_) { /* ignore */ }
      ctx.restore();
      x += flagW + flagGap;
    }
    setFont(ctx, W_HEAVY, fontSize);
    ctx.fillStyle = WHITE;
    ctx.fillText(name, x, 0);
    x += nameW + typeGap;
    setFont(ctx, W_BLACK, fontSize * 0.96);
    ctx.fillStyle = CYAN;
    ctx.fillText(discipline, x, 0);
    return { w: total, h: Math.max(flagH, fontSize * 1.3) };
  }

  /** Distance (cyan, left axis) / speed (yellow step line, right axis) chart centred at the origin. */
  function drawProfile(ctx, w, h, timeline, reading) {
    if (!timeline) return;
    const chart = new PoolProfileGeometry(timeline, w, h);
    const plot = chart.plot;
    ctx.save();
    ctx.translate(-w / 2, -h / 2);
    ctx.shadowColor = 'transparent';
    const labelSize = Math.max(8, w * 0.024);
    const gridColor = 'rgba(171,227,242,0.45)';
    const thin = Math.max(1, w * 0.0018);
    const dashed = (x1, y1, x2, y2, color) => {
      ctx.beginPath(); ctx.setLineDash([thin * 2, thin * 3]); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2);
      ctx.strokeStyle = color; ctx.lineWidth = thin; ctx.stroke(); ctx.setLineDash([]);
    };
    setFont(ctx, W_SEMI, labelSize);
    ctx.textBaseline = 'middle';
    for (const fraction of PoolProfileGeometry.gridFractions) {
      const y = plot.maxY - fraction * plot.height;
      dashed(plot.minX, y, plot.maxX, y, gridColor);
      ctx.fillStyle = CYAN; ctx.textAlign = 'right';
      ctx.fillText(`${Math.round(chart.distanceLimit * fraction)}m`, plot.minX - 4, y);
      ctx.fillStyle = YELLOW; ctx.textAlign = 'left';
      ctx.fillText(P.formatFixed(chart.speedLimit * fraction, 1), plot.maxX + 4, y);
    }
    for (let part = 1; part <= 3; part++) {
      const x = plot.minX + part / 3 * plot.width;
      dashed(x, plot.minY, x, plot.maxY, 'rgba(171,227,242,0.14)');
      ctx.fillStyle = gridColor; ctx.textAlign = 'center';
      ctx.fillText(PoolFormat.clock(timeline.totalTime * part / 3), x, h * 0.80 + labelSize * 0.7);
    }
    const polyline = (points) => { ctx.beginPath(); points.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y))); };
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    polyline(chart.speedPoints);
    ctx.strokeStyle = YELLOW; ctx.lineWidth = Math.max(1.5, w * 0.005); ctx.stroke();
    const distancePoints = chart.distancePoints;
    polyline(distancePoints);
    ctx.save();
    ctx.shadowColor = CYAN; ctx.shadowBlur = Math.max(4, w * 0.008);
    ctx.strokeStyle = 'rgba(97,232,255,0.38)'; ctx.lineWidth = Math.max(3, w * 0.012); ctx.stroke();
    ctx.restore();
    polyline(distancePoints);
    ctx.strokeStyle = CYAN; ctx.lineWidth = Math.max(1.8, w * 0.006); ctx.stroke();
    if (reading) {
      const x = chart.xForTime(reading.videoTime);
      ctx.fillStyle = 'rgba(255,255,255,0.55)';
      const gw = Math.max(2, w * 0.003);
      ctx.fillRect(x - gw / 2, plot.minY, gw, plot.height);
      const d = Math.max(8, w * 0.022);
      const dot = (y, color) => {
        ctx.beginPath(); ctx.arc(x, y, d / 2, 0, Math.PI * 2);
        ctx.fillStyle = color; ctx.fill();
        ctx.lineWidth = Math.max(1, d * 0.15); ctx.strokeStyle = '#fff'; ctx.stroke();
      };
      dot(chart.yForDistance(reading.distance), CYAN);
      dot(chart.yForSpeed(reading.speed), YELLOW);
    }
    ctx.restore();
  }

  /**
   * Draws every visible pool HUD item onto ctx for a W×H frame. Returns hit boxes (centre,
   * rotation, scale, half size) for the layout editor.
   */
  function drawPoolHud(ctx, W, H, reading, timeline, settings, options = {}) {
    const boxes = [];
    const flag = options.flag !== undefined ? options.flag : flagImage(settings.country);
    for (const item of HUD_ITEMS) {
      const id = item.id;
      if (!(settings.visibility[id] ?? true)) continue;
      if (LIVE_IDS.has(id) && !reading) continue;
      const point = settings.positions[id] || { x: 50, y: 50 };
      const transform = settings.transforms[id] || { scale: 1, rotation: 0 };
      const cx = W * point.x / 100;
      const cy = H * Math.min(100, Math.max(0, point.y + settings.verticalOffset)) / 100;
      const k = transform.scale * settings.fontScale;
      const angle = transform.rotation * Math.PI / 180;
      ctx.save();
      ctx.globalAlpha = settings.opacity;
      ctx.translate(cx, cy);
      ctx.rotate(angle);
      ctx.scale(k, k);
      let size;
      if (id === 'profileBlock') {
        const w = W * 0.91;
        const h = H * 0.18;
        drawProfile(ctx, w, h, timeline, reading);
        size = { w, h };
      } else {
        ctx.shadowColor = GLOW;
        ctx.shadowOffsetY = Math.max(1, W * 0.0009);
        if (id === 'identityGroup') {
          ctx.shadowBlur = Math.max(2, W * 0.012);
          size = drawIdentity(ctx, W, settings, flag);
        } else {
          const [fraction, weight, color, tracked] = textSpec(id);
          const fontSize = Math.max(7, W * fraction);
          const text = itemText(id, reading, timeline);
          ctx.shadowBlur = id === 'distanceValue' ? fontSize * 0.28 : Math.max(2, fontSize * 0.12);
          setFont(ctx, weight, fontSize);
          ctx.fillStyle = color;
          ctx.textBaseline = 'middle';
          const spacing = tracked ? fontSize * 0.06 : 0;
          fillSpaced(ctx, text, 0, 0, spacing);
          size = { w: measureSpaced(ctx, text, spacing), h: fontSize * 1.2 };
        }
      }
      ctx.restore();
      boxes.push({ id, cx, cy, angle, k, halfW: size.w / 2, halfH: size.h / 2 });
    }
    if (options.editing) drawEditorMarks(ctx, W, H, boxes, settings, options.selected);
    return boxes;
  }

  function drawEditorMarks(ctx, W, H, boxes, settings, selected) {
    ctx.save();
    const sel = boxes.find((b) => b.id === selected);
    if (sel) {
      ctx.strokeStyle = 'rgba(97,232,255,0.22)'; ctx.lineWidth = 1; ctx.setLineDash([3, 5]);
      ctx.beginPath(); ctx.moveTo(sel.cx, 0); ctx.lineTo(sel.cx, H); ctx.moveTo(0, sel.cy); ctx.lineTo(W, sel.cy); ctx.stroke();
    }
    for (const b of boxes) {
      ctx.save();
      ctx.translate(b.cx, b.cy); ctx.rotate(b.angle);
      const pad = 5;
      const hw = b.halfW * b.k + pad;
      const hh = b.halfH * b.k + pad;
      const isSel = b.id === selected;
      ctx.setLineDash(isSel ? [] : [4, 3]);
      ctx.lineWidth = isSel ? 2 : 1;
      ctx.strokeStyle = isSel ? '#ffffff' : 'rgba(105,232,255,0.75)';
      ctx.strokeRect(-hw, -hh, hw * 2, hh * 2);
      ctx.restore();
    }
    ctx.restore();
  }

  function hitTest(px, py) {
    for (let i = hitBoxes.length - 1; i >= 0; i--) {
      const b = hitBoxes[i];
      const dx = px - b.cx;
      const dy = py - b.cy;
      const cos = Math.cos(-b.angle);
      const sin = Math.sin(-b.angle);
      const lx = (dx * cos - dy * sin) / b.k;
      const ly = (dx * sin + dy * cos) / b.k;
      const pad = 6 / b.k;
      if (Math.abs(lx) <= b.halfW + pad && Math.abs(ly) <= b.halfH + pad) return b.id;
    }
    return null;
  }

  /* ---------------- Preview ---------------- */
  const canvas = $('poolHudCanvas');
  const video = $('poolVideo');
  let drawQueued = false;

  function previewReading(timeline) {
    if (!timeline) return null;
    if (!hasVideo()) return timeline.reading(timeline.startTime + timeline.totalTime * 0.5);
    return timeline.reading(currentTime);
  }

  function drawPreview() {
    drawQueued = false;
    if (!active) return;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    const pw = Math.round(rect.width * dpr);
    const ph = Math.round(rect.height * dpr);
    if (canvas.width !== pw || canvas.height !== ph) { canvas.width = pw; canvas.height = ph; }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, pw, ph);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const { timeline } = timelineResult();
    hitBoxes = drawPoolHud(ctx, rect.width, rect.height, previewReading(timeline), timeline, hud,
      { editing, selected: selectedItem });
  }
  function requestDraw() {
    if (drawQueued) return;
    drawQueued = true;
    requestAnimationFrame(drawPreview);
  }

  /* ---------------- Layout editor: pointer dragging ---------------- */
  canvas.addEventListener('pointerdown', (event) => {
    const rect = canvas.getBoundingClientRect();
    const px = event.clientX - rect.left;
    const py = event.clientY - rect.top;
    if (!editing) { if (hasVideo()) togglePlay(); return; }
    const id = hitTest(px, py);
    if (!id) return;
    event.preventDefault();
    selectItem(id);
    drag = { id, startX: event.clientX, startY: event.clientY, origin: { ...hud.positions[id] }, moved: false };
    canvas.setPointerCapture(event.pointerId);
    canvas.classList.add('dragging');
  });
  canvas.addEventListener('pointermove', (event) => {
    if (!drag) return;
    const rect = canvas.getBoundingClientRect();
    const dx = (event.clientX - drag.startX) / rect.width * 100;
    const dy = (event.clientY - drag.startY) / rect.height * 100;
    if (!drag.moved && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 2) return;
    drag.moved = true;
    hud.positions[drag.id] = P.snapDragPosition(hud, drag.id, drag.origin.x + dx, drag.origin.y + dy);
    requestDraw();
  });
  const endDrag = (event) => {
    if (!drag) return;
    if (drag.moved) saveSettings();
    drag = null;
    canvas.classList.remove('dragging');
    try { canvas.releasePointerCapture(event.pointerId); } catch (_) { /* ignore */ }
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);

  function setEditing(on) {
    editing = on;
    const btn = $('poolEditLayout');
    btn.textContent = on ? '排版：開' : '排版：關';
    btn.classList.toggle('active', on);
    canvas.classList.toggle('editing', on);
    requestDraw();
  }
  $('poolEditLayout').addEventListener('click', () => setEditing(!editing));

  /* ---------------- Video playback ---------------- */
  function updateTimeUI() {
    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    $('poolReadout').textContent = `${PoolFormat.clock(currentTime)} / ${PoolFormat.clock(duration)}`;
    const seek = $('poolSeek');
    seek.max = String(Math.max(duration, 0.1));
    if (document.activeElement !== seek) seek.value = String(currentTime);
    $('poolCurrentTime').textContent = hasVideo() ? PoolFormat.preciseClock(currentTime) : '尚未匯入影片';
    $('poolCurrentTime').style.color = hasVideo() ? '' : '#8fb8c9';
    $('poolPlay').textContent = video.paused ? '▶' : '❚❚';
  }
  function tick() {
    currentTime = video.currentTime || 0;
    updateTimeUI();
    drawPreview();
    rafId = video.paused ? null : requestAnimationFrame(tick);
  }
  function syncFromVideo() {
    currentTime = video.currentTime || 0;
    updateTimeUI();
    requestDraw();
  }
  video.addEventListener('play', () => { if (rafId === null) rafId = requestAnimationFrame(tick); updateTimeUI(); });
  video.addEventListener('pause', syncFromVideo);
  video.addEventListener('seeked', syncFromVideo);
  video.addEventListener('timeupdate', () => { if (video.paused) syncFromVideo(); });
  video.addEventListener('loadedmetadata', () => {
    syncFromVideo();
    $('poolExportInfo').textContent = `已載入來源影片：${video.videoWidth} × ${video.videoHeight}，長度 ${PoolFormat.preciseClock(video.duration || 0)}。輸出影片至少 4K（長邊 3840 px）；完成後可直接下載。`;
  });

  function togglePlay() {
    if (!hasVideo()) return;
    if (video.paused) video.play().catch(() => {}); else video.pause();
  }
  function seekTo(time) {
    if (!hasVideo()) return;
    const duration = Number.isFinite(video.duration) ? video.duration : time;
    const t = Math.min(Math.max(0, time), duration);
    video.currentTime = t;
    currentTime = t;
    updateTimeUI();
    requestDraw();
  }
  function step(delta) { if (!hasVideo()) return; video.pause(); seekTo(currentTime + delta); }

  $('poolPlay').addEventListener('click', togglePlay);
  $('poolSeek').addEventListener('input', (event) => seekTo(Number(event.target.value)));
  document.querySelectorAll('.pool-steps button').forEach((b) => b.addEventListener('click', () => step(Number(b.dataset.step))));

  // Desktop keyboard shortcuts (same actions as the play and frame-step buttons).
  document.addEventListener('keydown', (event) => {
    if (!active || !hasVideo() || event.defaultPrevented) return;
    const tag = (event.target && event.target.tagName) || '';
    if (['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON'].includes(tag) || $('poolTimeDialog').open) return;
    if (event.code === 'Space') { event.preventDefault(); togglePlay(); }
    else if (event.key === 'ArrowLeft') { event.preventDefault(); step(event.shiftKey ? -0.5 : -0.033); }
    else if (event.key === 'ArrowRight') { event.preventDefault(); step(event.shiftKey ? 0.5 : 0.033); }
  });

  /* ---------------- Import ---------------- */
  $('poolVideoFile').addEventListener('change', (event) => {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    video.pause();
    if (videoURL) URL.revokeObjectURL(videoURL);
    videoFile = file;
    videoURL = URL.createObjectURL(file);
    video.src = videoURL;
    video.hidden = false;
    $('poolEmpty').hidden = true;
    currentTime = 0;
    hideDownload();
    // Times from the demo or a previous video do not apply to this one.
    session.clearAllTimes();
    errorMessage = null;
    ['poolPlay', 'poolSeek'].forEach((id) => { $(id).disabled = false; });
    document.querySelectorAll('.pool-steps button').forEach((b) => { b.disabled = false; });
    setStatus(`影片匯入成功（${file.name}）。播放到選手出發的瞬間按「0 m 出發」的標記，再依序標記轉身與出水。`);
    refresh();
  });
  video.addEventListener('error', () => {
    if (!videoFile) return;
    errorMessage = '此瀏覽器無法播放這個影片檔，請改用 MP4（H.264／HEVC）或 MOV 影片。';
    refresh();
  });

  function hideDownload() {
    const link = $('poolExportDownload');
    link.style.display = 'none';
    link.removeAttribute('href');
    link.removeAttribute('download');
  }

  $('poolLoadDemo').addEventListener('click', () => {
    session = PoolSession.demo();
    errorMessage = null;
    setStatus('已載入示範數據：50 m 泳池，00:02 出發、00:50 與 01:40 轉身、02:30 於 150 m 出水。');
    refresh();
  });

  /* ---------------- Pool settings and timeline nodes ---------------- */
  document.querySelectorAll('#poolLengthSeg button').forEach((b) => b.addEventListener('click', () => {
    session.setPoolLength(Number(b.dataset.length));
    refresh();
  }));
  document.querySelectorAll('#poolDisciplineSeg button').forEach((b) => b.addEventListener('click', () => {
    hud.discipline = b.dataset.discipline;
    saveSettings();
    refresh();
  }));
  function applyFinalDistance(value) {
    session.setFinalDistance(value);
    refresh();
  }
  $('poolFinalDistance').addEventListener('change', (event) => applyFinalDistance(Number(event.target.value)));
  $('poolFinalMinus').addEventListener('click', () => applyFinalDistance(Math.max(P.FINAL_DISTANCE_RANGE[0], session.finalDistance - 0.5)));
  $('poolFinalPlus').addEventListener('click', () => applyFinalDistance(Math.min(P.FINAL_DISTANCE_RANGE[1], session.finalDistance + 0.5)));

  $('poolAddCheckpoint').addEventListener('click', () => {
    const distance = Number($('poolCheckpointDistance').value);
    if (session.addCheckpoint(distance)) {
      errorMessage = null;
      setStatus(`已新增 ${PoolFormat.distance(distance)} m 校正點，請播放到該位置後按「標記」。`);
    } else {
      errorMessage = '校正點必須介於 0 m 與最終距離之間，且不可與其他節點重複。';
    }
    refresh();
  });

  const NODE_ICONS = { start: '⚑', turn: '⇄', checkpoint: '⌖', finish: '◉' };
  function nodeById(id) { return session.nodes.find((n) => n.id === id); }
  function button(text, className, onClick, options = {}) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = text;
    if (className) b.className = className;
    if (options.disabled) b.disabled = true;
    if (options.label) b.setAttribute('aria-label', options.label);
    if (options.title) b.title = options.title;
    b.addEventListener('click', onClick);
    return b;
  }
  function nudge(id, delta) {
    const node = nodeById(id);
    if (!node) return;
    const base = node.videoTime !== null ? node.videoTime : currentTime;
    session.setTime(Math.max(0, base + delta), id);
    refresh();
  }

  function renderNodes() {
    const host = $('poolNodes');
    host.replaceChildren();
    const videoLoaded = hasVideo();
    for (const node of session.nodes) {
      const row = document.createElement('div');
      row.className = 'node' + (node.videoTime === null ? ' missing' : '');
      const icon = document.createElement('div');
      icon.className = 'icon';
      icon.textContent = NODE_ICONS[node.kind];
      const info = document.createElement('div');
      const dist = document.createElement('div');
      dist.className = 'dist';
      dist.textContent = `${PoolFormat.distance(node.distance)} m`;
      const kind = document.createElement('div');
      kind.className = 'kind';
      kind.textContent = P.nodeTitle(node);
      info.append(dist, kind);
      const ops = document.createElement('div');
      ops.className = 'ops';
      const distanceText = PoolFormat.distance(node.distance);
      ops.append(
        button(node.videoTime !== null ? PoolFormat.preciseClock(node.videoTime) : '未標記',
          'time' + (node.videoTime === null ? ' unset' : ''),
          () => { if (node.videoTime !== null && videoLoaded) seekTo(node.videoTime); },
          { disabled: node.videoTime === null || !videoLoaded, label: `跳到 ${distanceText} 公尺的時間`, title: '跳到此時間' }),
        button('標記', 'mark', () => { session.setTime(currentTime, node.id); refresh(); },
          { disabled: !videoLoaded, label: `以目前影片時間標記 ${distanceText} 公尺` }),
        button('−1 秒', 'mini', () => nudge(node.id, -1)),
        button('−0.1 秒', 'mini', () => nudge(node.id, -0.1)),
        button('+0.1 秒', 'mini', () => nudge(node.id, 0.1)),
        button('+1 秒', 'mini', () => nudge(node.id, 1)),
        button('輸入時間…', 'mini', () => beginTimeEntry(node.id)),
      );
      if (node.videoTime !== null) ops.append(button('清除時間', 'mini danger', () => { session.setTime(null, node.id); refresh(); }));
      if (node.kind === 'checkpoint') ops.append(button('刪除校正點', 'mini danger', () => { session.removeNode(node.id); refresh(); }));
      row.append(icon, info, ops);
      host.append(row);
    }
  }

  function renderSummary(result) {
    const host = $('poolSummary');
    host.replaceChildren();
    if (!result.timeline) {
      const warn = document.createElement('div');
      warn.className = 'warn';
      warn.textContent = result.error.message;
      host.append(warn);
      return;
    }
    const t = result.timeline;
    const box = document.createElement('div');
    box.className = 'summary';
    const segs = t.segments.map((s) => `<div><span>${PoolFormat.distance(s.startDistance)}–${PoolFormat.distance(s.endDistance)} m</span><span>${P.formatFixed(s.duration, 1)} 秒</span><b>${PoolFormat.speed(s.speed)} m/s</b></div>`).join('');
    box.innerHTML = `<h3>平潛數據摘要</h3><div class="stats">
      <div class="stat"><strong>${PoolFormat.distance(t.finalDistance)} m</strong><span>總距離</span></div>
      <div class="stat"><strong>${PoolFormat.preciseClock(t.totalTime)}</strong><span>閉氣時間</span></div>
      <div class="stat"><strong>${PoolFormat.speed(t.averageSpeed)} m/s</strong><span>平均速率</span></div></div>
      <div class="segs">${segs}</div>
      <p class="sub" style="margin:10px 0 0">基礎模式：節點之間以等速計算距離，速率為各段平均速率。AI 影像追蹤的浮動速率將在下一階段加入。</p>`;
    host.append(box);
  }

  /* Time entry dialog ("輸入時間…") */
  function beginTimeEntry(id) {
    const node = nodeById(id);
    if (!node) return;
    timeEntryNodeId = id;
    $('poolTimeInput').value = node.videoTime !== null ? PoolFormat.preciseClock(node.videoTime) : '';
    const dialog = $('poolTimeDialog');
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else applyTimeEntry(window.prompt('輸入影片時間（例如 01:40.5）', $('poolTimeInput').value));
    setTimeout(() => $('poolTimeInput').select(), 0);
  }
  function applyTimeEntry(text) {
    const id = timeEntryNodeId;
    timeEntryNodeId = null;
    if (!id || text === null || text === undefined) return;
    const seconds = PoolFormat.parseTime(text);
    if (seconds === null) {
      errorMessage = `無法辨識時間「${text}」，請輸入例如 01:40.5 或 100。`;
    } else {
      errorMessage = null;
      session.setTime(seconds, id);
    }
    refresh();
  }
  // Applied in the submit event (synchronous with the click / Enter key); Esc or 取消 discards.
  $('poolTimeDialog').querySelector('form').addEventListener('submit', (event) => {
    const submitter = event.submitter;
    const confirmed = !submitter || submitter.value === 'ok';
    if (confirmed) applyTimeEntry($('poolTimeInput').value);
    else timeEntryNodeId = null;
  });
  $('poolTimeDialog').addEventListener('close', () => { timeEntryNodeId = null; });

  /* ---------------- HUD appearance controls ---------------- */
  function buildItemSelect() {
    const select = $('poolItemSelect');
    select.replaceChildren();
    for (const item of HUD_ITEMS) {
      const option = document.createElement('option');
      option.value = item.id;
      option.textContent = item.title;
      select.append(option);
    }
  }
  function selectItem(id) {
    if (!HUD_ITEMS.some((i) => i.id === id)) return;
    selectedItem = id;
    syncAppearanceControls();
    requestDraw();
  }
  function syncAppearanceControls() {
    $('poolItemSelect').value = selectedItem;
    const t = hud.transforms[selectedItem];
    $('poolItemScale').value = String(Math.round(t.scale * 100));
    $('poolItemScaleVal').textContent = `${Math.round(t.scale * 100)}%`;
    $('poolItemRotation').value = String(Math.round(t.rotation));
    $('poolItemRotationVal').textContent = `${Math.round(t.rotation)}°`;
    $('poolOpacity').value = String(Math.round(hud.opacity * 100));
    $('poolOpacityVal').textContent = `${Math.round(hud.opacity * 100)}%`;
    $('poolFont').value = String(Math.round(hud.fontScale * 100));
    $('poolFontVal').textContent = `${Math.round(hud.fontScale * 100)}%`;
    $('poolOffset').value = String(Math.round(hud.verticalOffset));
    $('poolOffsetVal').textContent = `${Math.round(hud.verticalOffset)}%`;
  }
  function setSelectedRotation(value, snap = true) {
    hud.transforms[selectedItem] = { ...hud.transforms[selectedItem], rotation: P.normalizeRotation(value, snap) };
    saveSettings();
    syncAppearanceControls();
    requestDraw();
  }
  $('poolItemSelect').addEventListener('change', (event) => selectItem(event.target.value));
  $('poolItemScale').addEventListener('input', (event) => {
    hud.transforms[selectedItem] = { ...hud.transforms[selectedItem], scale: Number(event.target.value) / 100 };
    saveSettings(); syncAppearanceControls(); requestDraw();
  });
  $('poolItemRotation').addEventListener('input', (event) => setSelectedRotation(Number(event.target.value), false));
  document.querySelectorAll('#poolAppearancePanel [data-angle]').forEach((b) => b.addEventListener('click', () => setSelectedRotation(Number(b.dataset.angle))));
  $('poolRotateLeft').addEventListener('click', () => setSelectedRotation(hud.transforms[selectedItem].rotation - 90));
  $('poolRotateRight').addEventListener('click', () => setSelectedRotation(hud.transforms[selectedItem].rotation + 90));
  $('poolResetItem').addEventListener('click', () => {
    hud.transforms[selectedItem] = { scale: 1, rotation: 0 };
    saveSettings(); syncAppearanceControls(); requestDraw();
  });
  $('poolOpacity').addEventListener('input', (event) => { hud.opacity = Number(event.target.value) / 100; saveSettings(); syncAppearanceControls(); requestDraw(); });
  $('poolFont').addEventListener('input', (event) => { hud.fontScale = Number(event.target.value) / 100; saveSettings(); syncAppearanceControls(); requestDraw(); });
  $('poolOffset').addEventListener('input', (event) => { hud.verticalOffset = Number(event.target.value); saveSettings(); syncAppearanceControls(); requestDraw(); });
  $('poolResetLayout').addEventListener('click', () => {
    const defaults = P.defaultHudSettings();
    hud.positions = defaults.positions;
    hud.transforms = defaults.transforms;
    saveSettings(); syncAppearanceControls(); requestDraw();
    setStatus('所有泳池 HUD 項目已恢復預設位置、大小與角度。');
  });
  $('poolResetAppearance').addEventListener('click', () => {
    const name = hud.displayName;
    const country = hud.country;
    hud = P.defaultHudSettings();
    hud.displayName = name;
    hud.country = country;
    saveSettings();
    refresh();
  });

  /* ---------------- Visibility ---------------- */
  function buildVisibility() {
    const host = $('poolVisibility');
    host.replaceChildren();
    for (const item of HUD_ITEMS) {
      const label = document.createElement('label');
      label.className = 'visibility-toggle';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = hud.visibility[item.id] ?? true;
      input.addEventListener('change', () => {
        hud.visibility[item.id] = input.checked;
        saveSettings();
        setStatus(`${item.title}${input.checked ? '：已顯示' : '：已隱藏'}。`);
        requestDraw();
      });
      const name = document.createElement('span');
      name.textContent = item.title;
      label.append(input, name);
      host.append(label);
    }
  }
  function setAllVisible(visible) {
    for (const item of HUD_ITEMS) hud.visibility[item.id] = visible;
    saveSettings();
    buildVisibility();
    setStatus(visible ? '所有 HUD 資訊已顯示。' : '所有 HUD 資訊已隱藏。');
    requestDraw();
  }
  $('poolShowAll').addEventListener('click', () => setAllVisible(true));
  $('poolHideAll').addEventListener('click', () => setAllVisible(false));

  /* ---------------- Identity ---------------- */
  function buildCountrySelect() {
    const select = $('poolCountry');
    select.replaceChildren();
    for (const id of P.COUNTRIES) {
      const option = document.createElement('option');
      option.value = id;
      option.textContent = COUNTRY_NAMES[id];
      select.append(option);
    }
  }
  function syncIdentityControls() {
    if (document.activeElement !== $('poolName')) $('poolName').value = hud.displayName;
    $('poolCountry').value = hud.country;
    $('poolIdentityScale').value = String(Math.round(hud.identityScale * 100));
    $('poolIdentityScaleVal').textContent = `${Math.round(hud.identityScale * 100)}%`;
  }
  $('poolName').addEventListener('input', (event) => {
    hud.displayName = Array.from(event.target.value).slice(0, 30).join('');
    saveSettings(); requestDraw();
  });
  $('poolCountry').addEventListener('change', (event) => { hud.country = event.target.value; saveSettings(); requestDraw(); });
  $('poolIdentityScale').addEventListener('input', (event) => {
    hud.identityScale = Number(event.target.value) / 100;
    saveSettings(); syncIdentityControls(); requestDraw();
  });

  /* ---------------- Export (shared 4K pipeline in index.html) ---------------- */
  function poolExportJob() {
    const ui = {
      btn: $('poolExportBtn'), progress: $('poolExportProgress'), elapsed: $('poolExportElapsed'),
      download: $('poolExportDownload'), info: $('poolExportInfo'), status: $('poolStatus'),
    };
    return {
      sourceFile: videoFile,
      ui,
      fileSuffix: '_DepthStudio_Pool_V9-0_4K.mp4',
      versionLabel: 'Pool_V9-0',
      validate: () => {
        const result = timelineResult();
        return result.timeline ? null : `無法開始輸出：${result.error.message}`;
      },
      buildCache: () => {
        // Snapshot so edits made during a long export do not change frames midway.
        const snapshot = P.mergeHudDefaults(JSON.parse(JSON.stringify(hud)));
        return { timeline: new PoolTimeline(session), settings: snapshot, flag: flagImage(snapshot.country) };
      },
      draw: (ctx, W, H, time, cache) => {
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        drawPoolHud(ctx, W, H, cache.timeline.reading(time), cache.timeline, cache.settings, { flag: cache.flag });
        ctx.restore();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
      },
    };
  }
  $('poolExportBtn').addEventListener('click', async () => {
    if (!canExport()) return;
    video.pause();
    errorMessage = null;
    renderStatus();
    await exportVideo(poolExportJob());
    refresh();
  });
  function canExport() { return hasVideo() && !!timelineResult().timeline && !exportBusy; }

  /* ---------------- Status and full refresh ---------------- */
  function setStatus(text) { lastStatus = text; $('poolStatus').textContent = text; }
  function renderStatus() {
    const box = $('poolError');
    box.hidden = !errorMessage;
    box.textContent = errorMessage || '';
    $('poolStatus').textContent = lastStatus;
  }

  function refresh() {
    document.querySelectorAll('#poolLengthSeg button').forEach((b) => b.classList.toggle('on', Number(b.dataset.length) === session.poolLength));
    document.querySelectorAll('#poolDisciplineSeg button').forEach((b) => b.classList.toggle('on', b.dataset.discipline === hud.discipline));
    $('poolFinalDistance').value = String(session.finalDistance);
    const result = timelineResult();
    renderNodes();
    renderSummary(result);
    syncAppearanceControls();
    buildVisibility();
    syncIdentityControls();
    updateTimeUI();
    if (!exportBusy) $('poolExportBtn').disabled = !canExport();
    renderStatus();
    requestDraw();
  }

  // Keep the status line written by the export pipeline as the latest status.
  new MutationObserver(() => { lastStatus = $('poolStatus').textContent; }).observe($('poolStatus'), { childList: true, characterData: true, subtree: true });

  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => requestDraw()).observe(canvas);
  window.addEventListener('resize', requestDraw);

  buildItemSelect();
  buildCountrySelect();
  refresh();

  window.DepthStudioPoolUI = {
    setActive(on) {
      active = on;
      if (!on && !video.paused) video.pause();
      if (on) requestDraw();
    },
    // Exposed for automated tests and debugging.
    get session() { return session; },
    get settings() { return hud; },
    get currentTime() { return currentTime; },
    drawPoolHud,
  };
})();
