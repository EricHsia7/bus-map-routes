'use strict';

/**
 * Route stylesheet - the line analogue of the Label style tables.
 *
 * Label side                     Route side
 * ---------------------------    ----------------------------
 * text-size   (constant ref)     line-width       (constant ref)
 * text-scale  [s0, s1]           line-width-scale [s0, s1]
 * text-fill                      line-fill
 * text-halo-fill/-radius         line-casing-fill / line-casing-width
 *
 * Exactly like `text-scale`, `line-width-scale` is an interval [s0, s1]
 * spanning [tileZoom, tileZoom + 1]:
 *
 *   width(zoom) = line-width * lerp(s0, s1, zoom - tileZoom)
 *
 * Styles are emitted as a *shared, deduplicated table* per tile and features
 * reference them by index (`StyleRef`), mirroring `LabelFeatureCollection`.
 */

/** Direction flag carried by the feed. */
const GoBack = { OUTBOUND: 0, RETURN: 1, LOOP: 2 };

/**
 * Route classes. `match` is evaluated against the source record; the first
 * matching rule wins, otherwise `default` is used.
 */
const STYLESHEET = {
  version: 1,
  classes: {
    trunk: {
      layer: 'route-trunk',
      'line-fill': '#e8590c',
      'line-width': 2.4,
      'line-width-scale': [1, 1.35],
      'line-casing-fill': '#ffffff',
      'line-casing-width': 1.1,
      'line-cap': 'round',
      'line-join': 'round',
      'line-opacity': 1,
      minzoom: 12
    },
    express: {
      layer: 'route-express',
      'line-fill': '#1971c2',
      'line-width': 2,
      'line-width-scale': [1, 1.3],
      'line-casing-fill': '#ffffff',
      'line-casing-width': 1,
      'line-cap': 'round',
      'line-join': 'round',
      'line-opacity': 1,
      minzoom: 12
    },
    local: {
      layer: 'route-local',
      'line-fill': '#2f9e44',
      'line-width': 1.6,
      'line-width-scale': [1, 1.25],
      'line-casing-fill': '#ffffff',
      'line-casing-width': 0.9,
      'line-cap': 'round',
      'line-join': 'round',
      'line-opacity': 0.95,
      minzoom: 12
    },
    shuttle: {
      layer: 'route-shuttle',
      'line-fill': '#9c36b5',
      'line-width': 1.4,
      'line-width-scale': [1, 1.2],
      'line-dasharray': [4, 2],
      'line-cap': 'butt',
      'line-join': 'round',
      'line-opacity': 0.95,
      minzoom: 13
    },
    night: {
      layer: 'route-night',
      'line-fill': '#343a40',
      'line-width': 1.5,
      'line-width-scale': [1, 1.25],
      'line-dasharray': [6, 3],
      'line-cap': 'butt',
      'line-join': 'round',
      'line-opacity': 0.9,
      minzoom: 13
    }
  },
  /** Return direction is drawn slightly thinner and translucent. */
  directionModifiers: {
    [GoBack.RETURN]: { widthFactor: 0.85, opacityFactor: 0.85 },
    [GoBack.LOOP]: { widthFactor: 1, opacityFactor: 1 }
  }
};

/**
 * Classify a source record into a style class.
 * The Taipei feed encodes the kind of service in the Chinese route name, with
 * UniRouteId as a fallback discriminator.
 */
function classifyRoute(record) {
  const name = String(record.nameZh || record.RouteName || record.UniRouteId || '');
  if (/夜|貓/.test(name)) return 'night';
  if (/幹線|BRT|快捷/.test(name)) return 'trunk';
  if (/快|直達|國道|市民小巴/.test(name)) return 'express';
  if (/接駁|小|遊園|social|shuttle/i.test(name)) return 'shuttle';
  return 'local';
}

/**
 * Builds a deduplicated style table and hands out stable indices.
 */
class StyleTable {
  constructor(stylesheet = STYLESHEET) {
    this.stylesheet = stylesheet;
    this.styles = [];
    this.index = new Map();
  }

  /**
   * Resolve (class, direction) to a style index, creating the entry on demand.
   * @returns {number} StyleRef
   */
  resolve(className, goBack) {
    const key = `${className}|${goBack}`;
    const existing = this.index.get(key);
    if (existing !== undefined) return existing;

    const base = this.stylesheet.classes[className] || this.stylesheet.classes.local;
    const modifier = this.stylesheet.directionModifiers[goBack];
    const style = { ...base };

    if (modifier) {
      style['line-width'] = Number((base['line-width'] * modifier.widthFactor).toFixed(3));
      if (base['line-casing-width'] !== undefined) {
        style['line-casing-width'] = Number((base['line-casing-width'] * modifier.widthFactor).toFixed(3));
      }
      style['line-opacity'] = Number(((base['line-opacity'] ?? 1) * modifier.opacityFactor).toFixed(3));
    }

    const styleRef = this.styles.length;
    this.styles.push(style);
    this.index.set(key, styleRef);
    return styleRef;
  }

  toJSON() {
    return this.styles;
  }
}

module.exports = { GoBack, STYLESHEET, classifyRoute, StyleTable };
