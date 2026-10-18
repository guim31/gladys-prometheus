// -----------------------------------------------------------------------------
// From the API answers to plain values, without I/O:
//   - an instant query result → series { key, labels, value };
//   - the alerts of Alertmanager (`/api/v2/alerts`) or of Prometheus itself
//     (`/api/v1/alerts`) → alerts { fingerprint, alertname, severity, … }.
// -----------------------------------------------------------------------------

import { createHash } from 'node:crypto';

const hash = (text, length) => createHash('sha256').update(text).digest('hex').slice(0, length);

/** The labels of a series without the metric name (`rate()` drops it anyway). */
const seriesLabels = (metric) =>
  Object.fromEntries(
    Object.entries(metric && typeof metric === 'object' ? metric : {})
      .filter(([name, value]) => name !== '__name__' && typeof value === 'string')
      // By code point: these labels make ids, they must not depend on a locale.
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );

/** The identity of a series: its sorted labels, hashed. Stable across reads. */
export const seriesKey = (labels) => hash(JSON.stringify(labels), 12);

/** "1e+00", "NaN", "+Inf" → a finite number, or null. */
export function parseSample(text) {
  if (typeof text !== 'string' && typeof text !== 'number') {
    return null;
  }
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

export const RESULT_ERRORS = Object.freeze({
  NOT_NUMBER: 'not_number', // a string result
  RANGE: 'range', // a range vector (`up[5m]`): an instant query is needed
});

/**
 * The series of an instant query result.
 * @param {{ resultType: string, result: unknown }} data
 * @returns {{ series: Array<{ key: string, labels: Record<string, string>, value: number|null }>, error?: string }}
 */
export function parseQueryResult(data) {
  if (data.resultType === 'scalar') {
    const labels = {};
    return {
      series: [{ key: seriesKey(labels), labels, value: parseSample(data.result?.[1]) }],
    };
  }
  if (data.resultType === 'vector' && Array.isArray(data.result)) {
    const series = data.result.map((entry) => {
      const labels = seriesLabels(entry?.metric);
      return { key: seriesKey(labels), labels, value: parseSample(entry?.value?.[1]), entry };
    });
    // Series that differ by their metric name only (`{__name__=~"a|b"}`)
    // keep it in their identity, and only those: the others stay stable.
    const counts = new Map();
    for (const { key } of series) {
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return {
      series: series.map(({ key, labels, value, entry }) => {
        const name = entry?.metric?.__name__;
        if (counts.get(key) > 1 && typeof name === 'string') {
          const named = { ...labels, __name__: name };
          return { key: seriesKey(named), labels: named, value };
        }
        return { key, labels, value };
      }),
    };
  }
  if (data.resultType === 'matrix') {
    return { series: [], error: RESULT_ERRORS.RANGE };
  }
  return { series: [], error: RESULT_ERRORS.NOT_NUMBER };
}

// The labels that name a series best, when several are worth showing.
const PREFERRED_LABELS = ['instance', 'job', 'name', 'device', 'mountpoint'];

/**
 * The name of each series of a query: the value of the chosen label, or of
 * the labels that differ from one series to the other; the query name for a
 * single series.
 * @param {Array<{ key: string, labels: Record<string, string> }>} series
 * @param {string} queryName
 * @param {string} [label] the label chosen by the user, '' for automatic
 * @returns {Map<string, string>} series key → name
 */
export function seriesNames(series, queryName, label = '') {
  const names = new Map();
  if (series.length === 0) {
    return names;
  }
  let varying = [];
  if (!label) {
    const all = [...new Set(series.flatMap((entry) => Object.keys(entry.labels)))];
    varying = all
      .filter((name) => new Set(series.map((entry) => entry.labels[name] ?? '')).size > 1)
      .sort((a, b) => {
        const rank = (name) =>
          PREFERRED_LABELS.includes(name)
            ? PREFERRED_LABELS.indexOf(name)
            : PREFERRED_LABELS.length;
        return rank(a) - rank(b) || a.localeCompare(b);
      })
      .slice(0, 2);
  }
  for (const entry of series) {
    const parts = label
      ? [entry.labels[label]].filter(Boolean)
      : varying.map((name) => entry.labels[name]).filter(Boolean);
    names.set(entry.key, parts.length > 0 ? parts.join(' ') : queryName);
  }
  return names;
}

// --- Alerts --------------------------------------------------------------------

// The severity label is free text: the usual values fall in three buckets.
export const SEVERITIES = Object.freeze(['critical', 'warning', 'info']);
export const OTHER_SEVERITY = 'other';
const SEVERITY_ALIASES = {
  critical: ['critical', 'crit', 'error', 'err', 'page', 'high', 'disaster', 'emergency', 'fatal'],
  warning: ['warning', 'warn', 'average', 'medium', 'major', 'minor'],
  info: ['info', 'information', 'informational', 'notice', 'low', 'none', 'debug'],
};

/** The bucket of a severity label: critical, warning, info, or other. */
export function severityLevel(label) {
  const text = typeof label === 'string' ? label.trim().toLowerCase() : '';
  for (const level of SEVERITIES) {
    if (SEVERITY_ALIASES[level].includes(text)) {
      return level;
    }
  }
  return OTHER_SEVERITY;
}

const text = (value) => (typeof value === 'string' ? value : '');
const parseTime = (value) => {
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
};

/** The identity of an alert: its labels, hashed (the same from both APIs). */
export const alertFingerprint = (labels) => hash(JSON.stringify(seriesLabels(labels)), 16);

function normalizeAlert(labels, annotations, startsAt, suppressed) {
  const clean = seriesLabels(labels);
  const severity = text(clean.severity);
  return {
    fingerprint: alertFingerprint(clean),
    alertname: text(clean.alertname) || '?',
    severity: severityLevel(severity),
    severityLabel: severity,
    summary: text(annotations?.summary) || text(annotations?.description),
    instance: text(clean.instance),
    labels: clean,
    startsAt,
    suppressed,
  };
}

/**
 * The alerts of Alertmanager (`/api/v2/alerts`, resolved ones excluded by
 * the API). A silenced or inhibited alert is `suppressed`.
 */
export function parseAlertmanagerAlerts(list) {
  return list
    .filter((alert) => alert && typeof alert === 'object' && alert.labels)
    .map((alert) =>
      normalizeAlert(
        alert.labels,
        alert.annotations,
        parseTime(alert.startsAt),
        alert.status?.state === 'suppressed',
      ),
    );
}

/** The firing alerts of Prometheus (`/api/v1/alerts`); pending ones wait. */
export function parsePrometheusAlerts(list) {
  return list
    .filter((alert) => alert && typeof alert === 'object' && alert.labels)
    .filter((alert) => alert.state === 'firing')
    .map((alert) =>
      normalizeAlert(alert.labels, alert.annotations, parseTime(alert.activeAt), false),
    );
}

/** "instance=nas:9100, job=node" → { instance: "nas:9100", job: "node" }; null when malformed. */
export function parseMatchers(raw) {
  const matchers = {};
  const source = typeof raw === 'string' ? raw.trim() : '';
  if (!source) {
    return matchers;
  }
  for (const part of source.split(/[,;\n]/)) {
    const entry = part.trim();
    if (!entry) {
      continue;
    }
    const match = entry.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*"?([^"]*)"?$/);
    if (!match) {
      return null;
    }
    matchers[match[1]] = match[2].trim();
  }
  return matchers;
}
