// -----------------------------------------------------------------------------
// Integration configuration: defaults (they mirror the `default` values of the
// manifest `config_schema`, see test/manifest.test.js) and normalization, so
// the rest of the code never deals with strings, blanks or `undefined`.
//
// One Prometheus server, and optionally its Alertmanager. The addresses typed
// by the user can be the pages copied from the browser
// (`http://192.0.2.5:9090/graph?g0.expr=…`, `http://192.0.2.5:9093/#/alerts`):
// the API is next to them. A path prefix (`--web.route-prefix`, a reverse
// proxy) is kept.
//
// The PromQL queries are not configuration fields (Gladys has no list field):
// the "Add a query" action stores them under /data, see src/queries.js.
// -----------------------------------------------------------------------------

export const LANGUAGES = ['en', 'fr', 'de', 'es'];

// Refresh intervals offered in the configuration, in seconds.
export const POLL_INTERVALS = ['15', '30', '60', '120', '300'];

export const DEFAULT_CONFIG = {
  prometheus_url: '',
  alertmanager_url: '',
  username: '',
  password: '',
  bearer_token: '',
  poll_interval: '30',
  allow_silence: true,
  allow_self_signed: false,
  language: 'fr',
};

// The pages of the web interfaces, and the API itself: the base is before them.
const UI_PAGES =
  /\/(?:graph|query|alerts|rules|targets|service-discovery|status|flags|config|tsdb-status|agent|api\/v[12]|-\/[a-z]+)(?:\/.*)?$/i;

/**
 * Parse the address typed by the user into the base URL of the API: a bare
 * host (`192.0.2.5:9090`), a page of the web interface, or the API URL itself.
 * HTTP by default, and the default port when none is given on a bare host.
 * @param {unknown} raw
 * @param {number} defaultPort 9090 for Prometheus, 9093 for Alertmanager
 * @returns {string|null} `http(s)://host[:port][/prefix]`, null when unusable
 */
export function parseBaseUrl(raw, defaultPort) {
  if (typeof raw !== 'string') {
    return null;
  }
  const text = raw.trim();
  if (!text) {
    return null;
  }
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text);
  let url;
  try {
    url = new URL(hasScheme ? text : `http://${text}`);
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) {
    return null;
  }
  // Credentials in the address would end up in the logs: there are fields.
  if (url.username || url.password) {
    return null;
  }
  if (!hasScheme && !url.port) {
    url.port = String(defaultPort);
  }
  const path = url.pathname.replace(UI_PAGES, '').replace(/\/+$/, '');
  return `${url.origin}${path}`;
}

/** The address shown to the user: host and path, without scheme. */
export const hostOf = (baseUrl) => baseUrl.replace(/^https?:\/\//, '');

const isTrue = (value) => value === true || value === 'true';

/**
 * @param {Record<string, unknown>} raw the configuration returned by the SDK
 */
export function normalizeConfig(raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  // A pasted password or token often carries a trailing space or new line.
  const text = (key) => (typeof source[key] === 'string' ? source[key].trim() : '');
  const pick = (key, list) => {
    const value = source[key] === undefined || source[key] === null ? '' : String(source[key]);
    return list.includes(value) ? value : DEFAULT_CONFIG[key];
  };
  const typedPrometheus = text('prometheus_url');
  const typedAlertmanager = text('alertmanager_url');
  const prometheusUrl = parseBaseUrl(typedPrometheus, 9090);
  const alertmanagerUrl = parseBaseUrl(typedAlertmanager, 9093);
  return {
    prometheusUrl,
    alertmanagerUrl,
    invalidUrl:
      (Boolean(typedPrometheus) && !prometheusUrl) ||
      (Boolean(typedAlertmanager) && !alertmanagerUrl),
    auth: {
      username: text('username'),
      password: typeof source.password === 'string' ? source.password : '',
      bearerToken: text('bearer_token'),
    },
    pollIntervalMs: Number(pick('poll_interval', POLL_INTERVALS)) * 1000,
    allowSilence:
      source.allow_silence === undefined || source.allow_silence === null
        ? DEFAULT_CONFIG.allow_silence
        : isTrue(source.allow_silence),
    allowSelfSigned: isTrue(source.allow_self_signed),
    language: LANGUAGES.includes(source.language) ? source.language : DEFAULT_CONFIG.language,
  };
}
