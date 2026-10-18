// Configuration parsing, the HTTP clients (error kinds, credentials) and the
// model (query results, series names, alerts, matchers), on the real answers.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { DEFAULT_CONFIG, normalizeConfig, parseBaseUrl } from '../src/config.js';
import {
  AlertmanagerClient,
  ERROR_KINDS,
  PrometheusClient,
  authorizationHeader,
} from '../src/prometheus/client.js';
import { httpRequest } from '../src/prometheus/http.js';
import {
  alertFingerprint,
  parseAlertmanagerAlerts,
  parseMatchers,
  parsePrometheusAlerts,
  parseQueryResult,
  parseSample,
  seriesNames,
  severityLevel,
} from '../src/prometheus/model.js';
import { featureValue, parseQueryFields, queryId, restoreQuery } from '../src/queries.js';
import { FakePrometheus, PROMETHEUS_URL, fixture } from './helpers/fakePrometheus.js';

test('addresses: bare host with the default port, pages of the interfaces, prefixes', () => {
  assert.equal(parseBaseUrl('192.0.2.5', 9090), 'http://192.0.2.5:9090');
  assert.equal(parseBaseUrl(' 192.0.2.5:9091 ', 9090), 'http://192.0.2.5:9091');
  assert.equal(
    parseBaseUrl('http://192.0.2.5:9090/graph?g0.expr=up', 9090),
    'http://192.0.2.5:9090',
  );
  assert.equal(parseBaseUrl('http://192.0.2.5:9093/#/alerts', 9093), 'http://192.0.2.5:9093');
  assert.equal(
    parseBaseUrl('https://example.com/prometheus/', 9090),
    'https://example.com/prometheus',
  );
  assert.equal(
    parseBaseUrl('https://example.com/prometheus/api/v1/query', 9090),
    'https://example.com/prometheus',
  );
  assert.equal(parseBaseUrl('https://example.com', 9090), 'https://example.com');
  assert.equal(parseBaseUrl('http://user:pass@192.0.2.5', 9090), null, 'no credentials in URLs');
  assert.equal(parseBaseUrl('ftp://192.0.2.5', 9090), null);
  assert.equal(parseBaseUrl('', 9090), null);
});

test('configuration: defaults, credentials, invalid addresses', () => {
  const config = normalizeConfig({});
  assert.equal(config.prometheusUrl, null);
  assert.equal(config.pollIntervalMs, 30_000);
  assert.equal(config.allowSilence, true);
  assert.equal(config.language, DEFAULT_CONFIG.language);
  const full = normalizeConfig({
    prometheus_url: '192.0.2.5',
    alertmanager_url: 'nope://',
    username: ' me ',
    password: ' p w ',
    bearer_token: 'tok\n',
    poll_interval: '300',
    allow_silence: 'false',
    language: 'de',
  });
  assert.equal(full.invalidUrl, true);
  assert.deepEqual(full.auth, { username: 'me', password: ' p w ', bearerToken: 'tok' });
  assert.equal(full.pollIntervalMs, 300_000);
  assert.equal(full.allowSilence, false);
  assert.equal(normalizeConfig({ poll_interval: '7' }).pollIntervalMs, 30_000);
});

test('credentials: Bearer wins, then Basic, else none', () => {
  assert.equal(authorizationHeader({ bearerToken: 't', username: 'u' }), 'Bearer t');
  assert.equal(authorizationHeader({ username: 'u', password: 'p' }), 'Basic dTpw');
  assert.equal(authorizationHeader({}), null);
});

test('the client tells the kinds of errors apart', async () => {
  const fake = new FakePrometheus();
  const client = new PrometheusClient({
    url: PROMETHEUS_URL,
    request: (u, o) => fake.request(u, o),
  });
  assert.equal(await client.version(), '3.15.0');
  const kinds = {};
  for (const failure of ['down', 'proxy', 'auth', 'html', 'redirect']) {
    fake.failure.prometheus = failure;
    kinds[failure] = await client.version().catch((err) => err.kind);
  }
  assert.deepEqual(kinds, {
    down: ERROR_KINDS.UNREACHABLE,
    proxy: ERROR_KINDS.UNREACHABLE,
    auth: ERROR_KINDS.AUTH,
    html: ERROR_KINDS.NOT_PROMETHEUS,
    redirect: ERROR_KINDS.REDIRECT,
  });
  fake.failure.prometheus = null;
  const err = await client.query('sum((').catch((caught) => caught);
  assert.equal(err.kind, ERROR_KINDS.QUERY);
  assert.match(err.detail, /parse error: unclosed left parenthesis/);

  const am = new AlertmanagerClient({
    url: 'http://192.0.2.10:9093',
    request: (u, o) => fake.request(u, o),
  });
  assert.equal((await am.alerts()).length, 2);
  fake.failure.alertmanager = 'html';
  assert.equal(await am.alerts().catch((caught) => caught.kind), ERROR_KINDS.NOT_PROMETHEUS);
});

test('a TLS refusal and a real HTTP exchange', async (t) => {
  const tls = new PrometheusClient({
    url: PROMETHEUS_URL,
    request: async () => {
      throw Object.assign(new Error('self-signed'), { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' });
    },
  });
  assert.equal(await tls.version().catch((err) => err.kind), ERROR_KINDS.TLS);

  // node:http against a local server: method, headers, body.
  const seen = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => {
      seen.push({
        method: request.method,
        url: request.url,
        auth: request.headers.authorization,
        body,
      });
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ silenceID: 'abc' }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const am = new AlertmanagerClient({
    url: `http://127.0.0.1:${server.address().port}`,
    auth: { bearerToken: 'xyz' },
  });
  assert.equal(await am.createSilence({ matchers: [] }), 'abc');
  assert.deepEqual(seen, [
    { method: 'POST', url: '/api/v2/silences', auth: 'Bearer xyz', body: '{"matchers":[]}' },
  ]);
  const plain = await httpRequest(`http://127.0.0.1:${server.address().port}/x`);
  assert.equal(plain.status, 200);
});

test('query results: vector, scalar, NaN, empty, range and string', () => {
  const up = parseQueryResult(fixture['query-up'].data);
  assert.equal(up.series.length, 3);
  assert.deepEqual(up.series[0].labels, { instance: 'node-exporter:9100', job: 'node' });
  assert.equal(up.series[2].value, 0);
  assert.deepEqual(parseQueryResult(fixture['query-scalar'].data).series[0].value, 2);
  assert.equal(parseQueryResult(fixture['query-nan'].data).series[0].value, null);
  assert.deepEqual(parseQueryResult(fixture['query-empty'].data), { series: [] });
  assert.equal(parseQueryResult(fixture['query-matrix'].data).error, 'range');
  assert.equal(parseQueryResult(fixture['query-string'].data).error, 'not_number');
  assert.equal(parseSample('1e+00'), 1);
  assert.equal(parseSample('+Inf'), null);
});

test('series names: the labels that differ, preferring instance; the query name alone', () => {
  const { series } = parseQueryResult(fixture['query-fs'].data);
  assert.deepEqual(
    [...seriesNames(series, 'Disk').values()],
    ['/etc/hostname', '/etc/hosts', '/etc/resolv.conf'],
  );
  assert.deepEqual(
    [...seriesNames(series, 'Disk', 'device').values()],
    ['/dev/nvme0n1p2', '/dev/nvme0n1p2', '/dev/nvme0n1p2'],
  );
  assert.deepEqual([...seriesNames(series, 'Disk', 'nope').values()], ['Disk', 'Disk', 'Disk']);
  const load = parseQueryResult(fixture['query-load'].data).series;
  assert.deepEqual([...seriesNames(load, 'Load').values()], ['Load']);
});

test('alerts of both APIs: same fingerprint, severity buckets, silences', () => {
  const am = parseAlertmanagerAlerts(fixture['am-alerts']);
  const prom = parsePrometheusAlerts(fixture.alerts.data.alerts);
  assert.deepEqual(
    am.map((alert) => alert.fingerprint),
    prom.map((alert) => alert.fingerprint),
  );
  assert.deepEqual(
    am.map((alert) => [alert.alertname, alert.severity, alert.instance, alert.suppressed]),
    [
      ['AlwaysFiring', 'info', '', false],
      ['TargetDown', 'critical', 'offline-host:9100', false],
    ],
  );
  assert.equal(am[1].summary, 'offline-host:9100 is down');
  assert.equal(am[0].startsAt, Date.parse('2026-10-18T18:32:17.617Z'));
  assert.equal(alertFingerprint({ b: '1', a: '2' }), alertFingerprint({ a: '2', b: '1' }));
  assert.deepEqual(
    ['CRITICAL', 'error', 'warning', 'info', 'none', 'oops', undefined].map(severityLevel),
    ['critical', 'critical', 'warning', 'info', 'info', 'other', 'other'],
  );
  const pending = [{ ...fixture.alerts.data.alerts[0], state: 'pending' }];
  assert.deepEqual(parsePrometheusAlerts(pending), []);
});

test('matchers of the silence action', () => {
  assert.deepEqual(parseMatchers(''), {});
  assert.deepEqual(parseMatchers('instance=nas:9100, job = "node"'), {
    instance: 'nas:9100',
    job: 'node',
  });
  assert.equal(parseMatchers('instance'), null);
  assert.equal(parseMatchers('a=1, 2b=3'), null);
});

test('query fields, ids and values', () => {
  const { query } = parseQueryFields({ name: '  NAS   temp ', promql: ' x ', label: 'chip' });
  assert.deepEqual(query, {
    id: queryId('nas temp'),
    name: 'NAS temp',
    promql: 'x',
    type: 'number',
    label: 'chip',
  });
  assert.equal(parseQueryFields({ name: 'a'.repeat(61), promql: 'x' }).error, 'name');
  assert.equal(parseQueryFields({ name: 'a', promql: '' }).error, 'promql');
  assert.equal(restoreQuery({ ...query, id: 'forged' }), null);
  assert.deepEqual(restoreQuery({ ...query, series: { abc: { name: 'x' } } }).series, {});
  assert.equal(featureValue('binary', 0.2), 1);
  assert.equal(featureValue('binary', 0), 0);
  assert.equal(featureValue('number', 1.23456), 1.23);
  assert.equal(featureValue('number', null), null);
});
