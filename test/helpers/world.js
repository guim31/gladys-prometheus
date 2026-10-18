// -----------------------------------------------------------------------------
// A complete test world: the SDK's fake Gladys, a fake Prometheus and
// Alertmanager, a temporary /data and a manual clock, with the integration
// wired on top through registerHandlers. No timer runs: the tests read with
// `world.hub.pollAll()`.
// -----------------------------------------------------------------------------

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { registerHandlers } from '../../src/app.js';
import { alertsIds, queryIds } from '../../src/devices.js';
import { Store } from '../../src/store.js';
import { ALERTMANAGER_URL, FS_QUERY, FakePrometheus, PROMETHEUS_URL } from './fakePrometheus.js';

// The integration logs every change; keep the test output readable.
process.env.LOG_LEVEL ??= 'silent';

export const BASE_CONFIG = {
  prometheus_url: '192.0.2.10',
  alertmanager_url: 'http://192.0.2.10:9093/#/alerts',
  language: 'en',
};

/** A manual clock, shared by the hub and the tests (the fixture alerts are from 18:32). */
export function createClock(start = Date.parse('2026-10-18T18:45:00Z')) {
  const clock = {
    time: start,
    now: () => clock.time,
    advance(ms) {
      clock.time += ms;
    },
  };
  return clock;
}

export async function createWorld({
  clock = createClock(),
  prometheus = new FakePrometheus(),
  config = BASE_CONFIG,
  devices = [],
  connect = true,
  dataDir = mkdtempSync(join(tmpdir(), 'gladys-prometheus-')),
  timings = {},
  timers = false,
} = {}) {
  const gladys = createFakeGladys({ config, devices });
  const app = registerHandlers(gladys, {
    store: new Store(dataDir),
    request: (url, options) => {
      if (![PROMETHEUS_URL, ALERTMANAGER_URL].includes(new URL(url).origin)) {
        throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' });
      }
      return prometheus.request(url, options);
    },
    timers,
    timings,
    now: clock.now,
  });
  if (connect) {
    await gladys.connect();
    await app.ready;
  }
  return { gladys, fake: gladys.fake, prometheus, app, hub: app.hub, clock, dataDir };
}

export const alertsFeature = (gladys, key) => alertsIds(gladys).feature(key);
export const queryDevice = (gladys, id) => queryIds(gladys, id).device;

/** Add discovered devices in Gladys, as the user would (all by default). */
export async function createDevices(world, filter = () => true) {
  for (const device of world.fake.discoveredDevices.filter(filter)) {
    await world.fake.deviceCreated(device);
  }
}

/** Add a query through the configuration action; its message in English. */
export async function addQuery(world, fields) {
  const ack = await world.fake.action('add_query', fields);
  if (!ack.success) {
    throw new Error(ack.error);
  }
  return ack.data?.message?.en ?? ack.data?.message ?? ack.data;
}

export { ALERTMANAGER_URL, FS_QUERY, FakePrometheus, PROMETHEUS_URL };
