'use strict';

/**
 * Minimal WKT reader for the shapes served by the bus-shape feed.
 * Supports LINESTRING and MULTILINESTRING; everything else yields no parts.
 */

function stripTopLevelModel(value) {
  const trimmed = value.trim();
  const start = trimmed.indexOf('(');
  const end = trimmed.lastIndexOf(')');
  if (start < 0 || end < start) return { model: trimmed.toUpperCase(), result: '' };
  return {
    model: trimmed.slice(0, start).trim().toUpperCase(),
    result: trimmed.slice(start + 1, end).trim()
  };
}

function parseCoordinateList(body) {
  const chunks = body.split(',');
  const lon = new Float64Array(chunks.length);
  const lat = new Float64Array(chunks.length);
  let length = 0;
  for (let i = 0; i < chunks.length; i++) {
    const parts = chunks[i].trim().split(/\s+/);
    if (parts.length < 2) continue;
    const x = Number.parseFloat(parts[0]);
    const y = Number.parseFloat(parts[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    lon[length] = x;
    lat[length] = y;
    length++;
  }
  return { lon: lon.subarray(0, length), lat: lat.subarray(0, length), length };
}

/**
 * @param {string} wkt
 * @returns {Array<{lon: Float64Array, lat: Float64Array, length: number}>} one entry per linestring part
 */
function parseWKT(wkt) {
  if (typeof wkt !== 'string' || wkt.length === 0) return [];
  const { model, result } = stripTopLevelModel(wkt);

  if (model === 'LINESTRING') {
    const part = parseCoordinateList(result);
    return part.length ? [part] : [];
  }

  if (model === 'MULTILINESTRING') {
    const parts = [];
    const regex = /\(([^()]*)\)/g;
    let match;
    while ((match = regex.exec(result)) !== null) {
      const part = parseCoordinateList(match[1]);
      if (part.length) parts.push(part);
    }
    return parts;
  }

  return [];
}

module.exports = { parseWKT, stripTopLevelModel };
