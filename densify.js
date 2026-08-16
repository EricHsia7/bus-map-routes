'use strict';

/**
 * Tile-grid densification - the key to exact cross-tile continuity.
 *
 * Problem
 * -------
 * If a segment is longer than the tile buffer and spans a tile boundary, each
 * tile clips it at a *different* place (`+buffer` on one side, `-buffer` on the
 * other). Quantising those two different endpoints independently moves the
 * implied boundary crossing by a fraction of a unit in each tile, which shows
 * up as a visible kink or hairline gap at the seam.
 *
 * Solution
 * --------
 * Before quantising, insert an explicit vertex wherever the polyline crosses a
 * tile grid line (x = k*extent, y = k*extent) in *world* space. Because the
 * insertion happens once, in a shared coordinate space, both neighbouring tiles
 * inherit the identical vertex: one sees it at local `extent`, the other at
 * local `0`, with a bit-identical cross-axis value. Quantisation then cannot
 * pull them apart, since a grid crossing already sits on an integer grid line.
 */

/**
 * @param {Float64Array} xs world-extent X
 * @param {Float64Array} ys world-extent Y
 * @param {number} length
 * @param {number} extent tile extent in world units
 * @returns {{xs: Float64Array, ys: Float64Array, length: number}}
 */
function densifyAtTileGrid(xs, ys, length, extent) {
  if (length < 2) return { xs, ys, length };

  const outX = [];
  const outY = [];
  const crossings = [];

  for (let i = 1; i < length; i++) {
    const ax = xs[i - 1];
    const ay = ys[i - 1];
    const bx = xs[i];
    const by = ys[i];

    outX.push(ax);
    outY.push(ay);

    crossings.length = 0;

    // Vertical grid lines strictly between ax and bx.
    if (ax !== bx) {
      const lowX = Math.min(ax, bx);
      const highX = Math.max(ax, bx);
      const firstK = Math.floor(lowX / extent) + 1;
      const lastK = Math.ceil(highX / extent) - 1;
      for (let k = firstK; k <= lastK; k++) {
        const gridX = k * extent;
        const t = (gridX - ax) / (bx - ax);
        if (t > 0 && t < 1) crossings.push([t, gridX, ay + t * (by - ay), 0]);
      }
    }

    // Horizontal grid lines strictly between ay and by.
    if (ay !== by) {
      const lowY = Math.min(ay, by);
      const highY = Math.max(ay, by);
      const firstK = Math.floor(lowY / extent) + 1;
      const lastK = Math.ceil(highY / extent) - 1;
      for (let k = firstK; k <= lastK; k++) {
        const gridY = k * extent;
        const t = (gridY - ay) / (by - ay);
        if (t > 0 && t < 1) crossings.push([t, ax + t * (bx - ax), gridY, 1]);
      }
    }

    if (crossings.length > 1) crossings.sort((a, b) => a[0] - b[0]);
    for (let c = 0; c < crossings.length; c++) {
      outX.push(crossings[c][1]);
      outY.push(crossings[c][2]);
    }
  }

  outX.push(xs[length - 1]);
  outY.push(ys[length - 1]);

  return { xs: Float64Array.from(outX), ys: Float64Array.from(outY), length: outX.length };
}

/**
 * Quantise to integers in *world* space and drop collapsed vertices.
 *
 * Rounding in world space (rather than per tile) is what makes a vertex land on
 * the same integer for every tile that contains it: a tile origin is an integer
 * multiple of `extent`, so `round(world) - origin === round(world - origin)`.
 * Grid crossings sit exactly on `k * extent`, so they survive rounding intact.
 */
function quantizeWorld(xs, ys, length) {
  const outX = new Float64Array(length);
  const outY = new Float64Array(length);
  let count = 0;

  for (let i = 0; i < length; i++) {
    const qx = Math.round(xs[i]);
    const qy = Math.round(ys[i]);
    if (count > 0 && qx === outX[count - 1] && qy === outY[count - 1]) continue;
    outX[count] = qx;
    outY[count] = qy;
    count++;
  }

  return { xs: outX.subarray(0, count), ys: outY.subarray(0, count), length: count };
}

module.exports = { densifyAtTileGrid, quantizeWorld };
