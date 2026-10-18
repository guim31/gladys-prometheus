// -----------------------------------------------------------------------------
// An in-memory Prometheus and Alertmanager, seeded with the real answers of
// Prometheus 3.15.0 and Alertmanager 0.34.1 (test/fixtures/real): instant
// queries, alerts of both APIs, silences, and the real error answers. Tests
// change its state (values, alerts, failures) between two reads.
// -----------------------------------------------------------------------------

import { readFileSync } from 'node:fs';

export const PROMETHEUS_URL = 'http://192.0.2.10:9090';
export const ALERTMANAGER_URL = 'http://192.0.2.10:9093';

export const fixture = JSON.parse(
  readFileSync(new URL('../fixtures/real/prometheus-3.15.0.json', import.meta.url), 'utf8'),
).answers;
const answer = (name) => structuredClone(fixture[name]);

export const FS_QUERY = '100 - 100 * node_filesystem_avail_bytes / node_filesystem_size_bytes';

// The PromQL expressions the fixtures answer, with their HTTP status.
const QUERIES = {
  up: ['query-up', 200],
  [FS_QUERY]: ['query-fs', 200],
  'scalar(sum(up))': ['query-scalar', 200],
  node_load1: ['query-load', 200],
  'sum((': ['query-bad', 400],
  '"hello"': ['query-string', 200],
  'up[1m]': ['query-matrix', 200],
  '0/0': ['query-nan', 200],
  nothing_here: ['query-empty', 200],
};

const json = (status, body) => ({
  status,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

export class FakePrometheus {
  constructor() {
    /** Answers by PromQL expression: [body, status]; tests add or change them. */
    this.queries = Object.fromEntries(
      Object.entries(QUERIES).map(([promql, [name, status]]) => [promql, [answer(name), status]]),
    );
    this.promAlerts = answer('alerts').data.alerts;
    this.amAlerts = answer('am-alerts');
    this.silences = [];
    /** Per server ('prometheus', 'alertmanager'): 'down', 'proxy', 'auth', 'html', 'redirect' or null */
    this.failure = { prometheus: null, alertmanager: null };
    /** The Authorization header expected, null for none. */
    this.authorization = null;
    this.calls = [];
  }

  /** Set the value of a single-series query. */
  setValue(promql, value, metric = {}) {
    this.queries[promql] = [
      {
        status: 'success',
        data: { resultType: 'vector', result: [{ metric, value: [1792348357.6, String(value)] }] },
      },
      200,
    ];
  }

  /** A new firing alert, in both APIs. */
  fire({ alertname = 'DiskFull', severity = 'warning', instance = 'nas:9100', summary = '' } = {}) {
    const labels = { alertname, instance, job: 'node', severity };
    const annotations = summary ? { summary } : {};
    const startsAt = '2026-10-18T18:40:00.000Z';
    this.promAlerts.push({
      labels,
      annotations,
      state: 'firing',
      activeAt: startsAt,
      value: '1e+00',
    });
    this.amAlerts.push({
      annotations,
      endsAt: '2026-10-18T18:50:00.000Z',
      fingerprint: 'ffffffffffffffff',
      receivers: [{ name: 'none' }],
      startsAt,
      status: { inhibitedBy: [], mutedBy: [], silencedBy: [], state: 'active' },
      updatedAt: startsAt,
      labels,
    });
  }

  /** The alerts of that name stop firing. */
  resolve(alertname) {
    this.promAlerts = this.promAlerts.filter((alert) => alert.labels.alertname !== alertname);
    this.amAlerts = this.amAlerts.filter((alert) => alert.labels.alertname !== alertname);
  }

  /** @type {import('../../src/prometheus/http.js').httpRequest} */
  async request(url, { method = 'GET', body = '', headers = {} } = {}) {
    const target = new URL(url);
    const server = target.origin === ALERTMANAGER_URL ? 'alertmanager' : 'prometheus';
    this.calls.push({ server, method, path: `${target.pathname}${target.search}`, headers, body });
    switch (this.failure[server]) {
      case 'down':
        throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
      case 'proxy':
        return { status: 502, headers: {}, body: '<html>Bad Gateway</html>' };
      case 'auth':
        return { status: 401, headers: {}, body: 'Unauthorized' };
      case 'html':
        return { status: 200, headers: {}, body: '<html>NAS</html>' };
      case 'redirect':
        return { status: 301, headers: { location: 'https://192.0.2.10/' }, body: '' };
      default:
    }
    if (this.authorization && headers.authorization !== this.authorization) {
      return { status: 401, headers: {}, body: 'Unauthorized' };
    }
    return server === 'prometheus'
      ? this.prometheus(target)
      : this.alertmanager(target, method, body);
  }

  prometheus(target) {
    switch (target.pathname) {
      case '/api/v1/status/buildinfo':
        return json(200, answer('buildinfo'));
      case '/api/v1/alerts':
        return json(200, { status: 'success', data: { alerts: structuredClone(this.promAlerts) } });
      case '/api/v1/query': {
        const promql = target.searchParams.get('query');
        const known = this.queries[promql];
        return known ? json(known[1], structuredClone(known[0])) : json(200, answer('query-empty'));
      }
      default:
        return json(404, { status: 'error', errorType: 'not_found', error: 'not found' });
    }
  }

  alertmanager(target, method, body) {
    if (target.pathname === '/api/v2/alerts' && method === 'GET') {
      return json(200, structuredClone(this.amAlerts));
    }
    if (target.pathname === '/api/v2/silences' && method === 'POST') {
      const silence = JSON.parse(body);
      if (!Array.isArray(silence.matchers) || silence.matchers.length === 0) {
        return json(400, 'silence invalid: at least one matcher required');
      }
      const id = `silence-${this.silences.length + 1}`;
      this.silences.push({ id, ...silence });
      for (const alert of this.amAlerts) {
        if (silence.matchers.every((m) => alert.labels[m.name] === m.value)) {
          alert.status = { ...alert.status, state: 'suppressed', silencedBy: [id] };
        }
      }
      return json(200, { silenceID: id });
    }
    return { status: 404, headers: {}, body: 'Not Found' };
  }
}
