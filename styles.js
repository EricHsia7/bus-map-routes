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
      'layer': 'route-trunk',
      'line-fill': 'rgba(85,155,246,1)',
      'line-width': 1.3,
      'line-width-scale': { 12: [1, 1.1], 13: [1.1, 1.2], 14: [1.2, 1.3], 15: [1.3, 1.4], 16: [1.4, 1.5] },
      'line-cap': 'round',
      'line-join': 'round',
      'line-casing-fill': 'rgba(255,255,255,1)',
      'line-casing-width': 1.35,
      'minzoom': 12
    },
    express: {
      'layer': 'route-express',
      'line-fill': 'rgba(99,164,248,1)',
      'line-width': 1.2,
      'line-width-scale': { 12: [1, 1.1], 13: [1.1, 1.2], 14: [1.2, 1.3], 15: [1.3, 1.4], 16: [1.4, 1.5] },
      'line-cap': 'round',
      'line-join': 'round',
      'line-casing-fill': 'rgba(255,255,255,1)',
      'line-casing-width': 1.25,
      'minzoom': 12
    },
    local: {
      'layer': 'route-local',
      'line-fill': 'rgba(113,172,249,1)',
      'line-width': 1.1,
      'line-width-scale': { 12: [1, 1.1], 13: [1.1, 1.2], 14: [1.2, 1.3], 15: [1.3, 1.4], 16: [1.4, 1.5] },
      'line-cap': 'round',
      'line-join': 'round',
      'line-casing-fill': 'rgba(255,255,255,1)',
      'line-casing-width': 1.15,
      'minzoom': 12
    },
    shuttle: {
      'layer': 'route-shuttle',
      'line-fill': 'rgba(127,181,251,1)',
      'line-width': 1.1,
      'line-width-scale': { 12: [1, 1.1], 13: [1.1, 1.2], 14: [1.2, 1.3], 15: [1.3, 1.4], 16: [1.4, 1.5] },
      'line-cap': 'round',
      'line-join': 'round',
      'line-casing-fill': 'rgba(255,255,255,1)',
      'line-casing-width': 1.15,
      'minzoom': 12
    },
    night: {
      'layer': 'route-night',
      'line-fill': 'rgba(140,189,252,1)',
      'line-width': 1.1,
      'line-width-scale': { 12: [1, 1.1], 13: [1.1, 1.2], 14: [1.2, 1.3], 15: [1.3, 1.4], 16: [1.4, 1.5] },
      'line-cap': 'round',
      'line-join': 'round',
      'line-casing-fill': 'rgba(255,255,255,1)',
      'line-casing-width': 1.15,
      'minzoom': 12
    }
  },
  /** Return direction is drawn slightly thinner and translucent. */
  directionModifiers: {
    [GoBack.RETURN]: {
      'line-dasharray': [4, 6]
    },
    [GoBack.LOOP]: {
      'line-dasharray': [4, 2]
    }
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

function deepAssign(target, source) {
  for (const key in source) {
    if (Object.prototype.hasOwnProperty.call(source, key)) {
      if (typeof source[key] === 'object' && source[key] !== null && !Array.isArray(source[key])) {
        target[key] = deepAssign(target[key] || {}, source[key]);
      } else if (Array.isArray(source[key])) {
        target[key] = source[key].map((item) => {
          if (typeof item === 'object' && item !== null) {
            return deepAssign({}, item);
          }
          return item;
        });
      } else {
        target[key] = source[key];
      }
    }
  }
  return target;
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
  resolve(className, goBack, zoom) {
    const key = `${className}|${goBack}|${zoom}`;
    const existing = this.index.get(key);
    if (existing !== undefined) return existing;

    const base = this.stylesheet.classes[className] || this.stylesheet.classes.local;
    const modifier = this.stylesheet.directionModifiers[goBack] || {};
    const style = { ...deepAssign({}, base), ...deepAssign({}, modifier) };

    if (style['line-width-scale']) {
      style['line-width-scale'] = style['line-width-scale'][zoom] || [1, 1];
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
