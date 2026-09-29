/* Local geometric wall candidates, not semantic/AI recognition. Coordinates are
 * image pixels; x1/y1 are exclusive. Works as a browser script and in Node. */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.WallDetector = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const MAX_PIXELS = 16000000;
  const MAX_WALLS = 600;

  function numberOption(value, fallback, min, max) {
    if (value === undefined) return fallback;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
      throw new RangeError('识别参数超出范围');
    }
    return value;
  }

  // Retain long contiguous dark runs. No closing is applied along a wall: an
  // actual white doorway remains a gap rather than being silently bridged.
  function directionalMask(binary, width, height, vertical, minLength) {
    const result = new Uint8Array(binary.length);
    const along = vertical ? height : width;
    const across = vertical ? width : height;
    const step = vertical ? width : 1;
    for (let c = 0; c < across; c++) {
      const base = vertical ? c : c * width;
      let start = -1;
      for (let a = 0; a <= along; a++) {
        if (a < along && binary[base + a * step]) {
          if (start < 0) start = a;
        } else if (start >= 0) {
          if (a - start >= minLength) {
            for (let k = start; k < a; k++) result[base + k * step] = 1;
          }
          start = -1;
        }
      }
    }
    return result;
  }

  // Optionally fill the space between nearby thin parallel strokes. Looking
  // across, rather than along, a wall preserves openings between segments.
  function crossFilter(mask, width, height, vertical, minThickness, maxThickness, outline) {
    const along = vertical ? height : width;
    const across = vertical ? width : height;
    const crossStep = vertical ? 1 : width;
    const lineLimit = Math.max(2, Math.min(4, Math.ceil(minThickness)));
    for (let a = 0; a < along; a++) {
      const base = vertical ? a * width : a;
      const bands = [];
      let start = -1;
      for (let c = 0; c <= across; c++) {
        if (c < across && mask[base + c * crossStep]) {
          if (start < 0) start = c;
        } else if (start >= 0) {
          bands.push([start, c]);
          start = -1;
        }
      }
      // Read original bands first, so a filled pair never chains into a third
      // stroke and never expands into a large dark furnishing/background.
      const keep = [];
      for (let i = 0; i < bands.length; i++) {
        const band = bands[i], thickness = band[1] - band[0];
        const next = bands[i + 1];
        if (outline && next && thickness <= lineLimit && next[1] - next[0] <= lineLimit &&
            next[0] > band[1] && next[1] - band[0] >= minThickness && next[1] - band[0] <= maxThickness) {
          keep.push([band[0], next[1]]);
          i++;
        } else if (thickness >= minThickness && thickness <= maxThickness) {
          keep.push(band);
        }
      }
      for (let c = 0; c < across; c++) mask[base + c * crossStep] = 0;
      for (const band of keep) {
        for (let c = band[0]; c < band[1]; c++) mask[base + c * crossStep] = 1;
      }
    }
  }

  function rectangles(mask, width, height, vertical, minLength, minThickness, maxThickness) {
    const along = vertical ? height : width;
    const across = vertical ? width : height;
    const step = vertical ? width : 1;
    const result = [];
    let active = [];
    const finish = rect => {
      if (rect.end - rect.start < minThickness || rect.end - rect.start > maxThickness ||
          rect.hi - rect.lo < minLength) return;
      result.push(vertical ? [rect.start, rect.lo, rect.end, rect.hi, 'u'] :
        [rect.lo, rect.start, rect.hi, rect.end, 'u']);
    };
    for (let c = 0; c <= across; c++) {
      const base = vertical ? c : c * width;
      const runs = [];
      let start = -1;
      if (c < across) {
        for (let a = 0; a <= along; a++) {
          if (a < along && mask[base + a * step]) {
            if (start < 0) start = a;
          } else if (start >= 0) {
            if (a - start >= minLength) runs.push([start, a]);
            start = -1;
          }
        }
      }
      const next = [], matched = new Set();
      for (const run of runs) {
        let best = -1, bestOverlap = 0;
        for (let i = 0; i < active.length; i++) {
          if (matched.has(i)) continue;
          const rect = active[i];
          const overlap = Math.min(rect.hi, run[1]) - Math.max(rect.lo, run[0]);
          // Intersections produce conservative boxes, not bounding boxes that
          // would turn white gaps or the outside of an L corner into wall.
          if (overlap >= minLength && overlap >= 0.85 * Math.max(rect.hi - rect.lo, run[1] - run[0]) &&
              Math.abs(rect.lo - run[0]) <= maxThickness && Math.abs(rect.hi - run[1]) <= maxThickness &&
              overlap > bestOverlap) {
            best = i;
            bestOverlap = overlap;
          }
        }
        if (best >= 0) {
          const rect = active[best];
          matched.add(best);
          next.push({lo: Math.max(rect.lo, run[0]), hi: Math.min(rect.hi, run[1]), start: rect.start, end: c + 1});
        } else next.push({lo: run[0], hi: run[1], start: c, end: c + 1});
      }
      for (let i = 0; i < active.length; i++) if (!matched.has(i)) finish(active[i]);
      active = next;
    }
    return result;
  }

  function detect(imageData, options) {
    options = options || {};
    if (!imageData || !Number.isInteger(imageData.width) || !Number.isInteger(imageData.height) ||
        imageData.width < 1 || imageData.height < 1 || imageData.width * imageData.height > MAX_PIXELS ||
        !imageData.data || imageData.data.length !== imageData.width * imageData.height * 4) {
      throw new TypeError('需要有效的 RGBA 图片数据（最多 1600 万像素）');
    }
    const width = imageData.width, height = imageData.height;
    const threshold = numberOption(options.threshold, 100, 0, 255);
    const minThickness = Math.ceil(numberOption(options.minThickness, 3, 1, 200));
    const maxThickness = Math.floor(numberOption(options.maxThickness, 24, 1, 500));
    const minLength = Math.ceil(numberOption(options.minLength, 30, 2, 10000));
    const mode = options.mode === undefined ? 'solid' : options.mode;
    if (maxThickness < minThickness || (mode !== 'solid' && mode !== 'outline')) {
      throw new RangeError('墙厚范围或识别模式无效');
    }
    const binary = new Uint8Array(width * height);
    let darkPixels = 0;
    for (let i = 0; i < binary.length; i++) {
      const p = i * 4, alpha = imageData.data[p + 3] / 255;
      const luminance = 0.2126 * imageData.data[p] + 0.7152 * imageData.data[p + 1] + 0.0722 * imageData.data[p + 2];
      // Canvas transparency is composited onto white, not treated as black.
      if (luminance * alpha + 255 * (1 - alpha) <= threshold) {
        binary[i] = 1;
        darkPixels++;
      }
    }
    let candidates = [];
    for (const vertical of [false, true]) {
      const mask = directionalMask(binary, width, height, vertical, minLength);
      crossFilter(mask, width, height, vertical, minThickness, maxThickness, mode === 'outline');
      candidates = candidates.concat(rectangles(mask, width, height, vertical, minLength, minThickness, maxThickness));
    }
    // Keep larger candidates first when a busy image exceeds the safety cap.
    candidates.sort((a, b) => (b[2] - b[0]) * (b[3] - b[1]) - (a[2] - a[0]) * (a[3] - a[1]));
    const walls = [];
    for (const wall of candidates) {
      if (walls.some(other => wall[0] >= other[0] && wall[1] >= other[1] && wall[2] <= other[2] && wall[3] <= other[3])) continue;
      walls.push(wall);
      if (walls.length === MAX_WALLS) break;
    }
    const warnings = ['这是基于颜色和直线几何的墙体候选，家具、文字和装饰可能误识别；生成前请在原图上检查并修正。'];
    if (mode === 'outline') warnings.push('双线模式会将相邻平行线之间填为墙体，柜体、窗框或标注也可能被填入。');
    if (!walls.length) warnings.push('未检测到符合条件的墙段，请调整深色阈值、最短墙段或墙厚范围，或手动补画。');
    if (walls.length === MAX_WALLS && candidates.length > MAX_WALLS) warnings.push('候选过多，已保留面积较大的 600 段；请裁剪户型主体并调整识别参数。');
    if (darkPixels / binary.length > 0.5) warnings.push('图片中深色区域超过一半，请降低深色阈值或裁剪背景。');
    return {walls, warnings, stats: {width, height, mode, darkPixels, candidateCount: candidates.length, wallCount: walls.length}};
  }

  return Object.freeze({detect});
});
