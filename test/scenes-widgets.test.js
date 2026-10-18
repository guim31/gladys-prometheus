// Scene actions (silence, read the alerts, read a value) and the alerts
// widget, against the fake Prometheus and Alertmanager.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateWidgetContent } from '@gladysassistant/integration-sdk';
import { BASE_CONFIG, createClock, createWorld } from './helpers/world.js';

async function world(t, options = {}) {
  const created = await createWorld(options);
  t.after(() => created.app.stop());
  return created;
}

test('silence an alert: a silence for the name and labels, for the chosen duration', async (t) => {
  const clock = createClock();
  const w = await world(t, { clock });
  const ack = await w.fake.sceneAction('silence_alert', {
    alertname: 'TargetDown',
    labels: 'instance=offline-host:9100, job="missing"',
    duration: '120',
  });
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(ack.data.outputs, { silence_id: 'silence-1', alerts_silenced: 1 });
  const [silence] = w.prometheus.silences;
  assert.deepEqual(
    silence.matchers.map((matcher) => `${matcher.name}=${matcher.value}`),
    ['alertname=TargetDown', 'instance=offline-host:9100', 'job=missing'],
  );
  assert.equal(Date.parse(silence.endsAt) - Date.parse(silence.startsAt), 120 * 60_000);
  assert.equal(silence.startsAt, new Date(clock.time).toISOString());
  assert.equal(silence.createdBy, 'Gladys');
  assert.equal(silence.comment, 'Silenced from Gladys');
  // The alerts were read again: the silenced one no longer counts as firing.
  assert.equal(w.hub.firingAlerts().length, 1);
});

test('silence an alert: refused when turned off, without Alertmanager, or malformed', async (t) => {
  const off = await world(t, { config: { ...BASE_CONFIG, allow_silence: false } });
  const refused = await off.fake.sceneAction('silence_alert', { alertname: 'X', duration: '60' });
  assert.equal(refused.success, false);
  assert.match(refused.error, /turned off/);

  const noAm = await world(t, { config: { ...BASE_CONFIG, alertmanager_url: '' } });
  const missing = await noAm.fake.sceneAction('silence_alert', { alertname: 'X' });
  assert.match(missing.error, /address of Alertmanager/);

  const w = await world(t);
  const bad = await w.fake.sceneAction('silence_alert', { alertname: 'X', labels: 'oops' });
  assert.match(bad.error, /name=value/);
  w.prometheus.failure.alertmanager = 'auth';
  const denied = await w.fake.sceneAction('silence_alert', { alertname: 'X' });
  assert.match(denied.error, /refused the silence/);
});

test('read the alerts: counts, highest severity and names', async (t) => {
  const w = await world(t);
  w.prometheus.fire({ alertname: 'DiskFull', severity: 'warning' });
  await w.hub.pollAll(); // the action reads again only after 15 s
  const ack = await w.fake.sceneAction('get_alerts', {});
  assert.deepEqual(ack.data.outputs, {
    count: 3,
    critical: 1,
    warning: 1,
    highest_severity: 'Critical',
    names: 'TargetDown (offline-host:9100), DiskFull (nas:9100), AlwaysFiring',
  });
  const warnings = await w.fake.sceneAction('get_alerts', { severity: 'warning' });
  assert.equal(warnings.data.outputs.count, 1);
  w.prometheus.resolve('DiskFull');
  w.prometheus.resolve('TargetDown');
  w.prometheus.resolve('AlwaysFiring');
  await w.hub.pollAll();
  const none = await w.fake.sceneAction('get_alerts', {});
  assert.equal(none.data.outputs.highest_severity, 'No alert');
  w.prometheus.failure.alertmanager = 'down';
  await w.hub.pollAll();
  const down = await w.fake.sceneAction('get_alerts', {});
  assert.equal(down.success, false);
});

test('read a PromQL value: the first series, the count, and the values as text', async (t) => {
  const w = await world(t);
  const up = await w.fake.sceneAction('query_value', { promql: 'up' });
  assert.deepEqual(up.data.outputs, {
    value: 1,
    series: 3,
    text: 'node-exporter:9100 node: 1, localhost:9090 prometheus: 1, offline-host:9100 missing: 0',
  });
  const scalar = await w.fake.sceneAction('query_value', { promql: 'scalar(sum(up))' });
  assert.deepEqual(scalar.data.outputs, { value: 2, series: 1, text: '2' });
  const nan = await w.fake.sceneAction('query_value', { promql: '0/0' });
  assert.deepEqual(nan.data.outputs, { value: 0, series: 0, text: '' });
  const bad = await w.fake.sceneAction('query_value', { promql: 'sum((' });
  assert.match(bad.error, /^query refused by Prometheus: invalid parameter/);
  const range = await w.fake.sceneAction('query_value', { promql: 'up[1m]' });
  assert.match(range.error, /range vector/);
});

test('the widget: tiles, one row per firing alert (most severe first), a Refresh button', async (t) => {
  const w = await world(t);
  const ack = await w.fake.widgetGet('alerts', { settings: {}, language: 'fr' });
  assert.equal(ack.success, true, ack.error);
  const { components } = ack.data.content;
  assert.deepEqual(validateWidgetContent(ack.data.content), []);
  assert.deepEqual(
    components.filter((c) => c.type === 'value').map((c) => [c.label, c.value]),
    [
      ['Actives', 2],
      ['Critiques', 1],
      ['En silence', 0],
    ],
  );
  const rows = components.find((c) => c.type === 'status').items;
  assert.deepEqual(
    rows.map((row) => [row.label, row.value, row.color]),
    [
      ['TargetDown', 'offline-host:9100', 'danger'],
      ['AlwaysFiring', 'Always firing test alert', 'info'],
    ],
  );
  assert.ok(components.length <= 8);
  assert.ok(components.filter((c) => c.type === 'text').length <= 2);

  const refreshed = await w.fake.widgetAction('alerts', 'refresh', {});
  assert.equal(refreshed.success, true, refreshed.error);
});

test('the widget: many alerts end in "Others", an error is told, all clear is green', async (t) => {
  const w = await world(t);
  for (let index = 0; index < 12; index += 1) {
    w.prometheus.fire({ alertname: `A${index}`, instance: `host${index}` });
  }
  await w.hub.pollAll();
  w.prometheus.failure.alertmanager = 'down';
  await w.hub.pollAll();
  const { content } = (await w.fake.widgetGet('alerts', { settings: {}, language: 'en' })).data;
  assert.deepEqual(validateWidgetContent(content), []);
  const rows = content.components.find((c) => c.type === 'status').items;
  assert.equal(rows.length, 10);
  assert.deepEqual(rows.at(-1), {
    label: 'Others',
    value: '+5',
    icon: 'more-horizontal',
    color: 'neutral',
  });
  assert.ok(
    content.components.some((c) => c.type === 'text' && c.text === 'Alertmanager: does not answer'),
  );

  const clear = await world(t);
  clear.prometheus.resolve('TargetDown');
  clear.prometheus.resolve('AlwaysFiring');
  await clear.hub.pollAll();
  const { components } = (await clear.fake.widgetGet('alerts', { settings: {} })).data.content;
  assert.deepEqual(components.find((c) => c.type === 'status').items[0].label, 'No alert');

  const none = await world(t, { config: { language: 'en' } });
  const empty = (await none.fake.widgetGet('alerts', { settings: {} })).data.content;
  assert.equal(empty.components[0].type, 'text');
});
