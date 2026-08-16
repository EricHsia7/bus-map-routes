'use strict';

/**
 * Data cleaning for raw bus-shape geometry.
 *
 * The raw feed is noisy: NaN/out-of-range coordinates, repeated vertices,
 * zero-length spurs, GPS spikes, duplicated shapes for the same RouteID/GoBack
 * pair, and shapes that wander far outside the service area. Everything here
 * runs once per source route, *before* tiling, in normalised mercator space so
 * results are identical for every zoom level.
 */

const { projectNormalized } = require('./coordinate');

const DEFAULTS = {
  /** Service-area guard: [west, south, east, north]. */
  bbox: [-180, -85.0511, 180, 85.0511],
  /** Drop a vertex that repeats the previous one within this many world units at maxZoom. */
  duplicateEpsilon: 1e-12,
  /** Reject an implausible jump between consecutive vertices, in metres. */
  maxSegmentMetres: 20000,
  /** Reject a spike: A->B->C where the detour is this many times the direct path. */
  spikeRatio: 12,
  minSpikeMetres: 150,
  /** Discard parts shorter than this, in metres. */
  minPartMetres: 20
};

const EARTH_CIRCUMFERENCE = 40075016.685578488;

/** Approximate metres between two normalised-mercator points. */
function normalizedDistanceMetres(ax, ay, bx, by, cosLat) {
  const dx = (bx - ax) * EARTH_CIRCUMFERENCE * cosLat;
  const dy = (by - ay) * EARTH_CIRCUMFERENCE * cosLat;
  return Math.hypot(dx, dy);
}

/**
 * Stage 1 - validate + project.
 * Rejects non-finite values, out-of-range lon/lat and points outside the
 * configured service bbox.
 */
function validateAndProject(part, options, stats) {
  const [west, south, east, north] = options.bbox;
  const xs = new Float64Array(part.length);
  const ys = new Float64Array(part.length);
  let latSum = 0;
  let count = 0;

  for (let i = 0; i < part.length; i++) {
    const lon = part.lon[i];
    const lat = part.lat[i];
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
      stats.invalidVertices++;
      continue;
    }
    if (lon < -180 || lon > 180 || lat < -90 || lat > 90) {
      stats.invalidVertices++;
      continue;
    }
    if (lon < west || lon > east || lat < south || lat > north) {
      stats.outOfBoundsVertices++;
      continue;
    }
    const [nx, ny] = projectNormalized(lon, lat);
    xs[count] = nx;
    ys[count] = ny;
    latSum += lat;
    count++;
  }

  return { xs: xs.subarray(0, count), ys: ys.subarray(0, count), length: count, meanLat: count ? latSum / count : 0 };
}

/** Stage 2 - drop consecutive duplicate vertices. */
function dedupe(projected, options, stats) {
  const { xs, ys, length } = projected;
  const outX = new Float64Array(length);
  const outY = new Float64Array(length);
  let count = 0;
  const eps = options.duplicateEpsilon;

  for (let i = 0; i < length; i++) {
    if (count > 0 && Math.abs(xs[i] - outX[count - 1]) < eps && Math.abs(ys[i] - outY[count - 1]) < eps) {
      stats.duplicateVertices++;
      continue;
    }
    outX[count] = xs[i];
    outY[count] = ys[i];
    count++;
  }

  return { xs: outX.subarray(0, count), ys: outY.subarray(0, count), length: count, meanLat: projected.meanLat };
}

/** Stage 3 - remove single-vertex GPS spikes (out-and-back detours). */
function despike(projected, options, stats) {
  const { xs, ys, length, meanLat } = projected;
  if (length < 3) return projected;
  const cosLat = Math.cos((meanLat * Math.PI) / 180);

  const keep = new Uint8Array(length).fill(1);
  for (let i = 1; i < length - 1; i++) {
    let prev = i - 1;
    while (prev >= 0 && !keep[prev]) prev--;
    if (prev < 0) continue;

    const ab = normalizedDistanceMetres(xs[prev], ys[prev], xs[i], ys[i], cosLat);
    const bc = normalizedDistanceMetres(xs[i], ys[i], xs[i + 1], ys[i + 1], cosLat);
    const ac = normalizedDistanceMetres(xs[prev], ys[prev], xs[i + 1], ys[i + 1], cosLat);
    const detour = ab + bc;
    if (detour < options.minSpikeMetres) continue;
    if (ac * options.spikeRatio < detour) {
      keep[i] = 0;
      stats.spikeVertices++;
    }
  }

  const outX = new Float64Array(length);
  const outY = new Float64Array(length);
  let count = 0;
  for (let i = 0; i < length; i++) {
    if (!keep[i]) continue;
    outX[count] = xs[i];
    outY[count] = ys[i];
    count++;
  }
  return { xs: outX.subarray(0, count), ys: outY.subarray(0, count), length: count, meanLat };
}

/**
 * Stage 4 - split on implausible jumps.
 * A teleport between consecutive vertices means the feed spliced two disjoint
 * pieces together; drawing through it would paint a line across the city.
 */
function splitOnJumps(projected, options, stats) {
  const { xs, ys, length, meanLat } = projected;
  if (length < 2) return [];
  const cosLat = Math.cos((meanLat * Math.PI) / 180);
  const parts = [];
  let startIndex = 0;

  for (let i = 1; i < length; i++) {
    const distance = normalizedDistanceMetres(xs[i - 1], ys[i - 1], xs[i], ys[i], cosLat);
    if (distance > options.maxSegmentMetres) {
      stats.jumpSplits++;
      if (i - startIndex >= 2) parts.push({ xs: xs.subarray(startIndex, i), ys: ys.subarray(startIndex, i), length: i - startIndex, meanLat });
      startIndex = i;
    }
  }
  if (length - startIndex >= 2) {
    parts.push({ xs: xs.subarray(startIndex, length), ys: ys.subarray(startIndex, length), length: length - startIndex, meanLat });
  }
  return parts;
}

/** Stage 5 - drop parts that are too short to be meaningful. */
function filterShortParts(parts, options, stats) {
  const kept = [];
  for (const part of parts) {
    const cosLat = Math.cos((part.meanLat * Math.PI) / 180);
    let total = 0;
    for (let i = 1; i < part.length; i++) {
      total += normalizedDistanceMetres(part.xs[i - 1], part.ys[i - 1], part.xs[i], part.ys[i], cosLat);
    }
    if (total < options.minPartMetres) {
      stats.shortParts++;
      continue;
    }
    part.lengthMetres = total;
    kept.push(part);
  }
  return kept;
}

/**
 * Douglas-Peucker simplification, run per zoom in world-extent units.
 * Iterative (explicit stack) so very long shapes cannot blow the call stack.
 *
 * @param {Float64Array} xs world-extent X
 * @param {Float64Array} ys world-extent Y
 * @param {number} tolerance in world-extent units
 * @returns {Uint8Array} keep mask
 */
function simplifyMask(xs, ys, length, tolerance) {
  const keep = new Uint8Array(length);
  if (length === 0) return keep;
  keep[0] = 1;
  keep[length - 1] = 1;
  if (length < 3) return keep;

  const toleranceSq = tolerance * tolerance;
  const stack = [0, length - 1];

  while (stack.length) {
    const end = stack.pop();
    const start = stack.pop();
    if (end - start < 2) continue;

    const ax = xs[start];
    const ay = ys[start];
    const bx = xs[end];
    const by = ys[end];
    const dx = bx - ax;
    const dy = by - ay;
    const lengthSq = dx * dx + dy * dy;

    let maxDistanceSq = -1;
    let maxIndex = -1;
    for (let i = start + 1; i < end; i++) {
      const px = xs[i] - ax;
      const py = ys[i] - ay;
      let distanceSq;
      if (lengthSq === 0) {
        distanceSq = px * px + py * py;
      } else {
        let t = (px * dx + py * dy) / lengthSq;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const ox = px - t * dx;
        const oy = py - t * dy;
        distanceSq = ox * ox + oy * oy;
      }
      if (distanceSq > maxDistanceSq) {
        maxDistanceSq = distanceSq;
        maxIndex = i;
      }
    }

    if (maxIndex > 0 && maxDistanceSq > toleranceSq) {
      keep[maxIndex] = 1;
      stack.push(start, maxIndex, maxIndex, end);
    }
  }

  return keep;
}

/**
 * Clean one raw WKT part list into projected, de-noised parts.
 */
function cleanParts(rawParts, options, stats) {
  const settings = { ...DEFAULTS, ...options };
  const cleaned = [];
  for (const rawPart of rawParts) {
    const projected = validateAndProject(rawPart, settings, stats);
    if (projected.length < 2) {
      stats.emptyParts++;
      continue;
    }
    const deduped = dedupe(projected, settings, stats);
    if (deduped.length < 2) {
      stats.emptyParts++;
      continue;
    }
    const despiked = despike(deduped, settings, stats);
    const split = splitOnJumps(despiked, settings, stats);
    for (const part of filterShortParts(split, settings, stats)) cleaned.push(part);
  }
  return cleaned;
}

/** Stable fingerprint used to drop exact duplicate shapes in the feed. */
function fingerprintParts(parts) {
  let hash = 0x811c9dc5;
  for (const part of parts) {
    for (let i = 0; i < part.length; i++) {
      const vx = Math.round(part.xs[i] * 1e9);
      const vy = Math.round(part.ys[i] * 1e9);
      hash = Math.imul(hash ^ (vx & 0xffffffff), 0x01000193);
      hash = Math.imul(hash ^ (vy & 0xffffffff), 0x01000193);
    }
    hash = Math.imul(hash ^ 0x9e3779b9, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function createStats() {
  return {
    sourceRecords: 0,
    parsedParts: 0,
    invalidVertices: 0,
    outOfBoundsVertices: 0,
    duplicateVertices: 0,
    spikeVertices: 0,
    jumpSplits: 0,
    shortParts: 0,
    emptyParts: 0,
    duplicateShapes: 0,
    unparsableRecords: 0,
    keptRoutes: 0
  };
}

module.exports = { DEFAULTS, cleanParts, simplifyMask, fingerprintParts, createStats };
