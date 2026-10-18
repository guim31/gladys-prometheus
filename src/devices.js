// -----------------------------------------------------------------------------
// Gladys devices, proposed in the Discovery tab (the user adds the ones to
// follow, nothing is created on their behalf):
//
//   - one device per PromQL query (src/queries.js), identity = the query name
//     hashed; one feature per series the query has returned (MAX_SERIES at
//     most), of the type chosen for the query, named after the series
//     labels. A series that is missing at a read keeps its feature, without a
//     new state;
//   - one "Prometheus alerts" device: the firing alerts, in total and by
//     severity (critical, warning, info), and the silenced ones — from
//     Alertmanager when it is configured, from Prometheus otherwise.
//
// Published with should_poll: false: the integration reads Prometheus on its
// own timer (src/hub.js), at the interval chosen in the configuration.
// -----------------------------------------------------------------------------

import { DEVICE_FEATURE_CATEGORIES, DEVICE_FEATURE_TYPES } from '@gladysassistant/integration-sdk';
import { QUERY_TYPES, featureValue } from './queries.js';
import { SEVERITIES } from './prometheus/model.js';

export const QUERY_TYPE = 'query';
export const ALERTS_TYPE = 'alerts';
export const ALERTS_ID = 'main';

// Suffixes of the feature external ids of the alerts device: permanent once published.
export const FEATURE_KEYS = Object.freeze({
  FIRING: 'firing',
  CRITICAL: 'firing_critical',
  WARNING: 'firing_warning',
  INFO: 'firing_info',
  SILENCED: 'silenced',
});

const SEVERITY_FEATURES = {
  critical: FEATURE_KEYS.CRITICAL,
  warning: FEATURE_KEYS.WARNING,
  info: FEATURE_KEYS.INFO,
};

// Feature names, in the language chosen in the configuration (Gladys does not
// tell a device integration the user's language). Frozen at creation in Gladys.
export const NAMES = {
  en: {
    [FEATURE_KEYS.FIRING]: 'Firing alerts',
    [FEATURE_KEYS.CRITICAL]: 'Critical alerts',
    [FEATURE_KEYS.WARNING]: 'Warning alerts',
    [FEATURE_KEYS.INFO]: 'Info alerts',
    [FEATURE_KEYS.SILENCED]: 'Silenced alerts',
  },
  fr: {
    [FEATURE_KEYS.FIRING]: 'Alertes actives',
    [FEATURE_KEYS.CRITICAL]: 'Alertes critiques',
    [FEATURE_KEYS.WARNING]: 'Alertes avertissement',
    [FEATURE_KEYS.INFO]: 'Alertes info',
    [FEATURE_KEYS.SILENCED]: 'Alertes en silence',
  },
  de: {
    [FEATURE_KEYS.FIRING]: 'Aktive Alarme',
    [FEATURE_KEYS.CRITICAL]: 'Kritische Alarme',
    [FEATURE_KEYS.WARNING]: 'Warnungen',
    [FEATURE_KEYS.INFO]: 'Info-Alarme',
    [FEATURE_KEYS.SILENCED]: 'Stummgeschaltete Alarme',
  },
  es: {
    [FEATURE_KEYS.FIRING]: 'Alertas activas',
    [FEATURE_KEYS.CRITICAL]: 'Alertas críticas',
    [FEATURE_KEYS.WARNING]: 'Alertas de advertencia',
    [FEATURE_KEYS.INFO]: 'Alertas informativas',
    [FEATURE_KEYS.SILENCED]: 'Alertas silenciadas',
  },
};

export const ALERTS_NAME = {
  en: 'Prometheus alerts',
  fr: 'Alertes Prometheus',
  de: 'Prometheus-Alarme',
  es: 'Alertas de Prometheus',
};

// Display bound of the counters (the core never applies it on write).
export const MAX_ALERTS = 10_000;

export const MODEL_QUERY = 'PromQL query';
export const MODEL_ALERTS = 'Prometheus alerts';
export const PARAMS = Object.freeze({ PROMQL: 'PROMQL' });

export const queryIds = (gladys, id) => gladys.externalIds(QUERY_TYPE, id);
export const alertsIds = (gladys) => gladys.externalIds(ALERTS_TYPE, ALERTS_ID);

/** Feature key of a series: the type is part of it (a new type, new features). */
export const seriesFeatureKey = (type, seriesKey) => `${type}_${seriesKey}`;

/** The query id of a device external id, null when it is not a query of ours. */
export function parseQueryId(gladys, externalId) {
  const prefix = queryIds(gladys, '').device;
  if (typeof externalId !== 'string' || !externalId.startsWith(prefix)) {
    return null;
  }
  const id = externalId.slice(prefix.length);
  return /^[0-9a-f]{12}$/.test(id) ? id : null;
}

const readOnly = { read_only: true, has_feedback: false, keep_history: true };

/**
 * The discovery payload of a query: one feature per series seen.
 * @param {object} gladys SDK client
 * @param {{ id: string, name: string, promql: string, type: string, series: Record<string, { name: string }> }} query
 */
export function buildQueryDevice(gladys, query) {
  const ids = queryIds(gladys, query.id);
  const spec = QUERY_TYPES[query.type];
  const features = Object.entries(query.series)
    .sort(([, a], [, b]) => a.name.localeCompare(b.name))
    .map(([key, entry]) => ({
      name: entry.name,
      external_id: ids.feature(seriesFeatureKey(query.type, key)),
      category: spec.category,
      type: spec.type,
      ...(spec.unit ? { unit: spec.unit } : {}),
      ...readOnly,
      min: spec.min,
      max: spec.max,
    }));
  return {
    name: query.name,
    external_id: ids.device,
    model: MODEL_QUERY,
    should_poll: false,
    params: [{ name: PARAMS.PROMQL, value: query.promql.slice(0, 255) }],
    features,
  };
}

function counter(name, externalId) {
  return {
    name,
    external_id: externalId,
    category: DEVICE_FEATURE_CATEGORIES.COUNTER_SENSOR,
    type: DEVICE_FEATURE_TYPES.SENSOR.INTEGER,
    ...readOnly,
    min: 0,
    max: MAX_ALERTS,
  };
}

/** The discovery payload of the alerts device. */
export function buildAlertsDevice(gladys, language = 'en') {
  const ids = alertsIds(gladys);
  const names = NAMES[language] ?? NAMES.en;
  return {
    name: ALERTS_NAME[language] ?? ALERTS_NAME.en,
    external_id: ids.device,
    model: MODEL_ALERTS,
    should_poll: false,
    features: Object.values(FEATURE_KEYS).map((key) => counter(names[key], ids.feature(key))),
  };
}

/**
 * Feature values of a query (null: nothing to publish).
 * @param {Array<{ key: string, value: number|null }>} series the last result
 * @returns {Array<{ externalId: string, value: number|null }>}
 */
export function queryValues(gladys, query, series) {
  const ids = queryIds(gladys, query.id);
  return series
    .filter((entry) => query.series[entry.key])
    .map((entry) => ({
      externalId: ids.feature(seriesFeatureKey(query.type, entry.key)),
      value: featureValue(query.type, entry.value),
    }));
}

/** Feature values of the alerts device. */
export function alertsValues(gladys, alerts) {
  const ids = alertsIds(gladys);
  const firing = alerts.filter((alert) => !alert.suppressed);
  return [
    { externalId: ids.feature(FEATURE_KEYS.FIRING), value: firing.length },
    ...SEVERITIES.map((severity) => ({
      externalId: ids.feature(SEVERITY_FEATURES[severity]),
      value: firing.filter((alert) => alert.severity === severity).length,
    })),
    {
      externalId: ids.feature(FEATURE_KEYS.SILENCED),
      value: alerts.length - firing.length,
    },
  ];
}
