// -----------------------------------------------------------------------------
// HTTP clients of the Prometheus API (`/api/v1`) and of the Alertmanager API
// (`/api/v2`). Both are read-only, except the creation of a silence.
//
// Prometheus answers `{ status: "success", data }` or `{ status: "error",
// errorType, error }` (400 bad_data for a PromQL that does not parse, 422
// execution for one that fails, 503 timeout). Alertmanager answers the bare
// JSON (an array of alerts, `{ silenceID }`).
//
// Authentication is optional: none, Basic (user and password) or Bearer (a
// token), as a reverse proxy in front of the servers asks; the same for both.
//
// Errors are thrown as PrometheusError with a `kind` (ERROR_KINDS): the hub
// and the texts know what to tell the user from it.
// -----------------------------------------------------------------------------

import { httpRequest } from './http.js';

export const ERROR_KINDS = Object.freeze({
  UNREACHABLE: 'unreachable', // no answer, timeout, 502/503/504 of a reverse proxy
  TLS: 'tls', // the certificate does not verify (self-signed without the option)
  AUTH: 'auth', // 401/403: credentials refused or missing
  NOT_PROMETHEUS: 'not_prometheus', // something answers, but not the expected API
  REDIRECT: 'redirect', // HTTP redirected (to HTTPS, to a login page)
  QUERY: 'query', // Prometheus refused the PromQL (parse or execution error)
  HTTP: 'http', // anything else
});

export class PrometheusError extends Error {
  /**
   * @param {string} kind one of ERROR_KINDS
   * @param {string} message for the logs (never a password nor a token)
   * @param {object} [extra] e.g. { status, detail }
   */
  constructor(kind, message, extra = {}) {
    super(message);
    this.name = 'PrometheusError';
    this.kind = kind;
    Object.assign(this, extra);
  }
}

const TLS_CODES = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_HAS_EXPIRED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

/**
 * The Authorization header of the configuration: Bearer wins over Basic when
 * both are filled; none when neither is.
 * @param {{ username?: string, password?: string, bearerToken?: string }} auth
 */
export function authorizationHeader({ username = '', password = '', bearerToken = '' } = {}) {
  if (bearerToken) {
    return `Bearer ${bearerToken}`;
  }
  if (username || password) {
    return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
  }
  return null;
}

class BaseClient {
  /**
   * @param {object} options
   * @param {string} options.url base URL, without trailing slash
   * @param {object} [options.auth] { username, password, bearerToken }
   * @param {boolean} [options.insecure] accept a self-signed certificate
   * @param {typeof httpRequest} [options.request] test seam
   * @param {number} [options.timeoutMs]
   */
  constructor({ url, auth = {}, insecure = false, request = httpRequest, timeoutMs = 15_000 }) {
    this.url = url;
    this.authorization = authorizationHeader(auth);
    this.insecure = insecure;
    this.request = request;
    this.timeoutMs = timeoutMs;
  }

  /**
   * One request; the parsed JSON body (null when not JSON) and the status.
   * @throws {PrometheusError} on a network, TLS, redirect, auth or proxy error
   */
  async send(path, { method = 'GET', json } = {}) {
    const headers = { accept: 'application/json' };
    if (this.authorization) {
      headers.authorization = this.authorization;
    }
    let body = '';
    if (json !== undefined) {
      body = JSON.stringify(json);
      headers['content-type'] = 'application/json';
    }
    let response;
    try {
      response = await this.request(`${this.url}${path}`, {
        method,
        body,
        headers,
        insecure: this.insecure,
        timeoutMs: this.timeoutMs,
      });
    } catch (err) {
      if (TLS_CODES.has(err.code)) {
        throw new PrometheusError(ERROR_KINDS.TLS, `Certificate refused (${err.code})`);
      }
      if (!err.code) {
        // The server answers, but not as expected (an answer too large…).
        throw new PrometheusError(ERROR_KINDS.HTTP, err.message);
      }
      throw new PrometheusError(ERROR_KINDS.UNREACHABLE, `${err.code}`);
    }
    const { status } = response;
    if (status >= 300 && status < 400) {
      throw new PrometheusError(ERROR_KINDS.REDIRECT, `Redirected (HTTP ${status})`, { status });
    }
    if ([502, 503, 504].includes(status) && !this.isApiError(response.body)) {
      // A reverse proxy in front of a stopped server.
      throw new PrometheusError(ERROR_KINDS.UNREACHABLE, `HTTP ${status}`, { status });
    }
    if (status === 401 || status === 403) {
      throw new PrometheusError(ERROR_KINDS.AUTH, `Refused (HTTP ${status})`, { status });
    }
    let parsed;
    try {
      parsed = JSON.parse(response.body);
    } catch {
      parsed = null;
    }
    return { status, parsed };
  }

  /** An answer of the Prometheus API itself (a 503 query timeout is one). */
  isApiError(body) {
    try {
      return JSON.parse(body)?.status === 'error';
    } catch {
      return false;
    }
  }
}

export class PrometheusClient extends BaseClient {
  /**
   * A `/api/v1` call: the `data` member.
   * @throws {PrometheusError}
   */
  async api(path) {
    const { status, parsed } = await this.send(`/api/v1/${path}`);
    if (!parsed || typeof parsed !== 'object' || !['success', 'error'].includes(parsed.status)) {
      throw new PrometheusError(
        status === 200 || status === 404 ? ERROR_KINDS.NOT_PROMETHEUS : ERROR_KINDS.HTTP,
        `Not a Prometheus API answer (HTTP ${status})`,
        { status },
      );
    }
    if (parsed.status === 'error') {
      const detail = String(parsed.error ?? parsed.errorType ?? 'error');
      const kind = ['bad_data', 'execution', 'timeout'].includes(parsed.errorType)
        ? ERROR_KINDS.QUERY
        : ERROR_KINDS.HTTP;
      throw new PrometheusError(kind, `${path.split('?')[0]}: ${detail}`, { status, detail });
    }
    return parsed.data;
  }

  /** The version of the server ("3.15.0"); Thanos and VictoriaMetrics answer too. */
  async version() {
    const data = await this.api('status/buildinfo');
    return typeof data?.version === 'string' && data.version ? data.version : '?';
  }

  /**
   * An instant query.
   * @param {string} promql
   * @returns {Promise<{ resultType: string, result: unknown }>}
   */
  async query(promql) {
    const data = await this.api(`query?query=${encodeURIComponent(promql)}`);
    if (!data || typeof data.resultType !== 'string') {
      throw new PrometheusError(ERROR_KINDS.HTTP, 'query: unexpected answer');
    }
    return data;
  }

  /** The alerts of the alerting rules (`firing` and `pending`). */
  async alerts() {
    const data = await this.api('alerts');
    if (!Array.isArray(data?.alerts)) {
      throw new PrometheusError(ERROR_KINDS.HTTP, 'alerts: unexpected answer');
    }
    return data.alerts;
  }
}

export class AlertmanagerClient extends BaseClient {
  /** The alerts not resolved: active, silenced, inhibited, unprocessed. */
  async alerts() {
    const { status, parsed } = await this.send('/api/v2/alerts');
    if (status !== 200 || !Array.isArray(parsed)) {
      throw new PrometheusError(
        status === 200 || status === 404 ? ERROR_KINDS.NOT_PROMETHEUS : ERROR_KINDS.HTTP,
        `Not an Alertmanager API answer (HTTP ${status})`,
        { status },
      );
    }
    return parsed;
  }

  /**
   * Create a silence.
   * @param {object} silence { matchers, startsAt, endsAt, createdBy, comment }
   * @returns {Promise<string>} the silence id
   */
  async createSilence(silence) {
    const { status, parsed } = await this.send('/api/v2/silences', {
      method: 'POST',
      json: silence,
    });
    if (status !== 200 || typeof parsed?.silenceID !== 'string') {
      const detail = typeof parsed === 'string' ? parsed : `HTTP ${status}`;
      throw new PrometheusError(
        status === 400 ? ERROR_KINDS.QUERY : ERROR_KINDS.HTTP,
        `silence refused: ${detail}`,
        { status, detail },
      );
    }
    return parsed.silenceID;
  }
}
