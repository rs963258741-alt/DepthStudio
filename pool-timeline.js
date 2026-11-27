/*
 * Depth Studio — 泳池平潛 (pool dynamic apnea) timeline, V1 basic mode.
 *
 * This is a line-by-line port of the iOS app's PoolTimeline.swift and the data part of
 * PoolHUDSettings.swift (repository rs963258741-alt/DepthStudio-iOS). The web page and the
 * iPhone app must give the same distance, elapsed time, lap and speed for the same marks, so
 * any change here has to be made in the Swift file as well (and the shared test vectors in
 * tests/pool-timeline.test.mjs updated).
 *
 * Distances are metres. Times are seconds on the imported video's own clock (pool mode has
 * no watch, so there is no time offset to sync).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DepthStudioPool = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const POOL_LENGTHS = [25, 50];
  const FINAL_DISTANCE_RANGE = [1, 1000];
  const NODE_TITLES = { start: '出發', turn: '轉身', checkpoint: '校正點', finish: '結束出水' };

  let idCounter = 0;
  function newId() {
    idCounter += 1;
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    return 'node-' + Date.now().toString(36) + '-' + idCounter;
  }

  const clamp = (value, lo, hi) => Math.min(hi, Math.max(lo, value));
  /** Swift's Double.rounded() (schoolbook: halves away from zero). */
  const roundHalfAway = (value) => (value < 0 ? -Math.round(-value) : Math.round(value));

  /** One known (distance, video time) pair. */
  function makeNode(distance, videoTime, kind, id) {
    return { id: id || newId(), distance, videoTime: videoTime ?? null, kind };
  }
  function nodeTitle(node) { return NODE_TITLES[node.kind] || ''; }

  /**
   * The swim being edited: pool length, final distance and the timeline points.
   * Mirrors `struct PoolSession`; mutating methods change the instance in place.
   */
  class PoolSession {
    constructor(poolLength = 50, finalDistance = 150) {
      this.poolLength = POOL_LENGTHS.includes(poolLength) ? poolLength : 50;
      this.finalDistance = clamp(finalDistance, FINAL_DISTANCE_RANGE[0], FINAL_DISTANCE_RANGE[1]);
      this.nodes = [];
      this._rebuildNodes();
    }

    /** 50 m pool, 0 m at 00:02, turns at 00:50 and 01:40, surfacing at 150 m at 02:30. */
    static demo() {
      const session = new PoolSession(50, 150);
      const times = { 0: 2, 50: 50, 100: 100, 150: 150 };
      for (const node of session.nodes) {
        if (Object.prototype.hasOwnProperty.call(times, node.distance)) session.setTime(times[node.distance], node.id);
      }
      return session;
    }

    get hasAnyTime() { return this.nodes.some((n) => n.videoTime !== null); }

    setPoolLength(length) {
      if (!POOL_LENGTHS.includes(length) || length === this.poolLength) return;
      this.poolLength = length;
      this._rebuildNodes();
    }

    setFinalDistance(distance) {
      if (typeof distance !== 'number' || !Number.isFinite(distance)) return;
      const clamped = clamp(roundHalfAway(distance * 10) / 10, FINAL_DISTANCE_RANGE[0], FINAL_DISTANCE_RANGE[1]);
      if (clamped === this.finalDistance) return;
      this.finalDistance = clamped;
      this._rebuildNodes();
    }

    setTime(time, id) {
      const node = this.nodes.find((n) => n.id === id);
      if (!node) return;
      if (typeof time === 'number' && Number.isFinite(time)) node.videoTime = Math.max(0, roundHalfAway(time * 100) / 100);
      else node.videoTime = null;
    }

    clearAllTimes() { for (const node of this.nodes) node.videoTime = null; }

    /** Adds a checkpoint strictly between start and finish; false if out of range or duplicate. */
    addCheckpoint(distance, videoTime = null) {
      if (typeof distance !== 'number' || !Number.isFinite(distance)) return false;
      const rounded = roundHalfAway(distance * 10) / 10;
      if (!(rounded > 0 && rounded < this.finalDistance)) return false;
      if (this.nodes.some((n) => Math.abs(n.distance - rounded) < 0.05)) return false;
      this.nodes.push(makeNode(rounded, videoTime, 'checkpoint'));
      this.nodes.sort((a, b) => a.distance - b.distance);
      return true;
    }

    /** Only checkpoints can be removed; start, turns and finish follow the pool settings. */
    removeNode(id) { this.nodes = this.nodes.filter((n) => !(n.id === id && n.kind === 'checkpoint')); }

    _rebuildNodes() {
      const previous = this.nodes;
      const existing = (distance) => previous.find((n) => Math.abs(n.distance - distance) < 0.05 && n.kind !== 'checkpoint');
      const rebuilt = [];
      const oldStart = existing(0);
      rebuilt.push(makeNode(0, oldStart ? oldStart.videoTime : null, 'start', oldStart && oldStart.id));
      let turn = this.poolLength;
      while (turn < this.finalDistance - 0.05) {
        const old = existing(turn);
        rebuilt.push(makeNode(turn, old ? old.videoTime : null, 'turn', old && old.id));
        turn += this.poolLength;
      }
      // The finish keeps its time when only the final distance changes.
      const oldFinish = previous.find((n) => n.kind === 'finish');
      rebuilt.push(makeNode(this.finalDistance, oldFinish ? oldFinish.videoTime : null, 'finish', oldFinish && oldFinish.id));
      for (const checkpoint of previous) {
        if (checkpoint.kind !== 'checkpoint') continue;
        if (checkpoint.distance > 0 && checkpoint.distance < this.finalDistance &&
            !rebuilt.some((n) => Math.abs(n.distance - checkpoint.distance) < 0.05)) {
          rebuilt.push(checkpoint);
        }
      }
      this.nodes = rebuilt.sort((a, b) => a.distance - b.distance);
    }

    toJSON() {
      return { poolLength: this.poolLength, finalDistance: this.finalDistance, nodes: this.nodes.map((n) => ({ ...n })) };
    }
  }

  class PoolTimelineError extends Error {
    constructor(code, distance) {
      let message;
      if (code === 'missingStart') message = '請先標記「0 m 出發」的影片時間。';
      else if (code === 'missingFinish') message = '請標記「結束出水」的影片時間。';
      else message = `${formatFixed(distance, 1)} m 的時間必須晚於前一個節點。`;
      super(message);
      this.name = 'PoolTimelineError';
      this.code = code;
      this.distance = distance;
    }
  }

  function makeSegment(a, b) {
    const duration = b.time - a.time;
    const distance = b.distance - a.distance;
    return { startTime: a.time, endTime: b.time, startDistance: a.distance, endDistance: b.distance,
      duration, distance, speed: distance / duration };
  }

  /**
   * Distance and speed over time from the timed points. Between two known points the distance
   * changes linearly, so the speed in that segment is its average speed (分段平均速率).
   */
  class PoolTimeline {
    constructor(session) {
      const timed = session.nodes.filter((n) => n.videoTime !== null).sort((a, b) => a.distance - b.distance);
      const first = timed[0];
      if (!first || first.kind !== 'start' || first.videoTime === null) throw new PoolTimelineError('missingStart');
      const last = timed[timed.length - 1];
      if (!last || last.kind !== 'finish' || last.videoTime === null) throw new PoolTimelineError('missingFinish');
      const points = [{ time: first.videoTime, distance: first.distance }];
      for (const node of timed.slice(1)) {
        if (!(node.videoTime > points[points.length - 1].time)) throw new PoolTimelineError('timeNotIncreasing', node.distance);
        points.push({ time: node.videoTime, distance: node.distance });
      }
      this.points = points;
      this.poolLength = session.poolLength;
      this.finalDistance = session.finalDistance;
      this.segments = [];
      for (let i = 0; i + 1 < points.length; i++) this.segments.push(makeSegment(points[i], points[i + 1]));
    }

    static tryCreate(session) {
      try { return { timeline: new PoolTimeline(session), error: null }; }
      catch (error) { return { timeline: null, error }; }
    }

    get startTime() { return this.points[0].time; }
    get finishTime() { return this.points[this.points.length - 1].time; }
    get totalTime() { return this.finishTime - this.startTime; }
    get averageSpeed() { return this.totalTime > 0 ? this.finalDistance / this.totalTime : 0; }
    get totalLaps() { return Math.max(1, Math.ceil(this.finalDistance / this.poolLength - 1e-9)); }
    get maximumSegmentSpeed() { return this.segments.length ? Math.max(...this.segments.map((s) => s.speed)) : 0; }

    reading(time) {
      const t = typeof time === 'number' && Number.isFinite(time) ? time : 0;
      const totalLaps = this.totalLaps;
      if (t < this.startTime) {
        return { videoTime: t, phase: 'beforeStart', distance: 0, elapsedSeconds: 0, speed: 0, lap: 1, totalLaps };
      }
      if (t >= this.finishTime) {
        return { videoTime: t, phase: 'finished', distance: this.finalDistance, elapsedSeconds: this.totalTime,
          speed: 0, lap: totalLaps, totalLaps };
      }
      const current = this._segmentAt(t);
      const fraction = (t - current.startTime) / current.duration;
      const distance = current.startDistance + current.distance * fraction;
      return { videoTime: t, phase: 'swimming', distance, elapsedSeconds: t - this.startTime,
        speed: current.speed, lap: this.lap(distance), totalLaps };
    }

    distance(time) { return this.reading(time).distance; }

    lap(distance) {
      if (distance >= this.finalDistance) return this.totalLaps;
      return Math.min(this.totalLaps, Math.max(1, Math.floor(distance / this.poolLength + 1e-9) + 1));
    }

    /** The segment containing `time`, for startTime <= time < finishTime (binary search). */
    _segmentAt(time) {
      let low = 0;
      let high = this.points.length - 1;
      while (low + 1 < high) {
        const mid = (low + high) >> 1;
        if (this.points[mid].time <= time) low = mid; else high = mid;
      }
      return makeSegment(this.points[low], this.points[low + 1]);
    }
  }

  /**
   * printf-style "%.Nf". JavaScript's toFixed rounds exact binary halves up while
   * String(format:) rounds them to even; this keeps the HUD text identical to the app.
   */
  function formatFixed(value, digits) {
    const v = Number(value);
    if (!Number.isFinite(v)) return v.toFixed(digits);
    const p = Math.pow(10, digits);
    const scaled = v * p;
    const floor = Math.floor(scaled);
    if (scaled - floor === 0.5 && (floor + 0.5) / p === v) {
      const even = floor % 2 === 0 ? floor : floor + 1;
      return (even / p).toFixed(digits);
    }
    return v.toFixed(digits);
  }

  const pad2 = (n) => String(n).padStart(2, '0');
  const PoolFormat = {
    clock(seconds) {
      const value = Math.max(0, Math.floor(seconds));
      return pad2(Math.floor(value / 60)) + ':' + pad2(value % 60);
    },
    /** mm:ss.s, used for marking points precisely. */
    preciseClock(seconds) {
      const tenths = Math.max(0, roundHalfAway(seconds * 10));
      return pad2(Math.floor(tenths / 600)) + ':' + pad2(Math.floor(tenths / 10) % 60) + '.' + (tenths % 10);
    },
    distance(metres) { return formatFixed(metres, 1); },
    speed(metresPerSecond) { return formatFixed(metresPerSecond, 2); },
    lap(reading) { return pad2(reading.lap) + ' / ' + pad2(reading.totalLaps); },
    /** Parses "150", "2:30", "02:30.5" or "1:02:30" into seconds; null if invalid. */
    parseTime(text) {
      const parts = String(text).trim().replace(/：/g, ':').split(':');
      if (parts.length < 1 || parts.length > 3) return null;
      let total = 0;
      for (const part of parts) {
        if (!/^\+?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(part)) return null;
        const value = Number(part);
        if (!(value >= 0)) return null;
        total = total * 60 + value;
      }
      return Number.isFinite(total) ? total : null;
    },
  };

  /* ---------------- HUD settings (PoolHUDSettings.swift) ---------------- */

  const HUD_ITEMS = [
    { id: 'hudBrand', title: '品牌文字' },
    { id: 'hudClock', title: '影片時間' },
    { id: 'identityGroup', title: '姓名、國旗與項目' },
    { id: 'distanceValue', title: '累積距離數值' },
    { id: 'distanceUnit', title: '距離單位' },
    { id: 'elapsedValue', title: '閉氣時間數值' },
    { id: 'elapsedLabel', title: '閉氣時間標籤' },
    { id: 'lapValue', title: '目前趟次數值' },
    { id: 'lapLabel', title: '目前趟次標籤' },
    { id: 'speedValue', title: '估算速率數值' },
    { id: 'speedLabel', title: '估算速率標籤' },
    { id: 'profileTitle', title: '距離／速率曲線標題' },
    { id: 'profileBlock', title: '距離／速率雙曲線圖' },
    { id: 'footerBrand', title: '蕉流自潛設計' },
    { id: 'totalDistance', title: '總距離' },
    { id: 'averageSpeed', title: '平均速率' },
  ];
  /** Fields whose text changes with the video time. */
  const LIVE_IDS = new Set(['hudClock', 'distanceValue', 'elapsedValue', 'lapValue', 'speedValue']);
  const DISCIPLINES = ['DYN', 'DYNB', 'DNF'];
  const COUNTRIES = ['roc', 'hongkong', 'china', 'southkorea', 'malaysia', 'japan', 'chinesetaipei'];
  const FOOTER_TEXT = '蕉流自潛設計';
  const DEFAULT_POSITIONS = {
    hudBrand: { x: 18, y: 3 },
    hudClock: { x: 88, y: 3 },
    identityGroup: { x: 27, y: 76 },
    distanceValue: { x: 21, y: 18 },
    distanceUnit: { x: 43, y: 24 },
    elapsedValue: { x: 62, y: 21 },
    elapsedLabel: { x: 62, y: 15 },
    lapValue: { x: 85, y: 21 },
    lapLabel: { x: 85, y: 15 },
    speedValue: { x: 82, y: 71 },
    speedLabel: { x: 82, y: 66 },
    profileTitle: { x: 30, y: 82 },
    profileBlock: { x: 50, y: 89 },
    footerBrand: { x: 17, y: 96 },
    totalDistance: { x: 83, y: 96 },
    averageSpeed: { x: 82, y: 60 },
  };
  const DEFAULT_VISIBILITY = {
    hudBrand: false, hudClock: false, identityGroup: true,
    distanceValue: true, distanceUnit: true, elapsedValue: true,
    elapsedLabel: true, lapValue: true, lapLabel: true,
    speedValue: true, speedLabel: true, profileTitle: false,
    profileBlock: true, footerBrand: true, totalDistance: false,
    averageSpeed: false,
  };
  const SETTINGS_RANGES = {
    itemScale: [0.3, 3.0], rotation: [0, 359], opacity: [0.2, 1.0], fontScale: [0.7, 1.4],
    verticalOffset: [-15, 25], identityScale: [0.6, 1.8],
  };

  function defaultHudSettings() {
    const positions = {};
    const transforms = {};
    for (const item of HUD_ITEMS) {
      positions[item.id] = { ...DEFAULT_POSITIONS[item.id] };
      transforms[item.id] = { scale: 1, rotation: 0 };
    }
    return {
      positions, transforms, visibility: { ...DEFAULT_VISIBILITY },
      opacity: 0.90, fontScale: 0.90, verticalOffset: 0,
      displayName: 'name', country: 'chinesetaipei', identityScale: 0.80, discipline: 'DYNB',
    };
  }

  /** Fills missing keys and clamps values, like PoolHUDSettings.mergingDefaults(). */
  function mergeHudDefaults(input) {
    const defaults = defaultHudSettings();
    const src = input && typeof input === 'object' ? input : {};
    const num = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
    const result = {
      positions: {}, transforms: {}, visibility: {},
      opacity: clamp(num(src.opacity, defaults.opacity), 0.2, 1),
      fontScale: clamp(num(src.fontScale, defaults.fontScale), 0.7, 1.4),
      verticalOffset: clamp(num(src.verticalOffset, defaults.verticalOffset), -15, 25),
      displayName: typeof src.displayName === 'string' ? Array.from(src.displayName).slice(0, 30).join('') : defaults.displayName,
      country: COUNTRIES.includes(src.country) ? src.country : 'chinesetaipei',
      identityScale: clamp(num(src.identityScale, defaults.identityScale), 0.6, 1.8),
      discipline: DISCIPLINES.includes(src.discipline) ? src.discipline : 'DYNB',
    };
    for (const item of HUD_ITEMS) {
      const p = src.positions && src.positions[item.id];
      result.positions[item.id] = p && Number.isFinite(p.x) && Number.isFinite(p.y) ? { x: p.x, y: p.y } : { ...defaults.positions[item.id] };
      const t = src.transforms && src.transforms[item.id];
      result.transforms[item.id] = t && Number.isFinite(t.scale) && Number.isFinite(t.rotation)
        ? { scale: t.scale, rotation: t.rotation } : { scale: 1, rotation: 0 };
      const v = src.visibility && src.visibility[item.id];
      result.visibility[item.id] = typeof v === 'boolean' ? v : (DEFAULT_VISIBILITY[item.id] ?? true);
    }
    return result;
  }

  /** Rotation used by presets and ±90° buttons: within 7° of a right angle snaps to it. */
  function normalizeRotation(value, snap = true) {
    let degree = ((Number(value) % 360) + 360) % 360;
    if (!Number.isFinite(degree)) degree = 0;
    if (snap) {
      const nearest = roundHalfAway(degree / 90) * 90;
      const delta = Math.min(Math.abs(degree - nearest), 360 - Math.abs(degree - nearest));
      if (delta <= 7) degree = nearest % 360;
    }
    return degree;
  }

  /** Centre-to-centre snapping (2 % of the stage) and 1–99 % clamping used while dragging. */
  function snapDragPosition(settings, id, x, y) {
    let sx = x;
    let sy = y;
    for (const item of HUD_ITEMS) {
      if (item.id === id || !(settings.visibility[item.id] ?? true)) continue;
      const other = settings.positions[item.id];
      if (!other) continue;
      if (Math.abs(sx - other.x) < 2) sx = other.x;
      if (Math.abs(sy - other.y) < 2) sy = other.y;
    }
    return { x: clamp(sx, 1, 99), y: clamp(sy, 1, 99) };
  }

  /* ---------------- Distance / speed chart geometry (PoolProfileGeometry) ---------------- */

  class PoolProfileGeometry {
    constructor(timeline, width, height) {
      this.timeline = timeline;
      this.width = width;
      this.height = height;
      this.plot = { x: width * 0.12, y: height * 0.08, width: width * 0.76, height: height * 0.66 };
      this.plot.minX = this.plot.x; this.plot.maxX = this.plot.x + this.plot.width;
      this.plot.minY = this.plot.y; this.plot.maxY = this.plot.y + this.plot.height;
      this.plot.midY = this.plot.y + this.plot.height / 2;
    }
    /** Distance axis top: the final distance rounded up to a whole pool length. */
    get distanceLimit() {
      const t = this.timeline;
      return Math.max(t.poolLength, Math.ceil(t.finalDistance / t.poolLength - 1e-9) * t.poolLength);
    }
    /** Speed axis top, in 0.5 m/s steps with some headroom. */
    get speedLimit() { return Math.max(0.5, Math.ceil(this.timeline.maximumSegmentSpeed * 1.25 * 2) / 2); }
    xForTime(time) {
      const span = Math.max(0.001, this.timeline.totalTime);
      const fraction = clamp((time - this.timeline.startTime) / span, 0, 1);
      return this.plot.minX + fraction * this.plot.width;
    }
    yForDistance(distance) { return this.plot.maxY - clamp(distance / this.distanceLimit, 0, 1) * this.plot.height; }
    yForSpeed(speed) { return this.plot.maxY - clamp(speed / this.speedLimit, 0, 1) * this.plot.height; }
    get distancePoints() { return this.timeline.points.map((p) => ({ x: this.xForTime(p.time), y: this.yForDistance(p.distance) })); }
    /** Step line: each segment's average speed held flat across the segment. */
    get speedPoints() {
      const result = [];
      for (const s of this.timeline.segments) {
        const level = this.yForSpeed(s.speed);
        result.push({ x: this.xForTime(s.startTime), y: level }, { x: this.xForTime(s.endTime), y: level });
      }
      return result;
    }
  }
  PoolProfileGeometry.gridFractions = [0.25, 0.5, 0.75, 1.0];

  return {
    POOL_LENGTHS, FINAL_DISTANCE_RANGE, HUD_ITEMS, LIVE_IDS, DISCIPLINES, COUNTRIES, FOOTER_TEXT,
    DEFAULT_POSITIONS, DEFAULT_VISIBILITY, SETTINGS_RANGES,
    PoolSession, PoolTimeline, PoolTimelineError, PoolFormat, PoolProfileGeometry,
    nodeTitle, formatFixed, defaultHudSettings, mergeHudDefaults, normalizeRotation, snapDragPosition,
  };
});
