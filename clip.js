'use strict';

/**
 * Liang-Barsky segment clipping against a buffered tile square.
 *
 * Continuity contract
 * -------------------
 * A polyline is *not* filtered vertex-by-vertex (which is what produces the
 * classic "dashes at tile seams" bug). Instead every segment that intersects
 * the buffered tile box is clipped, and the exact intersection point is
 * emitted. Because both neighbouring tiles clip the *same* segment against the
 * *same* boundary line in the same world-extent space, both produce the exact
 * same crossing coordinate, so strokes line up seamlessly.
 *
 * The buffer additionally lets a renderer draw wide/joined strokes without
 * clipping artefacts at the seam: geometry continues `buffer` units past the
 * edge, so joins and caps near the border are drawn from real neighbouring
 * geometry rather than being invented.
 */

/**
 * Clip a single segment to [minX, maxX] x [minY, maxY].
 * @returns {null | {x0:number,y0:number,x1:number,y1:number,t0:number,t1:number}}
 */
function clipSegment(ax, ay, bx, by, minX, minY, maxX, maxY) {
  const dx = bx - ax;
  const dy = by - ay;
  let t0 = 0;
  let t1 = 1;

  const edges = [
    [-dx, ax - minX],
    [dx, maxX - ax],
    [-dy, ay - minY],
    [dy, maxY - ay]
  ];

  for (let i = 0; i < 4; i++) {
    const p = edges[i][0];
    const q = edges[i][1];
    if (p === 0) {
      if (q < 0) return null; // parallel and outside
      continue;
    }
    const r = q / p;
    if (p < 0) {
      if (r > t1) return null;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return null;
      if (r < t1) t1 = r;
    }
  }

  return {
    x0: ax + t0 * dx,
    y0: ay + t0 * dy,
    x1: ax + t1 * dx,
    y1: ay + t1 * dy,
    t0,
    t1
  };
}

/**
 * Clip a whole polyline into the buffered box, producing continuous runs.
 *
 * Consecutive clipped segments are stitched into one run whenever the previous
 * segment left the box exactly where the next one enters it (t1 === 1 and the
 * next t0 === 0), which keeps line joins intact inside the tile.
 *
 * @param {Float64Array|Array<number>} xs world-extent X, already offset to tile-local space
 * @param {Float64Array|Array<number>} ys world-extent Y, already offset to tile-local space
 * @param {number} length vertex count
 * @param {number} min box minimum (typically -buffer)
 * @param {number} max box maximum (typically extent + buffer)
 * @returns {Array<Array<number>>} runs of flat [x0,y0,x1,y1,...] coordinates
 */
function clipPolyline(xs, ys, length, min, max) {
  const runs = [];
  let current = null;
  let previousExited = true;

  for (let i = 1; i < length; i++) {
    const ax = xs[i - 1];
    const ay = ys[i - 1];
    const bx = xs[i];
    const by = ys[i];

    const clipped = clipSegment(ax, ay, bx, by, min, min, max, max);
    if (!clipped) {
      previousExited = true;
      if (current && current.length >= 4) runs.push(current);
      current = null;
      continue;
    }

    const startsWhereWeLeftOff = current !== null && !previousExited && clipped.t0 === 0;
    if (!startsWhereWeLeftOff) {
      if (current && current.length >= 4) runs.push(current);
      current = [clipped.x0, clipped.y0];
    }
    current.push(clipped.x1, clipped.y1);

    // If the segment was cut short at its far end, the polyline left the box.
    previousExited = clipped.t1 < 1;
    if (previousExited) {
      if (current.length >= 4) runs.push(current);
      current = null;
    }
  }

  if (current && current.length >= 4) runs.push(current);
  return runs;
}

module.exports = { clipSegment, clipPolyline };
