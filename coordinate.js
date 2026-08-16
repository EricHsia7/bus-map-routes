'use strict';

/**
 * Web-Mercator helpers expressed directly in *tile-extent* space.
 *
 * The tiler never round-trips through metres. A coordinate is projected once
 * into continuous world-extent units for a given zoom:
 *
 *   world = tileFraction(lon, lat, z) * extent
 *
 * A tile's local coordinate is then simply `world - tileIndex * extent`, which
 * makes tile boundaries *exact*: the same source vertex produces bit-identical
 * local coordinates in both neighbouring tiles. That is the foundation of the
 * cross-tile continuity guarantee.
 */

const MAX_LATITUDE = 85.0511287798066;
const DEG_TO_RAD = Math.PI / 180;

function clampLatitude(lat) {
  if (lat > MAX_LATITUDE) return MAX_LATITUDE;
  if (lat < -MAX_LATITUDE) return -MAX_LATITUDE;
  return lat;
}

/** Continuous tile X fraction in [0, 2^z]. */
function lonToTileFraction(lon, z) {
  return ((lon + 180) / 360) * 2 ** z;
}

/** Continuous tile Y fraction in [0, 2^z]. */
function latToTileFraction(lat, z) {
  const clamped = clampLatitude(lat);
  const sin = Math.sin(clamped * DEG_TO_RAD);
  return ((0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * 2 ** z);
}

/**
 * Project lon/lat into zoom-independent normalised mercator space [0, 1].
 * Multiplying by `2 ** z * extent` yields world-extent units for that zoom,
 * so a route only needs to be projected once for all zoom levels.
 */
function projectNormalized(lon, lat) {
  const clamped = clampLatitude(lat);
  const sin = Math.sin(clamped * DEG_TO_RAD);
  return [(lon + 180) / 360, 0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)];
}

function degToTile(lon, lat, z) {
  return [Math.floor(lonToTileFraction(lon, z)), Math.floor(latToTileFraction(lat, z))];
}

function tileToBoundingbox(x, y, z) {
  const n = 2 ** z;
  const west = (x / n) * 360 - 180;
  const east = ((x + 1) / n) * 360 - 180;
  const north = (180 / Math.PI) * Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n)));
  const south = (180 / Math.PI) * Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 1)) / n)));
  return [west, south, east, north];
}

/** Ground resolution (metres per world-extent unit) at a given latitude/zoom. */
function metresPerExtentUnit(lat, z, extent) {
  const EARTH_CIRCUMFERENCE = 40075016.685578488;
  return (EARTH_CIRCUMFERENCE * Math.cos(clampLatitude(lat) * DEG_TO_RAD)) / (2 ** z * extent);
}

module.exports = {
  MAX_LATITUDE,
  clampLatitude,
  lonToTileFraction,
  latToTileFraction,
  projectNormalized,
  degToTile,
  tileToBoundingbox,
  metresPerExtentUnit
};
