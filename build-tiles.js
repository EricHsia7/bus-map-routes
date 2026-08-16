'use strict';

/**
 * CLI entry point: read the bus-shape feed, build tiles, write gzipped JSON.
 *
 *   node backend/build-tiles.js \
 *     --shape ./data/GetBusShape.json \
 *     --routes ./data/GetRoute.json \
 *     --out ./routes \
 *     --min-zoom 12 --max-zoom 16 --extent 2048 --buffer 64
 *
 * `--routes` is optional. It supplies route-level names used to pick a style
 * class; without it every route falls back to the `local` class (direction
 * modifiers still apply).
 *
 * Layout: {out}/{z}/{x}/{y}.gz  plus {out}/metadata.json
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { buildTiles, TILER_DEFAULTS } = require('./tiler');

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      i++;
    }
  }
  return args;
}

function readJSON(filePath) {
  const buffer = fs.readFileSync(filePath);
  if (filePath.endsWith('.gz')) return JSON.parse(zlib.gunzipSync(buffer).toString('utf8'));
  return JSON.parse(buffer.toString('utf8'));
}

/**
 * Build RouteID -> route metadata (name, etc.) so styles can be classified.
 *
 * NOTE: this must be fed a *route* feed. The stop feed (`GetStop.json`) carries
 * `nameZh` for the **stop**, not the route, so classifying from it would tag a
 * whole route by whatever stop happened to be seen first (a stop called
 * "\u591c\u5e02" would turn an ordinary route into a night route). Route names are
 * therefore only read from an explicit route feed.
 */
function buildRouteMetadata(routesFile) {
  const metadata = new Map();
  if (!routesFile) return metadata;
  const routes = readJSON(routesFile);
  const list = Array.isArray(routes) ? routes : routes.BusInfo || routes.routes || [];
  for (const route of list) {
    const routeId = Number(route.RouteID ?? route.routeId ?? route.Id);
    if (!Number.isFinite(routeId) || metadata.has(routeId)) continue;
    metadata.set(routeId, {
      nameZh: route.nameZh ?? route.RouteName ?? route.routeNameZh ?? null,
      nameEn: route.nameEn ?? route.routeNameEn ?? null
    });
  }
  return metadata;
}

/** Optional stop feed: only used to report coverage, never to style routes. */
function countStopRoutes(stopFile) {
  if (!stopFile) return null;
  const stops = readJSON(stopFile);
  const list = Array.isArray(stops) ? stops : stops.BusInfo || [];
  const routeIds = new Set();
  for (const stop of list) {
    const routeId = Number(stop.routeId ?? stop.RouteID);
    if (Number.isFinite(routeId)) routeIds.add(routeId);
  }
  return { stops: list.length, routes: routeIds.size };
}

async function main() {
  const args = parseArgs(process.argv);
  const shapeFile = args.shape || './data/GetBusShape.json';
  const routesFile = args.routes || null;
  const stopFile = args.stop || null;
  const outputDir = args.out || './routes';
  const pretty = Boolean(args.pretty);

  const options = {
    minZoom: Number(args['min-zoom'] ?? TILER_DEFAULTS.minZoom),
    maxZoom: Number(args['max-zoom'] ?? TILER_DEFAULTS.maxZoom),
    extent: Number(args.extent ?? TILER_DEFAULTS.extent),
    buffer: Number(args.buffer ?? TILER_DEFAULTS.buffer),
    simplifyTolerance: Number(args.tolerance ?? TILER_DEFAULTS.simplifyTolerance)
  };

  console.log('[tiler] reading', shapeFile);
  const busShape = readJSON('./data/blobbus/GetBusShape.gz').concat('./data/ntpcbus/GetBusShape.gz');
  const routeMetadata = buildRouteMetadata(routesFile);
  const stopCoverage = countStopRoutes(stopFile);
  if (stopCoverage) console.log('[tiler] stop feed:', stopCoverage.stops, 'stops across', stopCoverage.routes, 'routes');

  const startedAt = Date.now();
  const { tiles, styles, stats } = buildTiles(busShape, options, routeMetadata);
  const buildMs = Date.now() - startedAt;

  console.log('[tiler] writing', tiles.size, 'tiles to', outputDir);
  fs.rmSync(outputDir, { recursive: true, force: true });

  const encoder = new TextEncoder();
  let totalBytes = 0;
  let totalFeatures = 0;
  const zoomCounts = {};

  for (const [tileKey, collection] of tiles) {
    const [z, x, y] = tileKey.split('.');
    const directory = path.join(outputDir, z, x);
    fs.mkdirSync(directory, { recursive: true });
    const json = pretty ? JSON.stringify(collection, null, 2) : JSON.stringify(collection);
    const compressed = zlib.gzipSync(encoder.encode(json), { level: 9 });
    fs.writeFileSync(path.join(directory, `${y}.gz`), compressed);
    totalBytes += compressed.length;
    totalFeatures += collection.features.length;
    zoomCounts[z] = (zoomCounts[z] || 0) + 1;
  }

  const metadata = {
    format: 'route-tiles',
    version: 1,
    minZoom: options.minZoom,
    maxZoom: options.maxZoom,
    extent: options.extent,
    buffer: options.buffer,
    tileCount: tiles.size,
    featureCount: totalFeatures,
    lineStyles: styles,
    tilesPerZoom: zoomCounts,
    generatedAt: new Date().toISOString()
  };
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(outputDir, 'metadata.json'), JSON.stringify(metadata, null, 2));

  console.log('[tiler] done in', (buildMs / 1000).toFixed(1) + 's');
  console.table({
    tiles: tiles.size,
    features: totalFeatures,
    styles: styles.length,
    megabytes: (totalBytes / 1024 / 1024).toFixed(2)
  });
  console.log('[tiler] cleaning stats:', stats);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
