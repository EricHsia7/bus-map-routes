'use strict';

/**
 * Route tiler.
 *
 * Pipeline per source record:
 *   parse WKT -> clean -> (per zoom) simplify -> slice into tiles with clipping
 *   -> quantise -> emit RouteFeatureCollection per tile.
 *
 * All tiling maths happen in *world-extent units* (`tileFraction * extent`),
 * so a tile's local space is exactly `world - tileIndex * extent`. Neighbouring
 * tiles therefore clip identical segments against identical boundaries and
 * produce identical crossing coordinates -> continuous strokes across seams.
 */

const { parseWKT } = require('./wkt');
const { cleanParts, simplifyMask, fingerprintParts, createStats, DEFAULTS } = require('./clean');
const { clipPolyline } = require('./clip');
const { densifyAtTileGrid, quantizeWorld } = require('./densify');
const { StyleTable, classifyRoute } = require('./styles');

const TILER_DEFAULTS = {
  minZoom: 12,
  maxZoom: 16,
  extent: 2048,
  /** Tile-local padding kept on every side, in extent units. */
  buffer: 64,
  /** Douglas-Peucker tolerance in extent units, applied per zoom. */
  simplifyTolerance: 0.9,
  /** Skip a tile feature whose clipped geometry is shorter than this (extent units). */
  minFeatureLength: 1.5,
  cleaning: DEFAULTS
};

/**
 * Normalise a raw feed record into the fields the tiler needs.
 */
function normalizeRecord(record) {
  const routeId = Number(record.RouteID ?? record.routeId ?? record.RouteId);
  const goBackRaw = record.GoBack ?? record.goBack ?? 0;
  const goBack = Number(goBackRaw);
  return {
    routeId: Number.isFinite(routeId) ? routeId : null,
    goBack: Number.isFinite(goBack) ? goBack : 0,
    subRouteId: Number(record.SubRouteID ?? record.subRouteId ?? -1),
    uniRouteId: record.UniRouteId ?? null,
    wkt: record.wkt ?? record.WKT ?? record.geometry ?? null,
    raw: record
  };
}

/**
 * Slice one cleaned, projected part into tiles at a single zoom level.
 *
 * @param {object} part cleaned part in normalised mercator space
 * @param {number} zoom
 * @param {object} options tiler options
 * @param {(tileKey: string, coordinates: Array<number>) => void} emit
 */
function slicePart(part, zoom, options, emit) {
  const { extent, buffer, simplifyTolerance, minFeatureLength } = options;
  const scale = 2 ** zoom * extent;
  const worldMax = scale;

  // Project into world-extent units for this zoom.
  const wx = new Float64Array(part.length);
  const wy = new Float64Array(part.length);
  for (let i = 0; i < part.length; i++) {
    wx[i] = part.xs[i] * scale;
    wy[i] = part.ys[i] * scale;
  }

  // Zoom-dependent generalisation: fewer vertices at low zoom, full detail high.
  const keep = simplifyMask(wx, wy, part.length, simplifyTolerance);
  let simplifiedLength = 0;
  for (let i = 0; i < part.length; i++) if (keep[i]) simplifiedLength++;
  if (simplifiedLength < 2) return;

  const simplifiedX = new Float64Array(simplifiedLength);
  const simplifiedY = new Float64Array(simplifiedLength);
  let cursor = 0;
  for (let i = 0; i < part.length; i++) {
    if (!keep[i]) continue;
    simplifiedX[cursor] = wx[i];
    simplifiedY[cursor] = wy[i];
    cursor++;
  }

  // Continuity step 1: make every tile-boundary crossing an explicit vertex.
  const densified = densifyAtTileGrid(simplifiedX, simplifiedY, simplifiedLength, extent);
  // Continuity step 2: quantise once, in world space, shared by every tile.
  const quantized = quantizeWorld(densified.xs, densified.ys, densified.length);
  const sx = quantized.xs;
  const sy = quantized.ys;
  const vertexCount = quantized.length;
  if (vertexCount < 2) return;

  // Candidate tiles: the tile range covered by the part's bbox, expanded by the
  // buffer so a line running just outside a tile still contributes to it.
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < vertexCount; i++) {
    if (sx[i] < minX) minX = sx[i];
    if (sx[i] > maxX) maxX = sx[i];
    if (sy[i] < minY) minY = sy[i];
    if (sy[i] > maxY) maxY = sy[i];
  }

  const tileCount = 2 ** zoom;
  const tileMinX = Math.max(0, Math.floor((minX - buffer) / extent));
  const tileMaxX = Math.min(tileCount - 1, Math.floor((maxX + buffer) / extent));
  const tileMinY = Math.max(0, Math.floor((minY - buffer) / extent));
  const tileMaxY = Math.min(tileCount - 1, Math.floor((maxY + buffer) / extent));

  const localX = new Float64Array(vertexCount);
  const localY = new Float64Array(vertexCount);

  for (let tx = tileMinX; tx <= tileMaxX; tx++) {
    const originX = tx * extent;
    for (let ty = tileMinY; ty <= tileMaxY; ty++) {
      const originY = ty * extent;

      for (let i = 0; i < vertexCount; i++) {
        localX[i] = sx[i] - originX;
        localY[i] = sy[i] - originY;
      }

      const runs = clipPolyline(localX, localY, vertexCount, -buffer, extent + buffer);
      if (runs.length === 0) continue;

      for (const run of runs) {
        // Interior vertices are already integral (quantised in world space);
        // only the two clip endpoints can be fractional, and they always lie in
        // the invisible buffer band, so rounding them cannot disturb a seam.
        const coordinates = [];
        let previousX = NaN;
        let previousY = NaN;
        let length = 0;
        let touchesVisible = false;

        for (let i = 0; i < run.length; i += 2) {
          const qx = Math.round(run[i]);
          const qy = Math.round(run[i + 1]);
          if (qx === previousX && qy === previousY) continue;
          if (coordinates.length >= 1) {
            length += Math.hypot(qx - previousX, qy - previousY);
          }
          if (qx >= 0 && qx <= extent && qy >= 0 && qy <= extent) touchesVisible = true;
          coordinates.push([qx, qy]);
          previousX = qx;
          previousY = qy;
        }

        if (coordinates.length < 2) continue;
        // Only prune slivers that live entirely in the buffer band. Pruning a
        // run that reaches the visible square could drop it in one tile but not
        // its neighbour, reopening a seam.
        if (!touchesVisible && length < minFeatureLength) continue;
        emit(`${zoom}.${tx}.${ty}`, coordinates, worldMax);
      }
    }
  }
}

/**
 * Build all tiles for a feed.
 *
 * @param {Array<object>} busShape raw feed records
 * @param {object} userOptions
 * @param {object} [routeMetadata] optional RouteID -> {nameZh, ...} lookup used for classification
 * @returns {{tiles: Map<string, object>, styles: Array<object>, stats: object}}
 */
function buildTiles(busShape, userOptions = {}, routeMetadata = new Map()) {
  const options = { ...TILER_DEFAULTS, ...userOptions };
  const stats = createStats();
  const styleTable = new StyleTable(options.stylesheet);

  /** @type {Map<string, Map<string, object>>} tileKey -> featureKey -> feature */
  const tiles = new Map();
  const seenShapes = new Set();

  for (const rawRecord of busShape) {
    stats.sourceRecords++;
    const record = normalizeRecord(rawRecord);
    if (record.routeId === null || !record.wkt) {
      stats.unparsableRecords++;
      continue;
    }

    const rawParts = parseWKT(record.wkt);
    if (rawParts.length === 0) {
      stats.unparsableRecords++;
      continue;
    }
    stats.parsedParts += rawParts.length;

    const cleaned = cleanParts(rawParts, options.cleaning, stats);
    if (cleaned.length === 0) continue;

    // Drop exact duplicates of a shape already emitted for this route/direction.
    const fingerprint = `${record.routeId}:${record.goBack}:${fingerprintParts(cleaned)}`;
    if (seenShapes.has(fingerprint)) {
      stats.duplicateShapes++;
      continue;
    }
    seenShapes.add(fingerprint);
    stats.keptRoutes++;

    const metadata = routeMetadata.get(record.routeId) || {};
    const className = classifyRoute({ ...metadata, ...record.raw });
    const styleRef = styleTable.resolve(className, record.goBack);
    const featureId = `r${record.routeId}:${record.goBack}`;

    for (let zoom = options.minZoom; zoom <= options.maxZoom; zoom++) {
      for (const part of cleaned) {
        slicePart(part, zoom, options, (tileKey, coordinates) => {
          let tileFeatures = tiles.get(tileKey);
          if (!tileFeatures) {
            tileFeatures = new Map();
            tiles.set(tileKey, tileFeatures);
          }
          // One feature per (route, direction, part-run) inside a tile.
          const featureKey = `${featureId}#${tileFeatures.size}`;
          tileFeatures.set(featureKey, {
            geometry: 'LineString',
            coordinates,
            properties: {
              RouteID: record.routeId,
              GoBack: record.goBack,
              class: className,
              style: styleRef
            }
          });
        });
      }
    }
  }

  // Materialise each tile as a RouteFeatureCollection.
  const collections = new Map();
  for (const [tileKey, tileFeatures] of tiles) {
    const [z, x, y] = tileKey.split('.');
    const features = [...tileFeatures.values()];
    // Stable draw order: by style (layer batching), then by RouteID.
    features.sort((a, b) => a.properties.style - b.properties.style || a.properties.RouteID - b.properties.RouteID);
    collections.set(tileKey, {
      type: 'FeatureCollection',
      extent: options.extent,
      buffer: options.buffer,
      zoom: Number.parseInt(z, 10),
      x: Number.parseInt(x, 10),
      y: Number.parseInt(y, 10),
      features,
      lineStyles: styleTable.toJSON()
    });
  }

  return { tiles: collections, styles: styleTable.toJSON(), stats };
}

module.exports = { TILER_DEFAULTS, buildTiles, slicePart, normalizeRecord };
