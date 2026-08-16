const Stop = require('./data/blobbus/GetStop.json');
const BusShape = require('./data/blobbus/GetBusShape.json');
const { projectLongitude, projectLatitude, degToTile, tileToBoundingbox, getTileViewbox } = require('./coordinate');
const { makeDirectory } = require('./files');
const fs = require('node:fs');
const path = require('node:path');
const { gzipSync } = require('fflate');

function stripTopLevelModel(value) {
  const trimmed = value.trim();
  const trimmedLen = trimmed.length;
  let start = 0;
  let end = 0;
  for (let i = 0, l = trimmedLen; i < l; i++) {
    const char = trimmed[i];
    if (char === '(') {
      start = i;
      break;
    }
  }
  for (let i = trimmedLen - 1; i >= start; i--) {
    const char = trimmed[i];
    if (char === ')') {
      end = i;
      break;
    }
  }
  return {
    result: trimmed.slice(start + 1, end).trim(),
    model: trimmed.slice(0, start).trim()
  };
}

function parseWKTLineString(string) {
  const model = stripTopLevelModel(string);
  if (model.model !== 'LINESTRING') return [new Float64Array(0), new Float64Array(0)];
  const coordinates = model.result.split(', ');
  const length = coordinates.length;
  const lon = new Float64Array(length);
  const lat = new Float64Array(length);
  for (let i = length - 1; i >= 0; i--) {
    const components = coordinates[i].split(' ');
    lon[i] = parseFloat(components[0]);
    lat[i] = parseFloat(components[1]);
  }

  return [lon, lat, length];
}

const Tiles = new Map();
const minZoom = 12;
const maxZoom = 16;
// const tileSize = 1024;
const extent = 2048;
const output = './routes';
const encoder = new TextEncoder();

async function main() {
  for (const BusShapeItem of BusShape) {
    const geometry = parseWKTLineString(BusShapeItem.wkt);
    for (let i = 0; i < geometry[2]; i++) {
      for (let z = minZoom; z <= maxZoom; z++) {
        const [x, y] = degToTile(geometry[0][i], geometry[1][i], z);
        const key = `${z}.${x}.${y}`;
        if (!Tiles.has(key)) Tiles.set(key, new Map());
        if (!Tiles.get(key).has(BusShapeItem.RouteID)) {
          Tiles.get(key).set(BusShapeItem.RouteID, {
            geometry: 'LineString',
            coordinates: [],
            properties: {
              RouteID: BusShapeItem.RouteID,
              GoBack: BusShapeItem.GoBack
            }
          });
        }

        const [x0, y0, x1, y1] = getTileViewbox(x, y, z);
        const dX = x1 - x0;
        const dY = y1 - y0;
        if (!dX || !dY || !Number.isFinite(dX) || !Number.isFinite(dY)) continue;
        const scaleX = extent / dX;
        const scaleY = extent / dY;
        const transformX = (x) => Math.floor((x - x0) * scaleX);
        const transformY = (y) => Math.floor((dY - (y - y0)) * scaleY);
        Tiles.get(key)
          .get(BusShapeItem.RouteID)
          .coordinates.push([transformX(projectLongitude(geometry[0][i])), transformY(projectLatitude(geometry[1][i]))]);
      }
    }
  }

  for (const [key, routes] of Tiles) {
    const [z, x, y] = key.split('.');
    const dirPath = path.join(output, z, x);
    await makeDirectory(dirPath);
    const FeatureCollection = {
      type: 'FeatureCollection',
      extent: extent,
      zoom: parseInt(z),
      features: []
    };
    for (const [RouteID, LineString] of routes) {
      FeatureCollection.features.push(LineString);
    }
    const buffer = encoder.encode(JSON.stringify(FeatureCollection));
    const compressed = gzipSync(buffer);
    await fs.promises.writeFile(path.join(dirPath, `${y}.gz`), Buffer.from(compressed));
    // await fs.promises.writeFile(path.join(dirPath, `${y}.json`), JSON.stringify(FeatureCollection, null, 2));
  }
}

main();
