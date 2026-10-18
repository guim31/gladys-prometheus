// -----------------------------------------------------------------------------
// Dashboard widget (manifest `widgets`, Gladys 5.1+): `alerts`.
//
// The use case: a glance at the wall tablet tells whether the homelab is
// fine, and if not, what fires where. So the widget shows the number of
// firing alerts, the critical ones, the silenced ones, and one row per alert
// — the most severe first — with its name, its instance (or summary), and
// its severity as icon and colour.
//
// The figures are sent as values, not bound to device features: the widget
// works before any device is added.
//
// Budget (8 components, 2 texts): three tiles, one text while a server does
// not answer, one status list of ten rows at most, and a Refresh button.
// -----------------------------------------------------------------------------

import { WIDGET_COLORS } from '@gladysassistant/integration-sdk';
import { WIDGET_KEY } from './hub.js';
import { pick } from './texts.js';

// Action key of the button: permanent once published.
export const ACTIONS = Object.freeze({ REFRESH: 'refresh' });

export const MAX_ROWS = 10;

export const TEXT = {
  configure: {
    en: 'Enter the address of your Prometheus in the configuration of the integration.',
    fr: "Saisissez l'adresse de votre Prometheus dans la configuration de l'intégration.",
    de: 'Gib die Adresse deines Prometheus in der Konfiguration der Integration ein.',
    es: 'Introduzca la dirección de su Prometheus en la configuración de la integración.',
  },
  firing: { en: 'Firing', fr: 'Actives', de: 'Aktiv', es: 'Activas' },
  critical: { en: 'Critical', fr: 'Critiques', de: 'Kritisch', es: 'Críticas' },
  silenced: { en: 'Silenced', fr: 'En silence', de: 'Stumm', es: 'Silenciadas' },
  allClear: { en: 'No alert', fr: 'Aucune alerte', de: 'Kein Alarm', es: 'Ninguna alerta' },
  more: { en: 'Others', fr: 'Autres', de: 'Weitere', es: 'Otras' },
  refresh: { en: 'Refresh', fr: 'Actualiser', de: 'Aktualisieren', es: 'Actualizar' },
  refreshed: {
    en: 'Alerts read again.',
    fr: 'Alertes relues.',
    de: 'Alarme neu gelesen.',
    es: 'Alertas leídas de nuevo.',
  },
};

const SEVERITY_STYLE = {
  critical: { icon: 'alert-octagon', color: WIDGET_COLORS.DANGER },
  warning: { icon: 'alert-triangle', color: WIDGET_COLORS.WARNING },
  info: { icon: 'info', color: WIDGET_COLORS.INFO },
  other: { icon: 'help-circle', color: WIDGET_COLORS.NEUTRAL },
};

const fit = (text, max) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

const refreshButton = (language) => ({
  type: 'button',
  label: pick(TEXT.refresh, language),
  icon: 'refresh-cw',
  style: 'secondary',
  action: { key: ACTIONS.REFRESH },
});

async function get(hub, { language = 'en' }) {
  if (!hub.prometheus) {
    return {
      ttl_seconds: 300,
      components: [{ type: 'text', variant: 'body', text: pick(TEXT.configure, language) }],
    };
  }
  const errorText = hub.errorText(language);
  const error = errorText ? { type: 'text', variant: 'body', text: fit(errorText, 200) } : null;
  if (!hub.alerts) {
    return { ttl_seconds: 30, components: [error, refreshButton(language)].filter(Boolean) };
  }

  const firing = hub.firingAlerts();
  const critical = firing.filter((alert) => alert.severity === 'critical').length;
  const silenced = hub.alerts.length - firing.length;
  const worst = firing[0]?.severity;
  const components = [
    {
      type: 'value',
      value: firing.length,
      label: pick(TEXT.firing, language),
      icon: 'bell',
      color:
        worst === 'critical'
          ? WIDGET_COLORS.DANGER
          : worst
            ? WIDGET_COLORS.WARNING
            : WIDGET_COLORS.SUCCESS,
    },
    {
      type: 'value',
      value: critical,
      label: pick(TEXT.critical, language),
      icon: 'alert-octagon',
      color: critical > 0 ? WIDGET_COLORS.DANGER : WIDGET_COLORS.NEUTRAL,
    },
    {
      type: 'value',
      value: silenced,
      label: pick(TEXT.silenced, language),
      icon: 'bell-off',
      color: WIDGET_COLORS.NEUTRAL,
    },
  ];
  if (error) {
    components.push(error);
  }

  let items;
  if (firing.length === 0) {
    items = [
      {
        label: pick(TEXT.allClear, language),
        value: hub.version ? `Prometheus ${hub.version}` : 'Prometheus',
        icon: 'check-circle',
        color: WIDGET_COLORS.SUCCESS,
      },
    ];
  } else {
    const shown = firing.length > MAX_ROWS ? firing.slice(0, MAX_ROWS - 1) : firing;
    items = shown.map((alert) => ({
      label: fit(alert.alertname, 40),
      value: fit(alert.instance || alert.summary || alert.severityLabel || '-', 40),
      ...SEVERITY_STYLE[alert.severity],
    }));
    if (firing.length > shown.length) {
      items.push({
        label: pick(TEXT.more, language),
        value: `+${firing.length - shown.length}`,
        icon: 'more-horizontal',
        color: WIDGET_COLORS.NEUTRAL,
      });
    }
  }
  components.push({ type: 'status', items });
  components.push(refreshButton(language));

  // An alert moves fast: refresh sooner.
  return { ttl_seconds: firing.length > 0 || error ? 30 : 60, components };
}

async function action(hub, { actionKey }) {
  if (actionKey !== ACTIONS.REFRESH) {
    throw new Error(`Unknown action ${actionKey}`);
  }
  await hub.pollAll({ fresh: true });
  return { message: TEXT.refreshed };
}

export const WIDGETS = {
  [WIDGET_KEY]: { get, action },
};
