// The loading screen (src/loading.js): the counter behind its bar - totals, a bar that never goes backwards, failures
// that count - and the order in which the screen waits, warms the world up and lets go.
// Run: node --test test/loading.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createProgress, createLoadingScreen, loading, TIPS } from '../src/loading.js';

// ---------------------------------------------------------------- the counter

test('the counter adds up what was announced and what is through', () => {
  const p = createProgress();
  p.expect('map').expect('monsters', 8).expect('treasure', 3);
  assert.equal(p.total, 12);
  assert.equal(p.done, 0);
  assert.equal(p.left(), 12);
  p.settle('map');
  p.settle('monsters', true, 3);
  assert.equal(p.done, 4);
  assert.equal(p.left(), 8);
  assert.equal(p.left(['monsters']), 5);
  assert.equal(p.left(['map']), 0);
  assert.deepEqual(p.groups().monsters, { total: 8, done: 3, failed: 0 });
});

test('a file that fails counts like one that loads, and is remembered', () => {
  const p = createProgress();
  p.expect('treasure', 3).seal();
  p.settle('treasure');
  p.settle('treasure', false);
  p.settle('treasure', false);
  assert.equal(p.done, 3);
  assert.equal(p.failed, 2);
  assert.equal(p.left(), 0);
  assert.equal(p.fraction, 1);
});

test('the bar never goes backwards, also when a late group makes the total grow', () => {
  const p = createProgress();
  p.expect('a', 4).seal();
  p.settle('a', true, 2);
  assert.equal(p.fraction, 0.5);
  p.expect('late', 96);   // 2 of 100 now
  assert.equal(p.done / p.total, 0.02);
  assert.equal(p.fraction, 0.5, 'the bar holds where it was');
  let last = p.fraction;
  for (let i = 0; i < 98; i++) {
    p.settle(i < 2 ? 'a' : 'late');
    assert.ok(p.fraction >= last);
    last = p.fraction;
  }
  assert.equal(p.fraction, 1);
});

test('until the list is complete the bar keeps to its first twentieth', () => {
  const p = createProgress();
  p.expect('engine').expect('map');
  p.settle('engine');
  assert.equal(p.sealed, false);
  assert.equal(p.fraction, 0.05, 'one of two, but the map will bring a hundred more');
  p.settle('map').expect('scenery', 98).seal();
  assert.equal(p.sealed, true);
  assert.equal(p.fraction, 0.05, '2 of 100 is behind where the bar stands');
  p.settle('scenery', true, 8);
  assert.equal(p.fraction, 0.1);
});

test('done never passes the total and never falls', () => {
  const p = createProgress();
  p.expect('a', 2);
  p.settle('a').settle('a').settle('a');   // one more than announced: counted, and the total follows
  assert.equal(p.done, 3);
  assert.equal(p.total, 3);
  p.settle('unknown');
  assert.equal(p.total, 4);
  p.settle('a', true, -5);
  p.settle('a', true, NaN);
  p.expect('a', -2);
  assert.equal(p.done, 4);
  assert.equal(p.total, 4);
});

test('a loader\'s own onProgress moves a group forward only', () => {
  const p = createProgress();
  p.expect('scenery', 130).seal();
  p.reach('scenery', 10, 130);
  p.reach('scenery', 7, 130);   // callbacks may come out of order
  assert.equal(p.done, 10);
  p.reach('scenery', 131, 131);   // the loader found one more file than was announced
  assert.equal(p.total, 131);
  assert.equal(p.done, 131);
  assert.equal(p.left(), 0);
});

test('an empty counter is at zero, not at NaN', () => {
  const p = createProgress();
  assert.equal(p.fraction, 0);
  assert.equal(p.seal().fraction, 0);
  assert.equal(p.left(), 0);
});

// ---------------------------------------------------------------- the screen

test('without a page the screen still counts, waits and lets go', async () => {
  assert.equal(loading, null, 'node has no document');
  const doc = { getElementById: () => null };
  const screen = createLoadingScreen(doc, { now: () => 0 });
  screen.step('engine');
  screen.expect({ map: 1, treasure: 2 });
  const order = [];
  screen.ready.then(() => order.push('ready'));
  const finished = screen.finish({
    grow: () => { order.push('grow'); return false; },
    compile: async () => { order.push('compile'); },
    frame: () => order.push('frame'),
  });
  await new Promise((resolve) => { setTimeout(resolve, 5); });
  assert.deepEqual(order, [], 'nothing is warmed up while files are out');
  screen.step('map');
  await screen.track('treasure', Promise.resolve(1));
  await screen.track('treasure', Promise.reject(new Error('404'))).catch(() => {});
  await finished;
  assert.deepEqual(order, ['grow', 'compile', 'frame', 'frame', 'frame', 'frame', 'ready']);
  assert.equal(screen.state, 'done');
  assert.equal(screen.progress.failed, 1);
  assert.equal(screen.progress.left(), 0);
});

test('a warm-up that throws does not keep the screen', async () => {
  const screen = createLoadingScreen({ getElementById: () => null }, { now: () => 0 });
  screen.step('engine');
  await screen.finish({ compile: () => { throw new Error('no WebGL'); } });
  assert.equal(screen.state, 'done');
  assert.equal(screen.progress.left(), 0);
  assert.ok(screen.progress.failed >= 1);
});

test('the tips are sentences of a sane length', () => {
  assert.ok(TIPS.length >= 10 && TIPS.length <= 20);
  for (const tip of TIPS) {
    assert.ok(tip.length > 20 && tip.length <= 130, tip);
    assert.match(tip, /[.!]$/, tip);
  }
  assert.equal(new Set(TIPS).size, TIPS.length);
});
