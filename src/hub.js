// -----------------------------------------------------------------------------
// The Prometheus hub: reads Prometheus (and Alertmanager) on a timer of the
// container, at the interval chosen in the configuration; publishes the states
// of the added devices when they change; fires the scene events on new and
// resolved alerts; holds the queries, and the views the widget and the scene
// actions read.
//
// Gladys never polls these devices (should_poll: false): the interval goes up
// to 5 minutes, beyond the fixed list of the core scheduler, and the scene
// events must fire whether the alerts device is added or not.
//
// One read = buildinfo (the health check and the version), one instant query
// per configured query, and the alerts: from Alertmanager when its address is
// set (silences known), from Prometheus otherwise (firing alerts only).
//
// The alerts already seen are kept in /data (src/store.js): an alert that
// fired or resolved while the integration or Gladys restarted is still
// announced, once. The very first read only records them.
// -----------------------------------------------------------------------------

import { DEVICE_TRANSPORTS, createLogger } from '@gladysassistant/integration-sdk';
import {
  alertsIds,
  alertsValues,
  buildAlertsDevice,
  buildQueryDevice,
  parseQueryId,
  queryIds,
  queryValues,
} from './devices.js';
import { hostOf } from './config.js';
import { FailureLog } from './logs.js';
import {
  AlertmanagerClient,
  ERROR_KINDS,
  PrometheusClient,
  PrometheusError,
} from './prometheus/client.js';
import {
  parseAlertmanagerAlerts,
  parsePrometheusAlerts,
  parseQueryResult,
  seriesNames,
} from './prometheus/model.js';
import { MAX_QUERIES, MAX_SERIES, parseQueryFields, queryId, restoreQuery } from './queries.js';
import {
  CONNECTION_TEXT,
  ERROR_TEXT,
  QUERY_FIELD_TEXT,
  REPORT_TEXT,
  RESULT_TEXT,
  labelled,
  pick,
  sentence,
  severityName,
} from './texts.js';

const logger = createLogger({ name: 'prometheus-hub' });

export const WIDGET_KEY = 'alerts';

// Scene trigger keys (manifest `scene_triggers`): permanent once published.
export const TRIGGERS = Object.freeze({
  FIRING: 'alert_firing',
  RESOLVED: 'alert_resolved',
});

export const HUB_TIMINGS = {
  // A scene action or the widget reads again when the last read is older.
  freshMs: 15_000,
  // An unchanged value is sent again this often: Gladys marks a value older
  // than 48 h as outdated.
  heartbeatMs: 6 * 3600_000,
};

// Scene events per read, at most: Gladys accepts 300 per minute, and a
// network outage can fire dozens of alerts at once. The rest waits for the
// next reads.
export const MAX_EVENTS_PER_READ = 30;

const MAX_STATES_PER_REQUEST = 100;
// States per minute, at most (Gladys accepts 300): the budget of a read is
// its share of the minute; the values published longest ago go first, so
// that no feature waits forever.
export const MAX_STATES_PER_MINUTE = 240;
const MAX_FEATURE_NAME = 60;

// Errors that concern the server, not one query.
const SERVER_ERRORS = new Set([
  ERROR_KINDS.AUTH,
  ERROR_KINDS.TLS,
  ERROR_KINDS.REDIRECT,
  ERROR_KINDS.NOT_PROMETHEUS,
]);

const signature = (config) =>
  JSON.stringify([
    config.prometheusUrl,
    config.alertmanagerUrl,
    config.auth,
    config.allowSelfSigned,
  ]);
// What decides which alerts are seen: another source does not resolve the
// alerts of the previous one.
const scopeOf = (config) => JSON.stringify([config.alertmanagerUrl ?? config.prometheusUrl]);

/** A user mistake answered to a configuration action, in every language. */
export class AnswerError extends Error {
  constructor(messages) {
    super(messages.en);
    this.messages = messages;
  }
}

const inEveryLanguage = (render) =>
  Object.fromEntries(Object.keys(REPORT_TEXT).map((language) => [language, render(language)]));

export class PrometheusHub {
  /**
   * @param {object} options
   * @param {object} options.gladys GladysIntegration (or the SDK's fake Gladys)
   * @param {object} options.store persistence (src/store.js)
   * @param {Function} [options.request] HTTP seam (src/prometheus/http.js)
   * @param {boolean} [options.timers] periodic timer (off in tests)
   * @param {object} [options.timings] HUB_TIMINGS overrides
   * @param {() => number} [options.now]
   */
  constructor({ gladys, store, request, timers = true, timings, now }) {
    this.gladys = gladys;
    this.store = store;
    this.request = request;
    this.timersEnabled = timers;
    this.timings = { ...HUB_TIMINGS, ...timings };
    this.now = now ?? (() => Date.now());
    this.config = null;
    this.prometheus = null;
    this.alertmanager = null;
    this.signature = null;
    /** @type {Map<string, object>} the queries, by id, with the series seen */
    this.queries = new Map();
    /** @type {Map<string, { series: object[], error: object|null }>} last result per query */
    this.results = new Map();
    this.version = null;
    this.alerts = null; // last alerts read, null before the first
    this.error = null; // Prometheus: { kind, message }
    this.alertError = null; // the alerts source, when it is Alertmanager
    this.readAt = 0;
    this.polling = null;
    this.generation = 0;
    /** Last value published per feature external id, and when. */
    this.published = new Map();
    this.publishedAt = new Map();
    this.transports = new Map();
    this.connection = null;
    this.discovered = null;
    this.alertState = { scope: null, primed: false, known: {} };
    this.pollTimer = null;
    this.stopped = false;
    // What fails again at every cycle (Gladys refusing, the reading loop):
    // one line when it starts, one when it ends.
    this.failureLog = new FailureLog(logger);
  }

  // --- Lifecycle -------------------------------------------------------------

  async start(config) {
    const saved = await this.store.load();
    for (const entry of Array.isArray(saved.queries) ? saved.queries : []) {
      const query = restoreQuery(entry);
      if (query && this.queries.size < MAX_QUERIES) {
        this.queries.set(query.id, query);
      }
    }
    const alerts = saved.alerts ?? {};
    this.alertState = {
      scope: typeof alerts.scope === 'string' ? alerts.scope : null,
      primed: alerts.primed === true,
      known: alerts.known && typeof alerts.known === 'object' ? alerts.known : {},
    };
    if (this.queries.size > 0) {
      logger.info(`${this.queries.size} query(ies) loaded`);
    }
    await this.reconfigure(config);
  }

  /** Gladys reconnected (it restarted): send everything again. */
  async resync(config) {
    this.published.clear();
    this.publishedAt.clear();
    this.transports.clear();
    this.connection = null;
    this.discovered = null;
    await this.reconfigure(config);
  }

  async reconfigure(config) {
    const languageChanged = this.config?.language !== config.language;
    this.config = config;
    if (this.signature !== signature(config)) {
      this.generation += 1; // a read in progress for the old servers is ignored
      this.signature = signature(config);
      const options = {
        auth: config.auth,
        insecure: config.allowSelfSigned,
        request: this.request,
      };
      this.prometheus = config.prometheusUrl
        ? new PrometheusClient({ url: config.prometheusUrl, ...options })
        : null;
      this.alertmanager = config.alertmanagerUrl
        ? new AlertmanagerClient({ url: config.alertmanagerUrl, ...options })
        : null;
      this.version = null;
      this.alerts = null;
      this.results.clear();
      this.error = null;
      this.alertError = null;
      this.readAt = 0;
    }
    const scope = scopeOf(config);
    if (this.alertState.scope !== scope) {
      this.generation += 1;
      this.alertState = { scope, primed: false, known: {} };
      this.save();
    }
    if (languageChanged) {
      this.discovered = null;
    }
    await this.pollAll({ publish: true });
    this.schedulePoll();
  }

  async stop() {
    this.stopped = true;
    clearTimeout(this.pollTimer);
    await this.store.flush();
  }

  save() {
    return this.store.save({
      queries: [...this.queries.values()],
      alerts: this.alertState,
    });
  }

  schedulePoll() {
    clearTimeout(this.pollTimer);
    if (!this.timersEnabled || this.stopped || !this.prometheus) {
      return;
    }
    this.pollTimer = setTimeout(async () => {
      try {
        await this.pollAll();
        this.failureLog.recover('poll', 'Reading Prometheus works again');
      } catch (err) {
        this.failureLog.fail('poll', `Poll failed: ${err.message}`, 'error');
      }
      this.schedulePoll();
    }, this.config.pollIntervalMs);
  }

  // --- Reading -------------------------------------------------------------------

  async pollAll({ publish = false, fresh = false } = {}) {
    const changed = await this.poll({ fresh });
    await this.afterChanges(changed, { publish });
  }

  /** Gladys asks for a refresh (onPoll): read now. */
  async pollDevice() {
    await this.pollAll();
  }

  /** Read again when the last read is older than `freshMs` (scene actions, widget). */
  async refreshIfStale() {
    if (this.prometheus && this.now() - this.readAt >= this.timings.freshMs) {
      await this.pollAll();
    }
  }

  /**
   * Read and apply what changed. Concurrent calls share the read.
   * @returns {Promise<boolean>} whether the widget shows something new
   */
  poll({ fresh = false } = {}) {
    if (!this.prometheus) {
      return Promise.resolve(false);
    }
    if (this.polling && (fresh || this.pollingGeneration !== this.generation)) {
      // A read started before a silence, a query or a new configuration:
      // read again once it is over.
      return this.polling.catch(() => {}).then(() => this.poll());
    }
    if (!this.polling) {
      this.pollingGeneration = this.generation;
      this.polling = this.read().finally(() => {
        this.polling = null;
      });
    }
    return this.polling;
  }

  async read() {
    const { generation } = this;
    const wasError = JSON.stringify([this.error?.kind, this.alertError?.kind]);
    const previousAlerts = JSON.stringify(this.alerts);

    // Prometheus: the version (health check), then every query.
    let version = null;
    let error = null;
    const results = new Map();
    try {
      version = await this.prometheus.version();
      for (const query of this.queries.values()) {
        results.set(query.id, await this.runQuery(query.promql));
      }
    } catch (caught) {
      error = asError(caught);
    }

    // The alerts.
    let alerts = null;
    let alertError = null;
    try {
      if (this.alertmanager) {
        alerts = parseAlertmanagerAlerts(await this.alertmanager.alerts());
      } else if (!error) {
        alerts = parsePrometheusAlerts(await this.prometheus.alerts());
      }
    } catch (caught) {
      alertError = asError(caught);
    }

    if (generation !== this.generation) {
      return false; // the configuration changed meanwhile
    }
    this.readAt = this.now();
    this.applyPrometheus(version, error, results);
    this.applyAlerts(alerts, alertError);
    if (this.alerts && !alertError && !(this.error && !this.alertmanager)) {
      await this.transitions();
    }
    await this.publishStates();
    return (
      wasError !== JSON.stringify([this.error?.kind, this.alertError?.kind]) ||
      previousAlerts !== JSON.stringify(this.alerts)
    );
  }

  /**
   * One query: its series, or the reason it has none. A server error (no
   * answer, refused credentials) is thrown; a query error is kept.
   */
  async runQuery(promql) {
    try {
      const parsed = parseQueryResult(await this.prometheus.query(promql));
      return {
        series: parsed.series,
        error: parsed.error ? { result: parsed.error } : null,
      };
    } catch (err) {
      // Credentials, certificate, address: the server is wrong for every query.
      if (SERVER_ERRORS.has(err.kind)) {
        throw err;
      }
      // A refused or too heavy query (a timeout once buildinfo answered)
      // concerns this query only: the others are still read.
      return { series: [], error: { kind: err.kind, detail: err.detail ?? err.message } };
    }
  }

  serverName() {
    return hostOf(this.config.prometheusUrl);
  }

  applyPrometheus(version, error, results) {
    if (error) {
      if (this.error?.kind !== error.kind) {
        logger.warn(`Prometheus ${this.serverName()}: ${error.message}`);
      }
      this.error = error;
      return; // the last values stand
    }
    if (this.error) {
      logger.info(`Prometheus ${this.serverName()} answers again`);
    }
    if (version !== this.version) {
      logger.info(`Prometheus ${version} at ${this.serverName()}`);
    }
    this.error = null;
    this.version = version;
    let changed = false;
    for (const [id, result] of results) {
      const query = this.queries.get(id);
      if (!query) {
        continue; // removed during the read
      }
      const before = JSON.stringify(this.results.get(id)?.error ?? null);
      if (result.error && JSON.stringify(result.error) !== before) {
        logger.warn(`Query "${query.name}": ${result.error.detail ?? result.error.result}`);
      }
      this.results.set(id, result);
      changed = this.registerSeries(query, result.series) || changed;
    }
    if (changed) {
      this.save();
    }
  }

  /**
   * Give a feature to the series not seen before, up to MAX_SERIES per query:
   * its name is set now and kept (Gladys freezes it at creation anyway).
   * @returns {boolean} whether new series were registered
   */
  registerSeries(query, series) {
    const fresh = series.filter((entry) => !query.series[entry.key]);
    if (fresh.length === 0) {
      return false;
    }
    const room = MAX_SERIES - Object.keys(query.series).length;
    if (room <= 0) {
      return false;
    }
    const names = seriesNames(series, query.name, query.label);
    const taken = new Set(Object.values(query.series).map((entry) => entry.name));
    const sorted = [...fresh].sort((a, b) => names.get(a.key).localeCompare(names.get(b.key)));
    if (sorted.length > room) {
      logger.warn(`Query "${query.name}": ${MAX_SERIES} series at most, the others are left out`);
    }
    for (const entry of sorted.slice(0, room)) {
      const base = names.get(entry.key).slice(0, MAX_FEATURE_NAME);
      let name = base;
      for (let index = 2; taken.has(name); index += 1) {
        name = `${base.slice(0, MAX_FEATURE_NAME - 5)} (${index})`;
      }
      taken.add(name);
      query.series[entry.key] = { name };
    }
    return true;
  }

  applyAlerts(alerts, error) {
    if (!this.alertmanager) {
      // From Prometheus: its errors are the ones of `this.error`.
      if (error) {
        logger.debug(`Prometheus alerts: ${error.message}`);
      }
      this.alerts = alerts ?? this.alerts;
      return;
    }
    if (error) {
      if (this.alertError?.kind !== error.kind) {
        logger.warn(`Alertmanager ${hostOf(this.config.alertmanagerUrl)}: ${error.message}`);
      }
      this.alertError = error;
      return; // the last alerts stand
    }
    if (this.alertError) {
      logger.info(`Alertmanager ${hostOf(this.config.alertmanagerUrl)} answers again`);
    }
    this.alertError = null;
    this.alerts = alerts;
  }

  /**
   * Compare the alerts with the ones already seen; fire the scene events. An
   * alert is marked announced only once Gladys accepted its event (Gladys
   * restarting, a burst beyond the cap: sent at a next read), and its end is
   * announced only if its start was. A silenced alert is not announced until
   * its silence ends, nor taken for resolved meanwhile.
   */
  async transitions() {
    const { known, primed } = this.alertState;
    const current = new Map(this.alerts.map((alert) => [alert.fingerprint, alert]));
    const events = [];
    const ordered = [...current.values()].sort((a, b) => (a.startsAt ?? 0) - (b.startsAt ?? 0));
    for (const alert of ordered) {
      let entry = known[alert.fingerprint];
      if (!entry) {
        entry = {
          alertname: alert.alertname,
          severity: alert.severity,
          severityLabel: alert.severityLabel,
          summary: alert.summary.slice(0, 500),
          instance: alert.instance,
          labels: labelsText(alert.labels),
          startsAt: alert.startsAt ?? this.now(),
          announced: false,
          // The alerts already there at the first read are not announced,
          // nor their end.
          quiet: !primed,
        };
        known[alert.fingerprint] = entry;
      }
      if (!entry.announced && !entry.quiet && !alert.suppressed) {
        events.push([TRIGGERS.FIRING, alert.fingerprint, entry]);
      }
    }
    for (const [fingerprint, entry] of Object.entries(known)) {
      if (current.has(fingerprint)) {
        continue;
      }
      if (!entry.announced) {
        delete known[fingerprint]; // never announced: its end is not either
      } else {
        events.push([TRIGGERS.RESOLVED, fingerprint, entry]);
      }
    }
    this.alertState.primed = true;

    const sent = events.slice(0, MAX_EVENTS_PER_READ);
    if (events.length > sent.length) {
      logger.warn(`${events.length - sent.length} alert change(s) left for the next read`);
    }
    for (const [key, fingerprint, entry] of sent) {
      logger.debug(`${key}: ${entry.alertname} ${entry.instance}`);
      const data = this.alertEvent(fingerprint, entry);
      if (key === TRIGGERS.RESOLVED) {
        data.duration_minutes = Math.max(0, Math.round((this.now() - entry.startsAt) / 60_000));
      }
      if (!(await this.fireEvent(key, data))) {
        break; // Gladys refuses: keep the order, try again at the next read
      }
      if (key === TRIGGERS.FIRING) {
        entry.announced = true;
      } else {
        delete known[fingerprint];
      }
    }
    this.save();
  }

  alertEvent(fingerprint, entry) {
    return {
      alertname: entry.alertname,
      severity: entry.severity,
      severity_name: severityName(entry.severity, this.config.language),
      severity_label: entry.severityLabel,
      summary: entry.summary,
      instance: entry.instance,
      labels: entry.labels,
      fingerprint,
    };
  }

  /** @returns {Promise<boolean>} whether Gladys accepted the event */
  async fireEvent(key, data) {
    try {
      await this.gladys.publishSceneEvent(key, data);
      this.failureLog.recover('event', 'Scene events accepted again');
      return true;
    } catch (err) {
      this.failureLog.fail('event', `Scene event refused: ${err.message}`);
      return false;
    }
  }

  // --- Devices -----------------------------------------------------------------

  isCreated(externalId) {
    return (this.gladys.devices ?? []).some((device) => device.external_id === externalId);
  }

  discoveredDevices() {
    const queries = [...this.queries.values()].sort((a, b) => a.name.localeCompare(b.name));
    return [
      buildAlertsDevice(this.gladys, this.config.language),
      ...queries.map((query) => buildQueryDevice(this.gladys, query)),
    ];
  }

  /** Publish the Discovery list when it changed (a query added, a new series…). */
  async publishDevices({ force = false } = {}) {
    // Nothing read yet: keep the list Gladys has (an empty list only once
    // the address is removed from the configuration).
    if (!this.prometheus) {
      if (force) {
        await this.sendDiscovered([]);
      }
      return;
    }
    if (this.readAt === 0 && !force) {
      return;
    }
    await this.sendDiscovered(this.discoveredDevices(), { force });
  }

  async sendDiscovered(devices, { force = false } = {}) {
    const key = JSON.stringify(devices);
    if (!force && key === this.discovered) {
      return;
    }
    try {
      await this.gladys.publishDiscoveredDevices(devices);
      this.discovered = key;
      this.failureLog.recover('discovered', 'Discovered devices accepted again');
    } catch (err) {
      this.failureLog.fail('discovered', `Discovered devices refused: ${err.message}`);
    }
  }

  /** "Search" in the Discovery tab: read again, publish the list again. */
  async rediscover() {
    await this.poll();
    await this.publishDevices({ force: true });
  }

  /** The user added a device: its states sent before were dropped by Gladys. */
  async onDeviceCreated(device) {
    const externalId = device.external_id;
    if (externalId === alertsIds(this.gladys).device) {
      if (this.alerts) {
        await this.sendStates(alertsValues(this.gladys, this.alerts), { force: true });
      }
    } else {
      const query = this.queries.get(parseQueryId(this.gladys, externalId));
      if (!query) {
        return;
      }
      await this.sendStates(this.valuesOf(query), { force: true });
    }
    await this.publishTransports();
    this.gladys.requestWidgetRefresh(WIDGET_KEY);
  }

  valuesOf(query) {
    return queryValues(this.gladys, query, this.results.get(query.id)?.series ?? []);
  }

  // --- Publishing to Gladys ----------------------------------------------------------

  /** The states of the added devices that changed (or are due for a heartbeat). */
  async publishStates() {
    // A server that does not answer: its last values are not sent again as
    // fresh ones (the badge says unreachable, Gladys shows their age).
    const values = [];
    const alertsDown = this.alertmanager ? this.alertError : this.error;
    if (this.alerts && !alertsDown && this.isCreated(alertsIds(this.gladys).device)) {
      values.push(...alertsValues(this.gladys, this.alerts));
    }
    for (const query of this.queries.values()) {
      if (!this.error && this.isCreated(queryIds(this.gladys, query.id).device)) {
        values.push(...this.valuesOf(query));
      }
    }
    await this.sendStates(values);
  }

  async sendStates(values, { force = false } = {}) {
    const now = this.now();
    const known = values.filter(({ value }) => value !== null); // unknown: the last value stands
    const changed = known.filter(
      ({ externalId, value }) => force || this.published.get(externalId) !== value,
    );
    const due = known.filter(
      ({ externalId, value }) =>
        !force &&
        this.published.get(externalId) === value &&
        now - (this.publishedAt.get(externalId) ?? 0) >= this.timings.heartbeatMs,
    );
    const budget = Math.max(
      10,
      Math.floor((MAX_STATES_PER_MINUTE * (this.config?.pollIntervalMs ?? 60_000)) / 60_000),
    );
    const age = ({ externalId }) => this.publishedAt.get(externalId) ?? 0;
    const states = [...changed.sort((a, b) => age(a) - age(b)), ...due]
      .slice(0, force ? Infinity : budget)
      .map(({ externalId, value }) => ({ device_feature_external_id: externalId, state: value }));
    for (let at = 0; at < states.length; at += MAX_STATES_PER_REQUEST) {
      const batch = states.slice(at, at + MAX_STATES_PER_REQUEST);
      try {
        await this.gladys.publishStates(batch);
        for (const state of batch) {
          this.published.set(state.device_feature_external_id, state.state);
          this.publishedAt.set(state.device_feature_external_id, now);
        }
        this.failureLog.recover('states', 'States accepted again');
      } catch (err) {
        this.failureLog.fail('states', `States refused: ${err.message}`);
      }
    }
  }

  async afterChanges(widgetChanged, { publish = false } = {}) {
    await this.publishDevices({ force: publish });
    await this.publishTransports();
    await this.publishConnectionStatus();
    if (widgetChanged) {
      this.gladys.requestWidgetRefresh(WIDGET_KEY);
    }
  }

  /** The badge of the added devices: "local", or "unreachable" while their server is. */
  async publishTransports() {
    if (!this.prometheus || this.readAt === 0) {
      return;
    }
    const { LOCAL, UNREACHABLE } = DEVICE_TRANSPORTS;
    const alertsDown = this.alertmanager ? this.alertError !== null : this.error !== null;
    const wanted = [
      [alertsIds(this.gladys).device, alertsDown ? UNREACHABLE : LOCAL],
      ...[...this.queries.keys()].map((id) => [
        queryIds(this.gladys, id).device,
        this.error ? UNREACHABLE : LOCAL,
      ]),
    ];
    const entries = wanted
      .filter(([id, transport]) => this.isCreated(id) && this.transports.get(id) !== transport)
      .map(([id, transport]) => ({ external_id: id, transport }));
    for (let at = 0; at < entries.length; at += MAX_STATES_PER_REQUEST) {
      const batch = entries.slice(at, at + MAX_STATES_PER_REQUEST);
      try {
        await this.gladys.publishTransports(batch);
        for (const entry of batch) {
          this.transports.set(entry.external_id, entry.transport);
        }
        this.failureLog.recover('transports', 'Transports accepted again');
      } catch (err) {
        this.failureLog.fail('transports', `Transports refused: ${err.message}`);
      }
    }
  }

  /** The error of a server, in every language: "Prometheus: does not answer". */
  serverErrors() {
    const errors = [];
    if (this.error) {
      errors.push(['Prometheus', this.error.kind]);
    }
    if (this.alertError) {
      errors.push(['Alertmanager', this.alertError.kind]);
    }
    return errors;
  }

  errorText(language) {
    return this.serverErrors()
      .map(([name, kind]) => labelled(name, pick(ERROR_TEXT[kind], language), language))
      .join(' ; ');
  }

  /** The status under the integration name. */
  connectionStatus() {
    const { prometheusUrl, invalidUrl } = this.config;
    if (invalidUrl) {
      return { connected: false, message: CONNECTION_TEXT.invalidUrl };
    }
    if (!prometheusUrl) {
      return { connected: false, message: CONNECTION_TEXT.noServer };
    }
    if (this.serverErrors().length === 0) {
      return { connected: true };
    }
    return { connected: false, message: inEveryLanguage((language) => this.errorText(language)) };
  }

  async publishConnectionStatus() {
    const status = this.connectionStatus();
    const key = JSON.stringify(status);
    if (key === this.connection) {
      return;
    }
    try {
      await this.gladys.setConnectionStatus(status.connected, status.message);
      this.connection = key;
      this.failureLog.recover('connection', 'Connection status accepted again');
    } catch (err) {
      this.failureLog.fail('connection', `Connection status refused: ${err.message}`);
    }
  }

  // --- Views (widget, scene actions) ------------------------------------------------

  /** The alerts that fire (not silenced nor inhibited), most severe then newest first. */
  firingAlerts() {
    const rank = { critical: 0, warning: 1, info: 2, other: 3 };
    return (this.alerts ?? [])
      .filter((alert) => !alert.suppressed)
      .sort(
        (a, b) =>
          rank[a.severity] - rank[b.severity] ||
          (b.startsAt ?? 0) - (a.startsAt ?? 0) ||
          a.alertname.localeCompare(b.alertname),
      );
  }

  // --- Configuration actions ---------------------------------------------------------

  /** "Test the connection": read now, one line. */
  async testConnection() {
    await this.pollAll({ publish: true, fresh: true });
    const status = this.connectionStatus();
    return inEveryLanguage((language) => {
      const text = REPORT_TEXT[language];
      if (!this.prometheus) {
        return pick(status.message, language);
      }
      const parts = [];
      if (this.error) {
        parts.push(this.errorText(language));
      } else {
        parts.push(text.ok, `Prometheus ${this.version}`);
        parts.push(this.queries.size > 0 ? text.queries(this.queries.size) : text.noQuery);
        for (const query of this.queries.values()) {
          const problem = this.queryProblem(query, language);
          if (problem) {
            parts.push(labelled(query.name, problem, language));
          }
        }
      }
      if (this.alertError && !this.error) {
        parts.push(this.errorText(language));
      } else if (this.alerts) {
        parts.push(text.alerts(this.firingAlerts().length));
        if (!this.alertmanager) {
          parts.push(text.noAlertmanager);
        }
      }
      return sentence(parts);
    });
  }

  /** Why a query shows nothing, in one language; null when it has series. */
  queryProblem(query, language) {
    const result = this.results.get(query.id);
    if (!result) {
      return null;
    }
    if (result.error?.result) {
      return pick(RESULT_TEXT[result.error.result], language);
    }
    if (result.error) {
      return `${pick(ERROR_TEXT[result.error.kind] ?? ERROR_TEXT.http, language)} (${result.error.detail})`;
    }
    return result.series.length === 0 ? pick(RESULT_TEXT.empty, language) : null;
  }

  /** "Add a query": checked against Prometheus first, then saved. */
  async addQuery(fields) {
    const { query, error } = parseQueryFields(fields);
    if (error) {
      throw new AnswerError(QUERY_FIELD_TEXT[error]);
    }
    const existing = this.queries.get(query.id);
    if (!existing && this.queries.size >= MAX_QUERIES) {
      throw new AnswerError(
        inEveryLanguage((language) => REPORT_TEXT[language].tooMany(MAX_QUERIES)),
      );
    }
    if (!this.prometheus) {
      throw new AnswerError(CONNECTION_TEXT.noServer);
    }
    let result = null;
    try {
      result = await this.runQuery(query.promql);
    } catch (err) {
      logger.debug(`Query "${query.name}" not checked: ${err.message}`);
    }
    if (result?.error?.kind === ERROR_KINDS.QUERY) {
      throw new AnswerError(
        inEveryLanguage((language) => REPORT_TEXT[language].refused(result.error.detail)),
      );
    }
    if (result?.error?.result) {
      // A range vector or a string never gives a number: refused too.
      throw new AnswerError(
        inEveryLanguage((language) =>
          REPORT_TEXT[language].refused(pick(RESULT_TEXT[result.error.result], language)),
        ),
      );
    }
    // Same expression, type and label: the series and their names stay.
    const same =
      existing &&
      existing.promql === query.promql &&
      existing.type === query.type &&
      existing.label === query.label;
    const saved = { ...query, series: same ? existing.series : {} };
    if (!existing && this.queries.size >= MAX_QUERIES) {
      // Another "Add a query" finished during the check.
      throw new AnswerError(
        inEveryLanguage((language) => REPORT_TEXT[language].tooMany(MAX_QUERIES)),
      );
    }
    this.queries.set(saved.id, saved);
    this.generation += 1; // a read in progress does not know this query
    if (result) {
      this.results.set(saved.id, result);
      this.registerSeries(saved, result.series);
    } else {
      this.results.delete(saved.id);
    }
    await this.save();
    logger.info(`Query ${existing ? 'updated' : 'added'}: ${saved.name}`);
    await this.publishDevices();
    if (this.isCreated(queryIds(this.gladys, saved.id).device)) {
      await this.sendStates(this.valuesOf(saved), { force: true });
    }
    const count = result?.series.length ?? 0;
    return inEveryLanguage((language) => {
      const text = REPORT_TEXT[language];
      const parts = [existing ? text.updated(saved.name) : text.added(saved.name)];
      if (!result) {
        parts.push(text.notChecked);
      } else if (result.error) {
        parts.push(this.queryProblem(saved, language));
      } else if (count === 0) {
        parts.push(pick(RESULT_TEXT.empty, language));
      } else {
        parts.push(text.series(count));
        if (count > MAX_SERIES) {
          parts.push(text.capped(MAX_SERIES));
        }
      }
      if (!this.isCreated(queryIds(this.gladys, saved.id).device)) {
        parts.push(text.discovery);
      }
      return sentence(parts);
    });
  }

  /** "Remove a query", by its name. */
  async removeQuery(fields) {
    const name = typeof fields?.name === 'string' ? fields.name.trim() : '';
    const query = name ? this.queries.get(queryId(name)) : null;
    if (!query) {
      throw new AnswerError(inEveryLanguage((language) => REPORT_TEXT[language].notFound(name)));
    }
    this.queries.delete(query.id);
    this.results.delete(query.id);
    this.generation += 1;
    await this.save();
    logger.info(`Query removed: ${query.name}`);
    await this.publishDevices();
    return inEveryLanguage((language) => {
      const text = REPORT_TEXT[language];
      return sentence([text.removed(query.name), text.queries(this.queries.size)]);
    });
  }
}

/** Anything thrown by a client, as a PrometheusError. */
function asError(caught) {
  return caught?.kind ? caught : new PrometheusError(ERROR_KINDS.HTTP, String(caught?.message));
}

/** The labels of an alert, as text: "alertname=X, instance=Y". */
export function labelsText(labels) {
  return Object.entries(labels)
    .map(([name, value]) => `${name}=${value}`)
    .join(', ')
    .slice(0, 1000);
}
