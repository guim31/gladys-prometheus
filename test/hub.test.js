// The hub against the fake Prometheus and Alertmanager: queries added and
// removed, discovery, states of the added devices only, scene events on new
// and resolved alerts (kept across a restart), errors, heartbeat, the reading
// timer, and quiet logs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FEATURE_KEYS, parseQueryId, queryIds, seriesFeatureKey } from '../src/devices.js';
import { TRIGGERS } from '../src/hub.js';
import { queryId } from '../src/queries.js';
import { seriesKey } from '../src/prometheus/model.js';
import {
  BASE_CONFIG,
  FS_QUERY,
  addQuery,
  alertsFeature,
  createClock,
  createDevices,
  createWorld,
} from './helpers/world.js';

/** The lines written at `LOG_LEVEL=info` from now on (the SDK logger reads it per line). */
function captureLogs(t) {
  const previous = process.env.LOG_LEVEL;
  process.env.LOG_LEVEL = 'info';
  const lines = [];
  for (const stream of ['log', 'error']) {
    t.mock.method(console, stream, (...args) => lines.push(args.join(' ')));
  }
  t.after(() => {
    process.env.LOG_LEVEL = previous;
  });
  return lines;
}

async function world(t, options = {}) {
  const created = await createWorld(options);
  t.after(() => created.app.stop());
  return created;
}

const stateOf = (w, externalId) => w.fake.lastState(externalId);
const featureOf = (w, name, series) =>
  queryIds(w.gladys, queryId(name)).feature(
    seriesFeatureKey(series.type, seriesKey(series.labels)),
  );

test('without query: the alerts device only, connected, nothing published', async (t) => {
  const w = await world(t);
  assert.deepEqual(
    w.fake.discoveredDevices.map((device) => device.name),
    ['Prometheus alerts'],
  );
  assert.deepEqual(w.fake.connectionStatus, { connected: true });
  assert.equal(w.fake.states.length, 0, 'nothing for a device not added');
  // The address typed without port nor scheme gets :9090.
  assert.ok(w.prometheus.calls.some((call) => call.path === '/api/v1/status/buildinfo'));
});

test('a query: one feature per series, named after the labels that differ', async (t) => {
  const w = await world(t);
  const message = await addQuery(w, { name: 'Targets', promql: 'up', type: 'binary' });
  assert.equal(message, 'Query "Targets" added, 3 series, add its device from the Discover tab.');
  const device = w.fake.discoveredDevices.find((entry) => entry.name === 'Targets');
  assert.equal(parseQueryId(w.gladys, device.external_id), queryId('Targets'));
  assert.deepEqual(
    device.features.map((feature) => feature.name),
    ['localhost:9090 prometheus', 'node-exporter:9100 node', 'offline-host:9100 missing'],
  );
  assert.equal(device.should_poll, false);
  assert.equal(device.features[0].category, 'input');

  await createDevices(w);
  const offline = featureOf(w, 'Targets', {
    type: 'binary',
    labels: { instance: 'offline-host:9100', job: 'missing' },
  });
  assert.equal(stateOf(w, offline), 0);
  assert.equal(
    stateOf(
      w,
      featureOf(w, 'Targets', {
        type: 'binary',
        labels: { instance: 'localhost:9090', job: 'prometheus' },
      }),
    ),
    1,
  );
});

test('a chosen label names the series; a scalar is one feature named after the query', async (t) => {
  const w = await world(t);
  await addQuery(w, { name: 'Disk', promql: FS_QUERY, type: 'percent', label: 'mountpoint' });
  await addQuery(w, { name: 'Targets up', promql: 'scalar(sum(up))' });
  const names = (name) =>
    w.fake.discoveredDevices
      .find((device) => device.name === name)
      .features.map((feature) => `${feature.name} ${feature.unit ?? ''}`.trim());
  assert.deepEqual(names('Disk'), [
    '/etc/hostname percent',
    '/etc/hosts percent',
    '/etc/resolv.conf percent',
  ]);
  assert.deepEqual(names('Targets up'), ['Targets up']);
  await createDevices(w);
  assert.equal(stateOf(w, featureOf(w, 'Targets up', { type: 'number', labels: {} })), 2);
});

test('a refused query is answered, not saved; a range or a string too', async (t) => {
  const w = await world(t);
  assert.match(
    await addQuery(w, { name: 'Bad', promql: 'sum((' }),
    /^Prometheus refuses this query: invalid parameter "query": 1:6: parse error/,
  );
  assert.match(await addQuery(w, { name: 'Range', promql: 'up[1m]' }), /range vector/);
  assert.match(await addQuery(w, { name: 'Text', promql: '"hello"' }), /not a number/);
  assert.match(await addQuery(w, { name: ' ', promql: 'up' }), /Give the query a name/);
  assert.match(await addQuery(w, { name: 'X', promql: 'up', type: 'nope' }), /Choose a type/);
  assert.match(await addQuery(w, { name: 'X', promql: 'up', label: 'a-b' }), /label name/);
  assert.equal(w.hub.queries.size, 0);
});

test('series met later get a feature, up to 20; a missing series keeps it', async (t) => {
  const w = await world(t);
  w.prometheus.setValue('temp', 40.123, { chip: 'a' });
  await addQuery(w, { name: 'Temps', promql: 'temp', type: 'temperature' });
  await createDevices(w);
  const a = featureOf(w, 'Temps', { type: 'temperature', labels: { chip: 'a' } });
  assert.equal(stateOf(w, a), 40.12);

  // A second series appears: a new feature, proposed with "Update".
  w.prometheus.queries.temp[0].data.result.push({
    metric: { chip: 'b' },
    value: [1, '55'],
  });
  await w.hub.pollAll();
  const features = () =>
    w.fake.discoveredDevices.find((device) => device.name === 'Temps').features;
  assert.deepEqual(
    features().map((feature) => feature.name),
    ['b', 'Temps'],
    'the first name stays as it was given',
  );

  // Both series go away: the features stay, without states.
  w.prometheus.setValue('temp', 1, { chip: 'z' });
  w.prometheus.queries.temp[0].data.result = [];
  const count = w.fake.states.length;
  await w.hub.pollAll();
  assert.equal(features().length, 2);
  assert.equal(w.fake.states.length, count);

  // Many series: capped at 20.
  w.prometheus.queries.temp[0].data.result = Array.from({ length: 30 }, (_, index) => ({
    metric: { chip: `c${String(index).padStart(2, '0')}` },
    value: [1, '1'],
  }));
  await w.hub.pollAll();
  assert.equal(features().length, 20);
});

test('replacing a query keeps its device; another type gives new features', async (t) => {
  const w = await world(t);
  await addQuery(w, { name: 'Load', promql: 'node_load1' });
  const before = w.fake.discoveredDevices.find((device) => device.name === 'Load');
  assert.match(
    await addQuery(w, { name: '  load ', promql: 'node_load1', type: 'percent' }),
    /^Query "load" updated, 1 series/,
  );
  const after = w.fake.discoveredDevices.find((device) => device.name === 'load');
  assert.equal(after.external_id, before.external_id);
  assert.notEqual(after.features[0].external_id, before.features[0].external_id);
  assert.equal(w.hub.queries.size, 1);
});

test('removing a query takes its device off the Discovery list', async (t) => {
  const w = await world(t);
  await addQuery(w, { name: 'Load', promql: 'node_load1' });
  const ack = await w.fake.action('remove_query', { name: 'LOAD' });
  assert.equal(ack.data.message.en, 'Query "Load" removed, 0 query(ies).');
  assert.deepEqual(
    w.fake.discoveredDevices.map((device) => device.name),
    ['Prometheus alerts'],
  );
  const missing = await w.fake.action('remove_query', { name: 'Nope' });
  assert.equal(missing.data.message.fr, 'Aucune requête nommée « Nope ».');
});

test('the queries are kept in /data across a restart', async (t) => {
  const first = await createWorld();
  await addQuery(first, { name: 'Load', promql: 'node_load1', type: 'number' });
  await first.app.stop();
  const second = await world(t, { dataDir: first.dataDir });
  assert.deepEqual(
    second.fake.discoveredDevices.map((device) => device.name),
    ['Prometheus alerts', 'Load'],
  );
});

test('the alerts device: firing by severity, and silenced', async (t) => {
  const w = await world(t);
  await createDevices(w);
  const state = (key) => stateOf(w, alertsFeature(w.gladys, key));
  assert.equal(state(FEATURE_KEYS.FIRING), 2);
  assert.equal(state(FEATURE_KEYS.CRITICAL), 1);
  assert.equal(state(FEATURE_KEYS.INFO), 1);
  assert.equal(state(FEATURE_KEYS.WARNING), 0);
  assert.equal(state(FEATURE_KEYS.SILENCED), 0);
  w.prometheus.amAlerts[0].status.state = 'suppressed';
  await w.hub.pollAll();
  assert.equal(state(FEATURE_KEYS.FIRING), 1);
  assert.equal(state(FEATURE_KEYS.SILENCED), 1);
  assert.ok(w.fake.widgetRefreshes.includes('alerts'));
});

test('scene events: the first read records, then new and resolved alerts', async (t) => {
  const clock = createClock();
  const w = await world(t, { clock });
  assert.deepEqual(w.fake.sceneEvents, [], 'the alerts already there are not announced');

  w.prometheus.fire({ alertname: 'DiskFull', severity: 'error', summary: 'NAS disk full' });
  await w.hub.pollAll();
  const fingerprint = w.fake.sceneEvents[0]?.data.fingerprint;
  assert.deepEqual(w.fake.sceneEvents, [
    {
      key: TRIGGERS.FIRING,
      data: {
        alertname: 'DiskFull',
        severity: 'critical',
        severity_name: 'Critical',
        severity_label: 'error',
        summary: 'NAS disk full',
        instance: 'nas:9100',
        labels: 'alertname=DiskFull, instance=nas:9100, job=node, severity=error',
        fingerprint,
      },
    },
  ]);
  await w.hub.pollAll();
  assert.equal(w.fake.sceneEvents.length, 1, 'announced once');

  clock.advance(20 * 60_000);
  w.prometheus.resolve('DiskFull');
  await w.hub.pollAll();
  const resolved = w.fake.sceneEvents[1];
  assert.equal(resolved.key, TRIGGERS.RESOLVED);
  assert.equal(resolved.data.alertname, 'DiskFull');
  // Started at 18:40 by the fixture, resolved at 19:05.
  assert.equal(resolved.data.duration_minutes, 25);
});

test('a silenced alert is announced when its silence ends, not before', async (t) => {
  const w = await world(t);
  w.prometheus.fire({ alertname: 'Quiet' });
  w.prometheus.amAlerts.at(-1).status.state = 'suppressed';
  await w.hub.pollAll();
  assert.equal(w.fake.sceneEvents.length, 0);
  w.prometheus.amAlerts.at(-1).status.state = 'active';
  await w.hub.pollAll();
  assert.deepEqual(
    w.fake.sceneEvents.map((event) => event.key),
    [TRIGGERS.FIRING],
  );
});

test('an alert that fired during a restart is announced once', async (t) => {
  const first = await createWorld();
  await first.app.stop();
  first.prometheus.fire({ alertname: 'WhileAway' });
  const second = await world(t, { dataDir: first.dataDir, prometheus: first.prometheus });
  assert.deepEqual(
    second.fake.sceneEvents.map((event) => event.data.alertname),
    ['WhileAway'],
  );
});

test('without Alertmanager, the firing alerts of Prometheus', async (t) => {
  const w = await world(t, { config: { ...BASE_CONFIG, alertmanager_url: '' } });
  await createDevices(w);
  assert.equal(stateOf(w, alertsFeature(w.gladys, FEATURE_KEYS.FIRING)), 2);
  assert.ok(w.prometheus.calls.some((call) => call.path === '/api/v1/alerts'));
  assert.ok(!w.prometheus.calls.some((call) => call.server === 'alertmanager'));
  w.prometheus.fire({ alertname: 'FromRules' });
  await w.hub.pollAll();
  assert.equal(w.fake.sceneEvents.at(-1).data.alertname, 'FromRules');
});

test('errors: connection status per server, unreachable badge, recovery', async (t) => {
  const w = await world(t);
  await addQuery(w, { name: 'Load', promql: 'node_load1' });
  await createDevices(w);
  w.prometheus.failure.alertmanager = 'down';
  await w.hub.pollAll();
  assert.deepEqual(w.fake.connectionStatus.connected, false);
  assert.equal(w.fake.connectionStatus.message.en, 'Alertmanager: does not answer');
  assert.equal(w.fake.connectionStatus.message.fr, 'Alertmanager : ne répond pas');
  const transport = (externalId) =>
    w.fake.transports.filter((entry) => entry.device_external_id === externalId).at(-1)?.transport;
  assert.equal(transport(w.hub.discoveredDevices()[0].external_id), 'unreachable');
  assert.equal(transport(w.hub.discoveredDevices()[1].external_id), 'local');

  w.prometheus.failure.prometheus = 'auth';
  await w.hub.pollAll();
  assert.match(w.fake.connectionStatus.message.en, /^Prometheus: access refused/);
  assert.equal(transport(w.hub.discoveredDevices()[1].external_id), 'unreachable');

  w.prometheus.failure = { prometheus: null, alertmanager: null };
  await w.hub.pollAll();
  assert.deepEqual(w.fake.connectionStatus, { connected: true });
  assert.equal(transport(w.hub.discoveredDevices()[1].external_id), 'local');
  assert.equal(w.fake.sceneEvents.length, 0, 'an outage resolves no alert');
});

test('credentials: Basic, or Bearer when filled', async (t) => {
  const basic = await world(t, {
    config: { ...BASE_CONFIG, username: 'gladys', password: 'secret' },
  });
  const header = basic.prometheus.calls[0].headers.authorization;
  assert.equal(header, `Basic ${Buffer.from('gladys:secret').toString('base64')}`);

  const prometheus = new basic.prometheus.constructor();
  prometheus.authorization = 'Bearer token-1';
  const bearer = await world(t, {
    prometheus,
    config: { ...BASE_CONFIG, username: 'gladys', password: 'secret', bearer_token: 'token-1' },
  });
  assert.deepEqual(bearer.fake.connectionStatus, { connected: true });
});

test('configuration problems are told in the connection status', async (t) => {
  const none = await world(t, { config: { language: 'en' } });
  assert.match(none.fake.connectionStatus.message.en, /Enter the address of your Prometheus/);
  const bad = await world(t, { config: { prometheus_url: 'ftp://x', language: 'en' } });
  assert.match(bad.fake.connectionStatus.message.en, /Address not understood/);
});

test('"Test the connection" sums up', async (t) => {
  const w = await world(t);
  await addQuery(w, { name: 'Nothing', promql: 'nothing_here' });
  const ack = await w.fake.action('test_connection', {});
  assert.equal(
    ack.data.message.en,
    'OK, Prometheus 3.15.0, 1 query(ies), Nothing: no series for now, 2 firing alert(s).',
  );
});

test('a device added later receives everything at once, and the widget is refreshed', async (t) => {
  const w = await world(t);
  await addQuery(w, { name: 'Load', promql: 'node_load1' });
  const load = w.fake.discoveredDevices.find((device) => device.name === 'Load');
  await w.fake.deviceCreated(load);
  assert.equal(w.fake.lastState(load.features[0].external_id), 12.34);
  assert.ok(w.fake.widgetRefreshes.includes('alerts'));
  const count = w.fake.states.length;
  await w.fake.deviceUpdated(load);
  assert.ok(w.fake.states.length > count, '"Update" sends everything again');
});

test('only the changes are sent, and an unchanged value again after 6 hours', async (t) => {
  const clock = createClock();
  const w = await world(t, { clock });
  await addQuery(w, { name: 'Load', promql: 'node_load1' });
  await createDevices(w);
  const count = w.fake.states.length;
  await w.hub.pollAll();
  assert.equal(w.fake.states.length, count);
  clock.advance(6 * 3600_000);
  await w.hub.pollAll();
  assert.ok(w.fake.states.length > count);
});

test('the timer of the container reads Prometheus, without any onPoll', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const w = await world(t, {
    config: { ...BASE_CONFIG, poll_interval: '15' },
    timers: true,
  });
  const before = w.prometheus.calls.length;
  t.mock.timers.tick(15_000);
  await new Promise((resolve) => setImmediate(resolve));
  await w.hub.polling;
  assert.ok(w.prometheus.calls.length > before);
});

test('a normal reading cycle writes nothing at info level', async (t) => {
  const w = await world(t);
  await addQuery(w, { name: 'Load', promql: 'node_load1' });
  await createDevices(w);
  const lines = captureLogs(t);
  await w.hub.pollAll();
  await w.hub.pollAll();
  assert.deepEqual(lines, []);
  // A failure that repeats writes one line, and one when it is over.
  w.prometheus.failure.prometheus = 'down';
  await w.hub.pollAll();
  await w.hub.pollAll();
  w.prometheus.failure.prometheus = null;
  await w.hub.pollAll();
  assert.equal(lines.length, 2, lines.join('\n'));
  assert.ok(!lines.join('\n').includes('secret'));
});

test('the alerts already firing at the first read: neither their start nor their end', async (t) => {
  const w = await world(t);
  w.prometheus.resolve('TargetDown');
  await w.hub.pollAll();
  assert.deepEqual(w.fake.sceneEvents, []);
});

test('a failing query does not stop the others, nor the alerts', async (t) => {
  const w = await world(t, { config: { ...BASE_CONFIG, alertmanager_url: '' } });
  await addQuery(w, { name: 'Load', promql: 'node_load1' });
  await addQuery(w, { name: 'Heavy', promql: 'heavy' });
  await createDevices(w);
  w.prometheus.queries.heavy = [
    { status: 'error', errorType: '422', error: 'too many series' },
    422,
  ];
  w.prometheus.setValue('node_load1', 3, { instance: 'node-exporter:9100', job: 'node' });
  w.prometheus.fire({ alertname: 'StillSeen' });
  await w.hub.pollAll();
  assert.deepEqual(w.fake.connectionStatus, { connected: true });
  const load = w.fake.discoveredDevices.find((device) => device.name === 'Load');
  assert.equal(w.fake.lastState(load.features[0].external_id), 3);
  assert.equal(w.fake.sceneEvents.at(-1).data.alertname, 'StillSeen');
  const ack = await w.fake.action('test_connection', {});
  assert.match(ack.data.message.en, /Heavy: query refused by Prometheus \(too many series\)/);
});

test('while Prometheus does not answer, no stale value is sent as a heartbeat', async (t) => {
  const clock = createClock();
  const w = await world(t, { clock });
  await addQuery(w, { name: 'Load', promql: 'node_load1' });
  await createDevices(w);
  const count = w.fake.states.length;
  w.prometheus.failure = { prometheus: 'down', alertmanager: 'down' };
  clock.advance(7 * 3600_000);
  await w.hub.pollAll();
  assert.equal(w.fake.states.length, count);
});

test('series that differ by their metric name only keep it in their identity', async (t) => {
  const w = await world(t);
  w.prometheus.queries.loads = [
    {
      status: 'success',
      data: {
        resultType: 'vector',
        result: ['node_load1', 'node_load5'].map((name, index) => ({
          metric: { __name__: name, instance: 'nas:9100' },
          value: [1, String(index + 1)],
        })),
      },
    },
    200,
  ];
  await addQuery(w, { name: 'Loads', promql: 'loads' });
  const device = w.fake.discoveredDevices.find((entry) => entry.name === 'Loads');
  assert.deepEqual(
    device.features.map((feature) => feature.name),
    ['node_load1', 'node_load5'],
  );
});
