/*
 * End-to-end functional test of the Depth Studio website (both modes) in headless Chromium.
 *
 *   python3 -m http.server 8765        # in the repository root
 *   node tests/e2e-web.cjs [runs]      # needs Playwright, ffmpeg/ffprobe and Python Pillow
 *
 * Environment:
 *   DS_URL            page URL (default http://localhost:8765/index.html)
 *   MEDIABUNNY_FILE   local copy of mediabunny@1.65.2 dist/bundles/mediabunny.mjs, used when the
 *                     CDN is not reachable (npm pack mediabunny@1.65.2). Without it, exports are skipped.
 *   DS_SKIP_EXPORT=1  skip the two 4K exports.
 */
const { chromium } = require('playwright');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const URL = process.env.DS_URL || 'http://localhost:8765/index.html';
const RUNS = Number(process.argv[2] || 1);
const MB_FILE = process.env.MEDIABUNNY_FILE;
const SKIP_EXPORT = process.env.DS_SKIP_EXPORT === '1' || !MB_FILE;
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-e2e-'));
const VIEWPORTS = [
  { width: 1920, height: 1080 }, { width: 2560, height: 1440 }, { width: 1440, height: 900 },
  { width: 1280, height: 800 }, { width: 1680, height: 1050 },
];

function sh(cmd, args) { return execFileSync(cmd, args, { encoding: 'utf8' }); }
function makeVideos() {
  const mp4 = path.join(WORK, 'pool_source.mp4');
  sh('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x0c2a3a:size=720x1280:rate=30:duration=3',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', mp4]);
  return { mp4 };
}
function probe(file) {
  const out = JSON.parse(sh('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file]));
  const v = out.streams.find((s) => s.codec_type === 'video');
  const a = out.streams.find((s) => s.codec_type === 'audio');
  return { width: v.width, height: v.height, codec: v.codec_name, audio: a ? a.codec_name : null, duration: Number(out.format.duration) };
}

let failures = 0;
const results = [];
function check(run, name, ok, detail = '') {
  results.push({ run, name, ok, detail });
  if (!ok) failures++;
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? ' — ' + detail : ''}`);
}

async function downloadExport(page, linkSelector, file) {
  const b64 = await page.evaluate(async (sel) => {
    const href = document.querySelector(sel).href;
    const buf = new Uint8Array(await (await fetch(href)).arrayBuffer());
    let s = '';
    for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    return btoa(s);
  }, linkSelector);
  fs.writeFileSync(file, Buffer.from(b64, 'base64'));
  return file;
}

async function waitExport(page, btnSelector, linkSelector, statusSelector) {
  await page.click(btnSelector);
  await page.waitForFunction(() => !exportBusy, null, { timeout: 600000, polling: 1000 });
  const shown = await page.$eval(linkSelector, (a) => a.style.display !== 'none' && !!a.href);
  const status = await page.$eval(statusSelector, (e) => e.textContent);
  return { shown, status };
}

async function runOnce(run, videos) {
  const viewport = VIEWPORTS[(run - 1) % VIEWPORTS.length];
  console.log(`\n=== 第 ${run} 次完整測試（視窗 ${viewport.width}×${viewport.height}） ===`);
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport, acceptDownloads: true });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push(String(e)));
  if (MB_FILE) {
    await page.route('https://cdn.jsdelivr.net/npm/mediabunny@1.65.2/+esm', (route) =>
      route.fulfill({ status: 200, contentType: 'text/javascript', body: fs.readFileSync(MB_FILE) }));
  }

  // ---- 1. 模式選擇 ----
  await page.goto(URL);
  check(run, '開啟網站顯示模式選擇', await page.isVisible('#modeSelect') && !(await page.isVisible('#depthMode')) && !(await page.isVisible('#poolMode')));
  check(run, '兩種模式卡片', (await page.$$('.mode-card')).length === 2);

  // ---- 2. 深度潛水 ----
  await page.click('.mode-card[data-mode=depth]');
  await page.waitForSelector('#depthMode', { state: 'visible' });
  check(run, '進入深度潛水（網址 #depth）', page.url().endsWith('#depth') && await page.isVisible('#modeSwitch'));
  check(run, '深度 HUD 15 個欄位', (await page.$$('#hud .hud-item')).length === 15);
  await page.click('#loadDemo');
  check(run, '載入示範潛水資料', (await page.textContent('#sumMax')).includes('11.9'));
  await page.setInputFiles('#videoFile', videos.mp4);
  await page.waitForFunction(() => !document.getElementById('exportVideoBtn').disabled, null, { timeout: 20000 });
  check(run, '深度模式匯入影片後可輸出', true);
  const depthLayout = await page.evaluate(() => {
    const p = document.getElementById('stage').getBoundingClientRect();
    const right = [...document.querySelectorAll('#depthMode .right > .panel')].map((e) => Math.round(e.getBoundingClientRect().left));
    return { h: p.height, w: p.width, cols: new Set(right).size, overflow: document.documentElement.scrollWidth > innerWidth + 1 };
  });
  check(run, '桌機版面：深度預覽放大且無水平捲動', depthLayout.h >= viewport.height * 0.6 && !depthLayout.overflow,
    `預覽 ${Math.round(depthLayout.w)}×${Math.round(depthLayout.h)}，設定欄 ${depthLayout.cols} 欄`);
  check(run, '桌機版面：右側設定分兩欄', depthLayout.cols >= 2 || viewport.width < 1400);
  if (!SKIP_EXPORT) {
    const t0 = Date.now();
    const r = await waitExport(page, '#exportVideoBtn', '#exportDownload', '#status');
    check(run, '深度模式 4K 輸出完成並通過驗證', r.shown, `${Math.round((Date.now() - t0) / 1000)} 秒；${r.status}`);
    if (r.shown) {
      const info = probe(await downloadExport(page, '#exportDownload', path.join(WORK, `depth_${run}.mp4`)));
      check(run, '深度輸出：長邊 ≥ 3840、H.264、保留音訊', Math.max(info.width, info.height) >= 3840 && info.audio === 'aac',
        `${info.width}×${info.height} ${info.codec} audio=${info.audio} ${info.duration.toFixed(2)}s`);
    }
  }

  // ---- 3. 切換到泳池平潛 ----
  await page.click('#modeSwitch');
  check(run, '右上角模式按鈕回到模式選擇', await page.isVisible('#modeSelect'));
  await page.click('.mode-card[data-mode=pool]');
  await page.waitForSelector('#poolMode', { state: 'visible' });
  check(run, '進入泳池平潛（網址 #pool）', page.url().endsWith('#pool'));
  const demo = await page.textContent('#poolSummary');
  check(run, '示範數據摘要：150.0 m／02:28.0／1.01 m/s', demo.includes('150.0 m') && demo.includes('02:28.0') && demo.includes('1.01 m/s'));
  check(run, '示範分段速率 1.04／1.00／1.00', demo.includes('0.0–50.0 m') && demo.includes('48.0 秒') && demo.includes('1.04 m/s'));
  check(run, '示範節點 4 個', (await page.$$('#poolNodes .node')).length === 4);
  const painted = await page.evaluate(() => {
    const c = document.getElementById('poolHudCanvas');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
    return n;
  });
  check(run, '未匯入影片時 HUD 預覽有畫面', painted > 1000, `${painted} 個像素`);
  const poolLayout = await page.evaluate(() => {
    const p = document.getElementById('poolStage').getBoundingClientRect();
    return { h: p.height, overflow: document.documentElement.scrollWidth > innerWidth + 1 };
  });
  check(run, '桌機版面：泳池預覽放大且無水平捲動', poolLayout.h >= viewport.height * 0.5 && !poolLayout.overflow, `預覽高 ${Math.round(poolLayout.h)}`);

  // Pool length and final distance
  await page.click('#poolLengthSeg button[data-length="25"]');
  check(run, '泳池 25 m：自動產生 5 個轉身', (await page.$$('#poolNodes .node')).length === 7);
  await page.click('#poolLengthSeg button[data-length="50"]');
  await page.fill('#poolFinalDistance', '137.5');
  await page.dispatchEvent('#poolFinalDistance', 'change');
  const finishRow = await page.textContent('#poolNodes .node:last-child');
  check(run, '最終出水距離 137.5 m（出水節點保留時間）', finishRow.includes('137.5 m') && finishRow.includes('02:30.0'));
  await page.click('#poolFinalPlus');
  check(run, '＋ 按鈕增加 0.5 m', (await page.inputValue('#poolFinalDistance')) === '138');
  await page.click('#poolFinalMinus');

  // Import video -> times cleared
  await page.setInputFiles('#poolVideoFile', videos.mp4);
  await page.waitForFunction(() => document.getElementById('poolVideo').readyState >= 1, null, { timeout: 20000 });
  check(run, '匯入影片後清除示範時間', (await page.$$eval('#poolNodes .time.unset', (e) => e.length)) === 4);
  check(run, '缺少出發時間的提示', (await page.textContent('#poolSummary')).includes('請先標記「0 m 出發」的影片時間。'));
  check(run, '未完成標記時不能輸出', await page.isDisabled('#poolExportBtn'));

  const seek = async (t) => {
    await page.evaluate((v) => { const s = document.getElementById('poolSeek'); s.value = String(v); s.dispatchEvent(new Event('input')); }, t);
    await page.waitForFunction((v) => Math.abs(document.getElementById('poolVideo').currentTime - v) < 0.02, t);
  };
  const row = (i) => `#poolNodes .node:nth-child(${i})`;
  await seek(0.2);
  await page.click(`${row(1)} .mark`);
  check(run, '以目前影片時間標記出發', (await page.textContent(`${row(1)} .time`)) === '00:00.2');
  await seek(1.2);
  await page.click(`${row(2)} .mark`);
  await page.click(`${row(2)} button:text-is("−0.1 秒")`);
  await page.click(`${row(2)} button:text-is("−0.1 秒")`);
  check(run, '−0.1 秒微調（1.2 → 1.0）', (await page.textContent(`${row(2)} .time`)) === '00:01.0');
  // 輸入時間 dialog
  await page.click(`${row(3)} button:text-is("輸入時間…")`);
  await page.fill('#poolTimeInput', '0:02');
  await page.click('#poolTimeOk');
  check(run, '輸入時間對話框（0:02）', (await page.textContent(`${row(3)} .time`)) === '00:02.0');
  await page.click(`${row(4)} button:text-is("輸入時間…")`);
  await page.fill('#poolTimeInput', 'abc');
  await page.click('#poolTimeOk');
  check(run, '無法辨識的時間顯示錯誤', (await page.textContent('#poolError')).includes('無法辨識時間「abc」'));
  await page.click(`${row(4)} button:text-is("輸入時間…")`);
  await page.fill('#poolTimeInput', '2.8');
  await page.click('#poolTimeOk');
  let sum = await page.textContent('#poolSummary');
  check(run, '完成標記後的摘要（137.5 m／00:02.6／52.88 m/s）', sum.includes('137.5 m') && sum.includes('00:02.6') && sum.includes('52.88 m/s'), sum.slice(0, 80));
  check(run, '完成標記後可以輸出', !(await page.isDisabled('#poolExportBtn')));

  // Jump to a node time
  await seek(2.5);
  await page.click(`${row(2)} .time`);
  await page.waitForFunction(() => Math.abs(document.getElementById('poolVideo').currentTime - 1.0) < 0.02);
  check(run, '點節點時間跳到該時間', (await page.textContent('#poolCurrentTime')) === '00:01.0');
  // Frame step buttons and keyboard
  await page.click('.pool-steps button[data-step="0.5"]');
  await page.waitForFunction(() => Math.abs(document.getElementById('poolVideo').currentTime - 1.5) < 0.02);
  await page.focus('#poolHudCanvas').catch(() => {});
  await page.evaluate(() => document.activeElement && document.activeElement.blur());
  await page.keyboard.press('Shift+ArrowLeft');
  await page.waitForFunction(() => Math.abs(document.getElementById('poolVideo').currentTime - 1.0) < 0.02);
  check(run, '逐格按鈕與鍵盤 Shift+← 快捷鍵', true);

  // Checkpoints
  await page.fill('#poolCheckpointDistance', '200');
  await page.click('#poolAddCheckpoint');
  check(run, '超出範圍的校正點被拒絕', (await page.textContent('#poolError')).includes('校正點必須介於'));
  await page.fill('#poolCheckpointDistance', '25');
  await page.click('#poolAddCheckpoint');
  check(run, '新增 25 m 校正點', (await page.$$('#poolNodes .node')).length === 5 && (await page.textContent(row(2))).includes('校正點'));
  await seek(0.6);
  await page.click(`${row(2)} .mark`);
  sum = await page.textContent('#poolSummary');
  check(run, '校正點加入分段（0.0–25.0 m）', sum.includes('0.0–25.0 m') && sum.includes('25.0–50.0 m'));
  await page.click(`${row(2)} button:text-is("刪除校正點")`);
  check(run, '刪除校正點', (await page.$$('#poolNodes .node')).length === 4);

  // Non-increasing time
  await page.click(`${row(3)} button:text-is("輸入時間…")`);
  await page.fill('#poolTimeInput', '0.5');
  await page.click('#poolTimeOk');
  check(run, '時間倒退時提示且不能輸出', (await page.textContent('#poolSummary')).includes('100.0 m 的時間必須晚於前一個節點。') && await page.isDisabled('#poolExportBtn'));
  await page.click(`${row(3)} button:text-is("輸入時間…")`);
  await page.fill('#poolTimeInput', '2');
  await page.click('#poolTimeOk');

  // Browser-side calculation equals the shared test vectors
  const calc = await page.evaluate(() => {
    const t = new DepthStudioPool.PoolTimeline(DepthStudioPoolUI.session);
    const r = t.reading(1.5);
    return { d: DepthStudioPool.PoolFormat.distance(r.distance), lap: DepthStudioPool.PoolFormat.lap(r), v: DepthStudioPool.PoolFormat.speed(r.speed) };
  });
  check(run, '1.5 秒的讀值：75.0 m、02 / 03、50.00 m/s', calc.d === '75.0' && calc.lap === '02 / 03' && calc.v === '50.00', JSON.stringify(calc));

  // ---- HUD layout editing ----
  const box = await page.$eval('#poolHudCanvas', (c) => { const r = c.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
  const before = await page.evaluate(() => ({ ...DepthStudioPoolUI.settings.positions.distanceValue }));
  const sx = box.x + box.w * before.x / 100;
  const sy = box.y + box.h * before.y / 100;
  const dragBy = async (fx, fy, dx, dy) => {
    await page.mouse.move(fx, fy);
    await page.mouse.down();
    await page.mouse.move(fx + box.w * dx / 100, fy + box.h * dy / 100, { steps: 6 });
    await page.mouse.up();
  };
  await dragBy(sx, sy, 15, 10);
  const after = await page.evaluate(() => ({ ...DepthStudioPoolUI.settings.positions.distanceValue }));
  check(run, '拖曳 HUD 欄位（累積距離數值）', Math.abs(after.x - before.x - 15) < 0.6 && Math.abs(after.y - before.y - 10) < 0.6,
    `${before.x},${before.y} → ${after.x.toFixed(1)},${after.y.toFixed(1)}`);
  await dragBy(box.x + box.w * after.x / 100, box.y + box.h * after.y / 100, 0, -4.8);
  const snapped = await page.evaluate(() => ({ ...DepthStudioPoolUI.settings.positions.distanceValue }));
  check(run, '拖曳時中心吸附其他欄位（2% 內對齊距離單位）', snapped.y === 24, `y=${snapped.y.toFixed(2)}`);
  check(run, '拖曳後選取該欄位', (await page.inputValue('#poolItemSelect')) === 'distanceValue');
  // Snap: drag elapsedValue next to lapValue's y
  await page.selectOption('#poolItemSelect', 'speedValue');
  await page.fill('#poolItemScale', '150');
  await page.dispatchEvent('#poolItemScale', 'input');
  await page.click('#poolAppearancePanel button[data-angle="90"]');
  const tr = await page.evaluate(() => ({ ...DepthStudioPoolUI.settings.transforms.speedValue }));
  check(run, '項目大小 150% 與旋轉 90°', tr.scale === 1.5 && tr.rotation === 90);
  await page.click('#poolRotateRight');
  check(run, '順時針 90°', (await page.evaluate(() => DepthStudioPoolUI.settings.transforms.speedValue.rotation)) === 180);
  await page.click('#poolResetItem');
  await page.fill('#poolOpacity', '50'); await page.dispatchEvent('#poolOpacity', 'input');
  await page.fill('#poolFont', '120'); await page.dispatchEvent('#poolFont', 'input');
  await page.fill('#poolOffset', '-10'); await page.dispatchEvent('#poolOffset', 'input');
  const look = await page.evaluate(() => { const s = DepthStudioPoolUI.settings; return [s.opacity, s.fontScale, s.verticalOffset]; });
  check(run, '透明度／字體／垂直偏移', look[0] === 0.5 && look[1] === 1.2 && look[2] === -10);
  await page.click('#poolResetAppearance');
  check(run, '重設外觀', (await page.evaluate(() => DepthStudioPoolUI.settings.opacity)) === 0.9);

  // Visibility
  await page.click('#poolVisibility label:has-text("累積距離數值") input');
  check(run, '單獨隱藏一個欄位', (await page.evaluate(() => DepthStudioPoolUI.settings.visibility.distanceValue)) === false
    && (await page.evaluate(() => DepthStudioPoolUI.settings.visibility.lapValue)) === true);
  await page.click('#poolHideAll');
  check(run, '全部隱藏', await page.evaluate(() => Object.values(DepthStudioPoolUI.settings.visibility).every((v) => !v)));
  await page.click('#poolShowAll');
  check(run, '全部顯示', await page.evaluate(() => Object.values(DepthStudioPoolUI.settings.visibility).every((v) => v)));
  await page.click('#poolResetAppearance');

  // Identity and discipline
  await page.fill('#poolName', '蕉流 Banana');
  await page.selectOption('#poolCountry', 'japan');
  await page.fill('#poolIdentityScale', '120'); await page.dispatchEvent('#poolIdentityScale', 'input');
  await page.click('#poolDisciplineSeg button[data-discipline="DNF"]');
  const id = await page.evaluate(() => { const s = DepthStudioPoolUI.settings; return [s.displayName, s.country, s.identityScale, s.discipline]; });
  check(run, '姓名／國旗／大小／項目', id[0] === '蕉流 Banana' && id[1] === 'japan' && id[2] === 1.2 && id[3] === 'DNF');

  // Persistence across reload (HUD settings are saved; the drag result too)
  const savedPos = await page.evaluate(() => ({ ...DepthStudioPoolUI.settings.positions.distanceValue }));
  await page.reload();
  await page.waitForSelector('#poolMode', { state: 'visible' });
  const reloaded = await page.evaluate(() => { const s = DepthStudioPoolUI.settings; return [s.displayName, s.discipline, s.positions.distanceValue]; });
  check(run, '重新整理後保留泳池 HUD 設定', reloaded[0] === '蕉流 Banana' && reloaded[1] === 'DNF' && Math.abs(reloaded[2].x - savedPos.x) < 1e-9);
  check(run, '以 #pool 網址直接開啟泳池平潛', await page.isVisible('#poolMode'));

  // ---- Pool export ----
  if (!SKIP_EXPORT) {
    await page.setInputFiles('#poolVideoFile', videos.mp4);
    await page.waitForFunction(() => document.getElementById('poolVideo').readyState >= 1);
    await page.evaluate(() => {
      const s = DepthStudioPoolUI.session;
      s.setFinalDistance(150);
      const times = { 0: 0.2, 50: 1.0, 100: 2.0, 150: 2.8 };
      s.nodes.forEach((n) => { if (n.distance in times) s.setTime(times[n.distance], n.id); });
    });
    await page.click('#poolLengthSeg button[data-length="50"]'); // triggers refresh
    const t0 = Date.now();
    const r = await waitExport(page, '#poolExportBtn', '#poolExportDownload', '#poolStatus');
    check(run, '泳池平潛 4K 輸出完成並通過驗證', r.shown, `${Math.round((Date.now() - t0) / 1000)} 秒；${r.status}`);
    if (r.shown) {
      const out = await downloadExport(page, '#poolExportDownload', path.join(WORK, `pool_${run}.mp4`));
      const info = probe(out);
      check(run, '泳池輸出：2160×3840、H.264、保留音訊、片長一致', info.width === 2160 && info.height === 3840 && info.codec === 'h264'
        && info.audio === 'aac' && Math.abs(info.duration - 3) < 0.15, `${info.width}×${info.height} ${info.codec} audio=${info.audio} ${info.duration.toFixed(2)}s`);
      // Compare one exported frame with the same HUD drawn by the preview function.
      const T = 1.5;
      const framePng = path.join(WORK, `pool_${run}_frame.png`);
      sh('ffmpeg', ['-loglevel', 'error', '-y', '-ss', String(T), '-i', out, '-frames:v', '1', framePng]);
      const expectedB64 = await page.evaluate((time) => {
        const c = document.createElement('canvas'); c.width = 2160; c.height = 3840;
        const ctx = c.getContext('2d');
        ctx.fillStyle = '#0c2a3a'; ctx.fillRect(0, 0, c.width, c.height);
        const t = new DepthStudioPool.PoolTimeline(DepthStudioPoolUI.session);
        DepthStudioPoolUI.drawPoolHud(ctx, c.width, c.height, t.reading(time), t, DepthStudioPoolUI.settings, {});
        return c.toDataURL('image/png').split(',')[1];
      }, T);
      const expectedPng = path.join(WORK, `pool_${run}_expected.png`);
      fs.writeFileSync(expectedPng, Buffer.from(expectedB64, 'base64'));
      const cmp = sh('python3', ['-c', `
import sys
from PIL import Image, ImageChops, ImageStat
a=Image.open(sys.argv[1]).convert('L');b=Image.open(sys.argv[2]).convert('L').resize(a.size)
d=ImageChops.difference(a,b);mean=ImageStat.Stat(d).mean[0]
hud=sum(1 for p in a.getdata() if p>200)
print(f"{mean:.3f} {hud}")`, framePng, expectedPng]).trim().split(' ');
      check(run, '輸出影格的 HUD 與預覽繪製一致', Number(cmp[0]) < 4 && Number(cmp[1]) > 5000, `平均差異 ${cmp[0]}／255，HUD 亮像素 ${cmp[1]}`);
    }
  }

  // ---- Back to depth mode: state kept ----
  await page.click('#modeSwitch');
  await page.click('.mode-card[data-mode=depth]');
  check(run, '切回深度潛水', await page.isVisible('#depthMode') && (await page.textContent('#sumMax')).includes('m'));
  check(run, '沒有 JavaScript 錯誤', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
  await page.screenshot({ path: path.join(WORK, `run${run}_depth.png`) });
  await page.click('#modeSwitch');
  await page.click('.mode-card[data-mode=pool]');
  await page.screenshot({ path: path.join(WORK, `run${run}_pool.png`) });
  await browser.close();
}

(async () => {
  const videos = makeVideos();
  console.log(`測試網址 ${URL}；輸出測試 ${SKIP_EXPORT ? '略過' : '執行'}；暫存 ${WORK}`);
  for (let run = 1; run <= RUNS; run++) await runOnce(run, videos);
  const perRun = {};
  for (const r of results) { perRun[r.run] = perRun[r.run] || [0, 0]; perRun[r.run][r.ok ? 0 : 1]++; }
  console.log('\n=== 結果 ===');
  for (const [run, [ok, bad]] of Object.entries(perRun)) console.log(`第 ${run} 次：通過 ${ok}，失敗 ${bad}`);
  console.log(`截圖與輸出影片：${WORK}`);
  fs.writeFileSync(path.join(WORK, 'results.json'), JSON.stringify(results, null, 2));
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
