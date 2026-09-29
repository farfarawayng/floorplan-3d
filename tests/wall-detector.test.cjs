const test = require('node:test');
const assert = require('node:assert/strict');
const {detect} = require('../wall-detector.js');

function raster(width = 240, height = 200, background = [255, 255, 255, 255]) {
  const image = {width, height, data: new Uint8ClampedArray(width * height * 4)};
  for (let p = 0; p < image.data.length; p += 4) image.data.set(background, p);
  image.rect = (x0, y0, x1, y1, color = [30, 30, 30, 255]) => {
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) image.data.set(color, (y * width + x) * 4);
  };
  return image;
}

function covers(walls, x, y) {
  return walls.some(w => x >= w[0] && x < w[2] && y >= w[1] && y < w[3]);
}

test('solid walls preserve a doorway and exclude one-pixel dimension lines', () => {
  const img = raster();
  img.rect(15, 40, 95, 48);
  img.rect(120, 40, 220, 48);
  img.rect(10, 20, 230, 21);
  const {walls} = detect(img);
  assert.ok(covers(walls, 50, 44));
  assert.ok(covers(walls, 160, 44));
  for (let x = 95; x < 120; x++) assert.equal(covers(walls, x, 44), false);
  assert.equal(covers(walls, 100, 20), false);
});

test('connected L and T junctions survive without filling room corners', () => {
  const img = raster();
  img.rect(20, 30, 200, 38);
  img.rect(20, 30, 28, 170);
  img.rect(110, 30, 118, 170);
  const {walls} = detect(img);
  for (const point of [[24, 34], [80, 34], [24, 100], [114, 100]]) assert.ok(covers(walls, ...point));
  assert.equal(covers(walls, 40, 50), false);
  assert.equal(covers(walls, 105, 50), false);
});

test('brown walls on cream background work, thick furniture and text-size strokes are rejected', () => {
  const img = raster(240, 200, [235, 229, 199, 255]);
  img.rect(10, 20, 220, 28, [95, 48, 30, 255]);
  img.rect(40, 70, 150, 130, [65, 65, 65, 255]);
  img.rect(175, 90, 181, 105);
  const {walls} = detect(img);
  assert.ok(covers(walls, 100, 24));
  assert.equal(covers(walls, 70, 90), false);
  assert.equal(covers(walls, 178, 99), false);
});

test('white and transparent images yield no candidates', () => {
  assert.equal(detect(raster()).walls.length, 0);
  assert.equal(detect(raster(100, 100, [0, 0, 0, 0])).walls.length, 0);
});

test('outline pairs horizontal and vertical strokes but preserves opening', () => {
  const img = raster();
  for (const [x0, x1] of [[10, 90], [120, 210]]) {
    img.rect(x0, 20, x1, 22);
    img.rect(x0, 30, x1, 32);
  }
  img.rect(30, 70, 32, 180);
  img.rect(40, 70, 42, 180);
  assert.equal(detect(img).walls.length, 0);
  const result = detect(img, {mode: 'outline'});
  assert.ok(covers(result.walls, 50, 26));
  assert.ok(covers(result.walls, 160, 26));
  assert.ok(covers(result.walls, 36, 120));
  assert.equal(covers(result.walls, 105, 26), false);
  assert.ok(result.warnings.some(message => message.includes('柜体')));
});

test('brightness can be tuned, image input remains unchanged', () => {
  const img = raster();
  img.rect(10, 30, 220, 38, [130, 130, 130, 255]);
  const before = img.data.slice();
  assert.equal(detect(img).walls.length, 0);
  assert.ok(detect(img, {threshold: 150}).walls.length);
  assert.deepEqual(img.data, before);
});

test('invalid image data and parameters are rejected', () => {
  assert.throws(() => detect({width: 20, height: 20, data: []}), TypeError);
  assert.throws(() => detect(raster(), {minThickness: 30, maxThickness: 10}), RangeError);
  assert.throws(() => detect(raster(), {threshold: NaN}), RangeError);
  assert.throws(() => detect(raster(), {mode: 'magic'}), RangeError);
});

test('normalization caps output for dense drawings and gives a warning', () => {
  const img = raster(1400, 1400);
  for (let y = 5; y < 1390; y += 20) for (let x = 5; x < 1360; x += 50) img.rect(x, y, x + 35, y + 4);
  const {walls, warnings} = detect(img);
  assert.equal(walls.length, 600);
  assert.ok(warnings.some(message => message.includes('600')));
});
