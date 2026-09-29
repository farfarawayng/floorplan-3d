const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Execute the actual architecture/state section, including its real validators,
// save, history and import implementation. Rendering and browser storage are
// boundary stubs; no validation or state-transition logic is reproduced here.
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const start = html.indexOf('let WALLS = [');
const end = html.indexOf('/* ======================= 几何工具', start);
assert.ok(start >= 0 && end > start, 'application state section must be present');
const source = html.slice(start, end);
const plain = value => JSON.parse(JSON.stringify(value));

function harness() {
  const messages = [], storage = new Map();
  let failStorage = false, renderCount = 0, writes = 0;
  const context = vm.createContext({
    window: {},
    document: {querySelector: () => null},
    matchMedia: () => ({matches: false}),
    localStorage: {
      getItem: key => storage.get(key) ?? null,
      setItem: (key, value) => {
        if (failStorage) throw new Error('QuotaExceededError');
        storage.set(key, value);
        writes++;
      },
    },
    tr: chinese => chinese,
    toast: (message, duration) => messages.push({message, duration}),
    renderAll: () => { renderCount++; },
  });
  vm.runInContext(source, context, {filename: 'index.html:architecture-state'});
  const api = vm.runInContext(`({
    validate: validateCustomPlan,
    apply: window.loadCustomWalls,
    getPlan: window.getCustomPlan,
    snapshot: () => JSON.parse(snap()),
    seed: value => { state = fixState(value); },
    history: () => ({undo: undoStack.length, redo: redoStack.length}),
    undo,
    redo
  })`, context);
  return {
    ...api, messages, storage,
    failStorage: () => { failStorage = true; },
    renderCount: () => renderCount,
    writes: () => writes,
  };
}

function plan() {
  return {
    version: 1, name: '测试户型', height: 2800, calibrated: true,
    bounds: {x: 0, y: 0, w: 1000, h: 800},
    walls: [[0, 0, 1000, 100, 'b'], [0, 100, 100, 800, 'n']],
    editor: {width: 100, height: 80, mmPerPixel: 10, image: 'data:image/png;base64,AAAA'},
  };
}

function furnishedState() {
  return {
    plan: plan(), rooms: {}, demolished: [],
    furniture: [{id: 'f1', type: 'chair', name: '椅子', cx: 350, cy: 350, w: 400, d: 400, rot: 0, color: '#cccccc'}],
    measures: [{a: {x: 100, y: 100}, b: {x: 500, y: 100}}],
  };
}

test('valid custom plan is copied and structural wall labels are discarded', () => {
  const app = harness(), input = plan(), before = plain(input);
  const accepted = app.validate(input);
  assert.deepEqual(plain(accepted.walls), [[0, 0, 1000, 100, 'u'], [0, 100, 100, 800, 'u']]);
  assert.deepEqual(input, before);
  accepted.walls[0][0] = 50;
  accepted.bounds.w = 900;
  assert.deepEqual(input, before, 'validated data must not alias input geometry');
});

test('invalid walls, bounds, height and editor scale are rejected', () => {
  const app = harness();
  const invalid = [
    p => { p.walls = []; },
    p => { p.walls = Array.from({length: 3001}, () => [0, 0, 10, 10]); },
    p => { p.walls[0][2] = 0; },
    p => { p.walls[0][0] = -10; },
    p => { p.walls[0][2] = 1001; },
    p => { p.walls[0][1] = NaN; },
    p => { p.walls[0][1] = '0'; },
    p => { p.bounds.w = 0; },
    p => { p.bounds.x = Infinity; },
    p => { p.height = 1700; },
    p => { p.height = 10001; },
    p => { p.editor.mmPerPixel = 12; },
    p => { p.editor.width = 99; },
    p => { p.editor.height = 0; },
    p => { p.editor.image = 'https://example.com/plan.png'; },
    p => { p.editor.image = 'data:image/svg+xml;base64,AAAA'; },
  ];
  for (const change of invalid) {
    const input = plan();
    change(input);
    assert.throws(() => app.validate(input), /户型数据无效/, change.toString());
  }
});

test('editing same bounds with preserveLayout keeps furniture and measurements', () => {
  const app = harness();
  app.seed(furnishedState());
  const before = plain(app.snapshot()), edited = plan();
  edited.walls[0][3] = 120;
  assert.equal(app.apply(edited, {preserveLayout: true}), true);
  const after = plain(app.snapshot());
  assert.deepEqual(after.furniture, before.furniture);
  assert.deepEqual(after.measures, before.measures);
  assert.equal(after.plan.walls[0][3], 120);
  assert.equal(app.writes(), 1);
  assert.equal(app.renderCount(), 1);
  assert.deepEqual(plain(app.history()), {undo: 1, redo: 0});
});

test('changed bounds invalidate placement even if preservation was requested', () => {
  const app = harness();
  app.seed(furnishedState());
  const replacement = plan();
  replacement.bounds.w = 1100;
  replacement.editor.width = 110;
  app.apply(replacement, {preserveLayout: true});
  assert.deepEqual(plain(app.snapshot().furniture), []);
  assert.deepEqual(plain(app.snapshot().measures), []);
});

test('a new import with identical bounds clears old placements by default', () => {
  const app = harness();
  app.seed(furnishedState());
  app.apply(plan());
  assert.deepEqual(plain(app.snapshot().furniture), []);
  assert.deepEqual(plain(app.snapshot().measures), []);
});

test('invalid import leaves state, storage and undo history untouched', () => {
  const app = harness();
  app.seed(furnishedState());
  const before = plain(app.snapshot()), invalid = plan();
  invalid.walls[0][2] = 2000;
  assert.throws(() => app.apply(invalid), /户型数据无效/);
  assert.deepEqual(plain(app.snapshot()), before);
  assert.deepEqual(plain(app.history()), {undo: 0, redo: 0});
  assert.equal(app.writes(), 0);
  assert.equal(app.renderCount(), 0);
  assert.equal(app.messages.length, 0);
});

test('storage failure stays visible instead of being replaced with success toast', () => {
  const app = harness();
  app.seed(furnishedState());
  app.failStorage();
  assert.equal(app.apply(plan()), false);
  assert.equal(app.snapshot().plan.name, '测试户型', 'failed persistence does not discard the in-memory result');
  assert.equal(app.renderCount(), 1);
  assert.equal(app.writes(), 0);
  assert.equal(app.messages.length, 1);
  assert.match(app.messages[0].message, /未能保存/);
  assert.doesNotMatch(app.messages[0].message, /已生成墙体模型/);
  assert.equal(app.messages[0].duration, 8000);
});

test('undo and redo restore complete custom plan and furniture state', () => {
  const app = harness();
  app.seed(furnishedState());
  const before = plain(app.snapshot()), replacement = plan();
  replacement.name = '另一户型';
  replacement.walls[0][3] = 120;
  app.apply(replacement);
  const after = plain(app.snapshot());
  app.undo();
  assert.deepEqual(plain(app.snapshot()), before);
  app.redo();
  assert.deepEqual(plain(app.snapshot()), after);
  const exported = app.getPlan();
  exported.walls[0][3] = 777;
  assert.equal(app.snapshot().plan.walls[0][3], 120, 'editor retrieval must be isolated from stored geometry');
});
