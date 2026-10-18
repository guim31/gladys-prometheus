// -----------------------------------------------------------------------------
// Scene action handlers (manifest `scene_actions`, Gladys 5.1+).
//
// "Is an alert firing?" is already a scene condition on the alerts device.
// These actions do what a condition cannot:
//   - silence an alert in Alertmanager for a while, from a scene (a button
//     of the dashboard, a vocal command, "I know, I'm on it") — can be
//     turned off in the configuration;
//   - put the firing alerts in words for a message ("2 alerts: TargetDown
//     (nas:9100)…");
//   - read one PromQL value in a scene, without making it a device.
// The alert actions read again when the last read is older than 15 seconds.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { ERROR_KINDS } from './prometheus/client.js';
import { parseMatchers, parseQueryResult, seriesNames } from './prometheus/model.js';
import { MAX_PROMQL_LENGTH, featureValue } from './queries.js';
import { ACTION_TEXT, ERROR_TEXT, RESULT_TEXT, labelled, pick, severityName } from './texts.js';

const logger = createLogger({ name: 'prometheus-scenes' });

// Silence durations offered, in minutes (the `duration` select of the manifest).
export const SILENCE_DURATIONS = ['15', '30', '60', '120', '240', '480', '720', '1440', '10080'];
export const DEFAULT_SILENCE_DURATION = '60';
// Alerts listed in the `names` output, at most (the rest is counted).
export const MAX_LISTED_ALERTS = 20;
// Series listed in the `text` output of a query, at most.
export const MAX_LISTED_SERIES = 10;

const fail = (text, language, cause) => {
  throw new Error(pick(text, language), cause ? { cause } : undefined);
};

function assertAlerts(hub, language) {
  if (!hub.prometheus) {
    fail(ACTION_TEXT.noServer, language);
  }
  const error = hub.alertmanager ? hub.alertError : hub.error;
  if (error || !hub.alerts) {
    fail(ERROR_TEXT[error?.kind ?? ERROR_KINDS.UNREACHABLE], language);
  }
}

/** "TargetDown (nas:9100)" */
const alertLabel = (alert) =>
  alert.instance ? `${alert.alertname} (${alert.instance})` : alert.alertname;

const matches = (alert, alertname, matchers) =>
  alert.alertname === alertname &&
  Object.entries(matchers).every(([name, value]) => alert.labels[name] === value);

export const SCENE_ACTIONS = {
  async silence_alert(hub, { fields = {} }) {
    const language = hub.config?.language;
    if (!hub.prometheus) {
      fail(ACTION_TEXT.noServer, language);
    }
    if (!hub.config.allowSilence) {
      fail(ACTION_TEXT.silenceDisabled, language);
    }
    if (!hub.alertmanager) {
      fail(ACTION_TEXT.noAlertmanager, language);
    }
    const alertname = typeof fields.alertname === 'string' ? fields.alertname.trim() : '';
    if (!alertname) {
      fail(ACTION_TEXT.noAlertname, language);
    }
    const matchers = parseMatchers(fields.labels);
    if (!matchers) {
      fail(ACTION_TEXT.badMatchers, language);
    }
    delete matchers.alertname;
    const duration = SILENCE_DURATIONS.includes(String(fields.duration))
      ? Number(fields.duration)
      : Number(DEFAULT_SILENCE_DURATION);
    const typed = typeof fields.comment === 'string' ? fields.comment.trim() : '';
    const now = hub.now();
    let silenceId;
    try {
      silenceId = await hub.alertmanager.createSilence({
        matchers: Object.entries({ alertname, ...matchers }).map(([name, value]) => ({
          name,
          value,
          isRegex: false,
          isEqual: true,
        })),
        startsAt: new Date(now).toISOString(),
        endsAt: new Date(now + duration * 60_000).toISOString(),
        createdBy: 'Gladys',
        comment: (typed || pick(ACTION_TEXT.defaultComment, language)).slice(0, 500),
      });
    } catch (err) {
      logger.warn(`Silencing ${alertname} failed: ${err.message}`);
      if (err.kind === ERROR_KINDS.AUTH || err.kind === ERROR_KINDS.QUERY) {
        fail(ACTION_TEXT.silenceRefused, language, err);
      }
      fail(ERROR_TEXT[err.kind] ?? ERROR_TEXT.http, language, err);
    }
    logger.info(`Alert ${alertname} silenced for ${duration} min`);
    await hub.pollAll({ fresh: true });
    const silenced = (hub.alerts ?? []).filter((alert) => matches(alert, alertname, matchers));
    return { silence_id: silenceId, alerts_silenced: silenced.length };
  },

  async get_alerts(hub, { fields = {} }) {
    const language = hub.config?.language;
    await hub.refreshIfStale();
    assertAlerts(hub, language);
    let alerts = hub.firingAlerts();
    if (typeof fields.severity === 'string' && fields.severity) {
      alerts = alerts.filter((alert) => alert.severity === fields.severity);
    }
    const listed = alerts.slice(0, MAX_LISTED_ALERTS).map(alertLabel);
    const highest = alerts[0]?.severity ?? null;
    return {
      count: alerts.length,
      critical: alerts.filter((alert) => alert.severity === 'critical').length,
      warning: alerts.filter((alert) => alert.severity === 'warning').length,
      highest_severity: severityName(highest, language),
      names:
        alerts.length > listed.length
          ? `${listed.join(', ')}, +${alerts.length - listed.length}`
          : listed.join(', '),
    };
  },

  async query_value(hub, { fields = {} }) {
    const language = hub.config?.language;
    if (!hub.prometheus) {
      fail(ACTION_TEXT.noServer, language);
    }
    const promql = typeof fields.promql === 'string' ? fields.promql.trim() : '';
    if (!promql || promql.length > MAX_PROMQL_LENGTH) {
      fail(ACTION_TEXT.noPromql, language);
    }
    let parsed;
    try {
      parsed = parseQueryResult(await hub.prometheus.query(promql));
    } catch (err) {
      const text = pick(ERROR_TEXT[err.kind] ?? ERROR_TEXT.http, language);
      throw new Error(err.kind === ERROR_KINDS.QUERY ? `${text}: ${err.detail}` : text, {
        cause: err,
      });
    }
    if (parsed.error) {
      fail(RESULT_TEXT[parsed.error], language);
    }
    const series = parsed.series.filter((entry) => entry.value !== null);
    const round = (value) => featureValue('number', value);
    // Named by the labels that differ from one series to the other.
    const names = seriesNames(series, '');
    const named = series.slice(0, MAX_LISTED_SERIES).map((entry) => {
      const name = names.get(entry.key);
      return name ? labelled(name, round(entry.value), language) : String(round(entry.value));
    });
    return {
      // No series: 0, and `series` says so.
      value: series.length > 0 ? round(series[0].value) : 0,
      series: series.length,
      text:
        series.length > named.length
          ? `${named.join(', ')}, +${series.length - named.length}`
          : named.join(', '),
    };
  },
};
