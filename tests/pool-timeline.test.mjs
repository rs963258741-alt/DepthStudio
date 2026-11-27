// Unit tests for pool-timeline.js (port of the iOS app's PoolTimeline.swift).
// Run with: node --test tests/pool-timeline.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const P = require('../pool-timeline.js');
const { PoolSession, PoolTimeline, PoolFormat, PoolProfileGeometry } = P;

const close = (actual, expected, eps = 1e-9) => assert.ok(Math.abs(actual - expected) < eps, `${actual} != ${expected}`);
const nodeAt = (session, distance) => session.nodes.find((n) => Math.abs(n.distance - distance) < 0.05);

test('demo matches the design example (50 m pool, 150 m in 2:28)', () => {
  const s = PoolSession.demo();
  assert.deepEqual(s.nodes.map((n) => [n.distance, n.kind, n.videoTime]),
    [[0, 'start', 2], [50, 'turn', 50], [100, 'turn', 100], [150, 'finish', 150]]);
  const t = new PoolTimeline(s);
  close(t.totalTime, 148);
  assert.equal(PoolFormat.speed(t.averageSpeed), '1.01');
  assert.equal(t.totalLaps, 3);
  assert.deepEqual(t.segments.map((x) => PoolFormat.speed(x.speed)), ['1.04', '1.00', '1.00']);
});

test('readings before, during and after the swim', () => {
  const t = new PoolTimeline(PoolSession.demo());
  assert.deepEqual(t.reading(1), { videoTime: 1, phase: 'beforeStart', distance: 0, elapsedSeconds: 0, speed: 0, lap: 1, totalLaps: 3 });
  const mid = t.reading(26);
  assert.equal(mid.phase, 'swimming');
  close(mid.distance, 25);
  close(mid.elapsedSeconds, 24);
  close(mid.speed, 50 / 48);
  assert.equal(PoolFormat.lap(mid), '01 / 03');
  assert.equal(t.reading(50).lap, 2);
  assert.equal(t.reading(125).lap, 3);
  close(t.reading(125).distance, 125);
  const end = t.reading(150);
  assert.equal(end.phase, 'finished');
  assert.equal(end.distance, 150);
  assert.equal(end.elapsedSeconds, 148);
  assert.equal(end.speed, 0);
  assert.equal(end.lap, 3);
  assert.equal(t.reading(Number.NaN).phase, 'beforeStart');
});

test('final distance that is not a whole pool length keeps the finish time', () => {
  const s = PoolSession.demo();
  s.setFinalDistance(137.5);
  assert.deepEqual(s.nodes.map((n) => [n.distance, n.kind, n.videoTime]),
    [[0, 'start', 2], [50, 'turn', 50], [100, 'turn', 100], [137.5, 'finish', 150]]);
  const t = new PoolTimeline(s);
  assert.equal(t.totalLaps, 3);
  assert.equal(PoolFormat.distance(t.reading(150).distance), '137.5');
  s.setFinalDistance(5000);
  assert.equal(s.finalDistance, 1000);
  s.setFinalDistance(0);
  assert.equal(s.finalDistance, 1);
  s.setFinalDistance(Number.NaN);
  assert.equal(s.finalDistance, 1);
  s.setFinalDistance(42.26);
  assert.equal(s.finalDistance, 42.3);
});

test('changing the pool length regenerates turns and keeps matching times', () => {
  const s = PoolSession.demo();
  s.setPoolLength(25);
  assert.deepEqual(s.nodes.map((n) => [n.distance, n.videoTime]),
    [[0, 2], [25, null], [50, 50], [75, null], [100, 100], [125, null], [150, 150]]);
  s.setPoolLength(33);
  assert.equal(s.poolLength, 25);
  assert.equal(new PoolTimeline(s).totalLaps, 6);
});

test('checkpoints: add, reject duplicates / out of range, survive rebuild, remove', () => {
  const s = PoolSession.demo();
  assert.equal(s.addCheckpoint(75, 75), true);
  assert.equal(s.addCheckpoint(75), false);
  assert.equal(s.addCheckpoint(0), false);
  assert.equal(s.addCheckpoint(150), false);
  assert.equal(s.addCheckpoint(-3), false);
  assert.equal(s.addCheckpoint(50.02), false);
  const t = new PoolTimeline(s);
  assert.equal(t.segments.length, 4);
  close(t.reading(87.5).distance, 87.5);
  s.setPoolLength(25); // 75 m becomes a turn distance -> the checkpoint is dropped, the turn has no time
  assert.equal(nodeAt(s, 75).kind, 'turn');
  const s2 = PoolSession.demo();
  s2.addCheckpoint(30, 32);
  s2.setFinalDistance(20);
  assert.equal(s2.nodes.some((n) => n.kind === 'checkpoint'), false);
  const s3 = PoolSession.demo();
  s3.addCheckpoint(60);
  const cp = nodeAt(s3, 60);
  s3.removeNode(nodeAt(s3, 50).id); // turns cannot be removed
  assert.ok(nodeAt(s3, 50));
  s3.removeNode(cp.id);
  assert.equal(nodeAt(s3, 60), undefined);
});

test('setTime rounds to 0.01 s and clamps at 0', () => {
  const s = PoolSession.demo();
  const start = s.nodes[0];
  s.setTime(1.23456, start.id);
  assert.equal(start.videoTime, 1.23);
  s.setTime(-4, start.id);
  assert.equal(start.videoTime, 0);
  s.setTime(Infinity, start.id);
  assert.equal(start.videoTime, null);
  s.clearAllTimes();
  assert.equal(s.hasAnyTime, false);
});

test('timeline errors match the app messages', () => {
  const s = PoolSession.demo();
  s.setTime(null, s.nodes[0].id);
  assert.throws(() => new PoolTimeline(s), { code: 'missingStart', message: '請先標記「0 m 出發」的影片時間。' });
  const s2 = PoolSession.demo();
  s2.setTime(null, s2.nodes[3].id);
  assert.throws(() => new PoolTimeline(s2), { code: 'missingFinish', message: '請標記「結束出水」的影片時間。' });
  const s3 = PoolSession.demo();
  s3.setTime(40, nodeAt(s3, 100).id);
  assert.throws(() => new PoolTimeline(s3), { code: 'timeNotIncreasing', message: '100.0 m 的時間必須晚於前一個節點。' });
  // A turn without a time is skipped: distance is interpolated across it.
  const s4 = PoolSession.demo();
  s4.setTime(null, nodeAt(s4, 50).id);
  const t4 = new PoolTimeline(s4);
  assert.equal(t4.segments.length, 2);
  const result = PoolTimeline.tryCreate(s);
  assert.equal(result.timeline, null);
  assert.equal(result.error.code, 'missingStart');
});

test('formatting matches Swift String(format:)', () => {
  assert.equal(PoolFormat.clock(148.9), '02:28');
  assert.equal(PoolFormat.clock(-3), '00:00');
  assert.equal(PoolFormat.clock(6000), '100:00');
  assert.equal(PoolFormat.preciseClock(100.46), '01:40.5');
  assert.equal(PoolFormat.preciseClock(59.96), '01:00.0');
  assert.equal(PoolFormat.distance(0.25), '0.2');   // exact tie rounds to even, like printf
  assert.equal(PoolFormat.distance(0.75), '0.8');
  assert.equal(PoolFormat.distance(137.5), '137.5');
  assert.equal(PoolFormat.speed(1.125), '1.12');
  assert.equal(PoolFormat.speed(1.375), '1.38');
  assert.equal(PoolFormat.speed(1.0135135), '1.01');
});

test('parseTime accepts the same inputs as the app', () => {
  assert.equal(PoolFormat.parseTime('150'), 150);
  assert.equal(PoolFormat.parseTime('2:30'), 150);
  assert.equal(PoolFormat.parseTime('02:30.5'), 150.5);
  assert.equal(PoolFormat.parseTime('1:02:30'), 3750);
  assert.equal(PoolFormat.parseTime(' 01：40.5 '), 100.5);
  assert.equal(PoolFormat.parseTime('.5'), 0.5);
  for (const bad of ['', 'abc', '1:', ':30', '1:2:3:4', '-5', '1:-2', 'nan', 'inf']) {
    assert.equal(PoolFormat.parseTime(bad), null, bad);
  }
});

test('chart geometry: axis limits and step speed line', () => {
  const t = new PoolTimeline(PoolSession.demo());
  const g = new PoolProfileGeometry(t, 1000, 200);
  assert.equal(g.distanceLimit, 150);
  assert.equal(g.speedLimit, 1.5);
  close(g.xForTime(2), 120);
  close(g.xForTime(150), 880);
  close(g.xForTime(999), 880);
  close(g.yForDistance(150), 16);
  close(g.yForDistance(0), 148);
  assert.equal(g.speedPoints.length, 6);
  const s = PoolSession.demo();
  s.setFinalDistance(137.5);
  assert.equal(new PoolProfileGeometry(new PoolTimeline(s), 100, 100).distanceLimit, 150);
});

test('HUD settings: 16 items, defaults, merge and clamping', () => {
  assert.equal(P.HUD_ITEMS.length, 16);
  const d = P.defaultHudSettings();
  assert.deepEqual(d.positions.distanceValue, { x: 21, y: 18 });
  assert.equal(d.visibility.footerBrand, true);
  assert.equal(d.visibility.averageSpeed, false);
  assert.equal(d.discipline, 'DYNB');
  const merged = P.mergeHudDefaults({ opacity: 5, fontScale: 0.1, verticalOffset: 99, identityScale: 9,
    discipline: 'CWT', country: 'mars', displayName: 'x'.repeat(40), positions: { hudBrand: { x: 3, y: 4 } } });
  assert.equal(merged.opacity, 1);
  assert.equal(merged.fontScale, 0.7);
  assert.equal(merged.verticalOffset, 25);
  assert.equal(merged.identityScale, 1.8);
  assert.equal(merged.discipline, 'DYNB');
  assert.equal(merged.country, 'chinesetaipei');
  assert.equal(merged.displayName.length, 30);
  assert.deepEqual(merged.positions.hudBrand, { x: 3, y: 4 });
  assert.deepEqual(merged.positions.lapValue, { x: 85, y: 21 });
});

test('rotation snapping and drag snapping', () => {
  assert.equal(P.normalizeRotation(-90), 270);
  assert.equal(P.normalizeRotation(95), 90);
  assert.equal(P.normalizeRotation(355), 0);
  assert.equal(P.normalizeRotation(95, false), 95);
  assert.equal(P.normalizeRotation(450), 90);
  const settings = P.defaultHudSettings();
  // lapValue sits at (85, 21); dragging elapsedValue near it snaps the centre.
  assert.deepEqual(P.snapDragPosition(settings, 'elapsedValue', 84, 20.5), { x: 85, y: 21 });
  assert.deepEqual(P.snapDragPosition(settings, 'elapsedValue', -10, 150), { x: 1, y: 99 });
});
