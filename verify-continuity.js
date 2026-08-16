'use strict';

/**
 * Continuity verification.
 *
 * For every pair of horizontally/vertically adjacent tiles, every place where a
 * route crosses the shared edge in tile A must have a matching crossing in
 * tile B at the identical position along that edge (and for the same RouteID).
 * Any mismatch would show up as a visible gap or a doubled stroke at the seam.
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const root = process.argv[2] || './routes';
const zoom = Number(process.argv[3] || 14);
const tolerance = 0.51; // one quantisation step

function readTile(z, x, y) {
  const file = path.join(root, String(z), String(x), `${y}.gz`);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8'));
}

/**
 * Collect crossings of a vertical line at local x = `edge`.
 * Returns [{routeId, at}] where `at` is the local Y of the crossing.
 */
function crossingsVertical(collection, edge) {
  const crossings = [];
  for (const feature of collection.features) {
    const coordinates = feature.coordinates;
    for (let i = 1; i < coordinates.length; i++) {
      const [ax, ay] = coordinates[i - 1];
      const [bx, by] = coordinates[i];
      if ((ax - edge) * (bx - edge) > 0) continue; // same side
      if (ax === bx) continue; // parallel to the edge
      const t = (edge - ax) / (bx - ax);
      if (t < 0 || t > 1) continue;
      crossings.push({ routeId: feature.properties.RouteID, at: ay + t * (by - ay) });
    }
  }
  return crossings;
}

function crossingsHorizontal(collection, edge) {
  const crossings = [];
  for (const feature of collection.features) {
    const coordinates = feature.coordinates;
    for (let i = 1; i < coordinates.length; i++) {
      const [ax, ay] = coordinates[i - 1];
      const [bx, by] = coordinates[i];
      if ((ay - edge) * (by - edge) > 0) continue;
      if (ay === by) continue;
      const t = (edge - ay) / (by - ay);
      if (t < 0 || t > 1) continue;
      crossings.push({ routeId: feature.properties.RouteID, at: ax + t * (bx - ax) });
    }
  }
  return crossings;
}

function matches(listA, listB) {
  let matched = 0;
  const used = new Uint8Array(listB.length);
  const unmatched = [];
  for (const a of listA) {
    let found = false;
    for (let i = 0; i < listB.length; i++) {
      if (used[i]) continue;
      if (listB[i].routeId !== a.routeId) continue;
      if (Math.abs(listB[i].at - a.at) <= tolerance) {
        used[i] = 1;
        matched++;
        found = true;
        break;
      }
    }
    if (!found) unmatched.push(a);
  }
  return { matched, unmatched };
}

function main() {
  const zoomDir = path.join(root, String(zoom));
  if (!fs.existsSync(zoomDir)) {
    console.error('no tiles at zoom', zoom);
    process.exit(1);
  }

  const xs = fs.readdirSync(zoomDir).map(Number).sort((a, b) => a - b);
  let pairsChecked = 0;
  let crossingsChecked = 0;
  let failures = 0;
  const examples = [];
  let extent = 0;
  let bufferChecked = 0;
  let outsideBufferRange = 0;

  for (const x of xs) {
    const ys = fs
      .readdirSync(path.join(zoomDir, String(x)))
      .filter((name) => name.endsWith('.gz'))
      .map((name) => Number(name.replace('.gz', '')))
      .sort((a, b) => a - b);

    for (const y of ys) {
      const tile = readTile(zoom, x, y);
      if (!tile) continue;
      extent = tile.extent;

      // Buffer sanity: no coordinate may exceed the declared overlap.
      for (const feature of tile.features) {
        for (const [cx, cy] of feature.coordinates) {
          bufferChecked++;
          if (cx < -tile.buffer || cx > tile.extent + tile.buffer || cy < -tile.buffer || cy > tile.extent + tile.buffer) {
            outsideBufferRange++;
          }
        }
      }

      // Right neighbour: A's x = extent edge vs B's x = 0 edge.
      const right = readTile(zoom, x + 1, y);
      if (right) {
        pairsChecked++;
        const a = crossingsVertical(tile, tile.extent);
        const b = crossingsVertical(right, 0);
        const result = matches(a, b);
        crossingsChecked += a.length;
        failures += result.unmatched.length;
        if (result.unmatched.length && examples.length < 5) {
          examples.push({ edge: 'right', tile: `${zoom}/${x}/${y}`, unmatched: result.unmatched.slice(0, 3) });
        }
      }

      // Bottom neighbour: A's y = extent edge vs B's y = 0 edge.
      const below = readTile(zoom, x, y + 1);
      if (below) {
        pairsChecked++;
        const a = crossingsHorizontal(tile, tile.extent);
        const b = crossingsHorizontal(below, 0);
        const result = matches(a, b);
        crossingsChecked += a.length;
        failures += result.unmatched.length;
        if (result.unmatched.length && examples.length < 5) {
          examples.push({ edge: 'bottom', tile: `${zoom}/${x}/${y}`, unmatched: result.unmatched.slice(0, 3) });
        }
      }
    }
  }

  console.log('zoom              ', zoom);
  console.log('extent            ', extent);
  console.log('tile pairs checked', pairsChecked);
  console.log('edge crossings    ', crossingsChecked);
  console.log('vertices checked  ', bufferChecked);
  console.log('outside buffer    ', outsideBufferRange);
  console.log('MISMATCHES        ', failures);
  if (examples.length) console.log('examples', JSON.stringify(examples, null, 2));
  console.log(failures === 0 && outsideBufferRange === 0 ? 'RESULT: PASS' : 'RESULT: FAIL');
}

main();
