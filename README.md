# Prometheus for Gladys Assistant

A [Gladys Assistant](https://gladysassistant.com) integration for
[Prometheus](https://prometheus.io/) and
[Alertmanager](https://prometheus.io/docs/alerting/latest/alertmanager/): the
PromQL queries you choose become Gladys sensors, the alerts become scene
triggers, a scene can silence an alert, and a dashboard widget lists the alerts
in progress.

It reads the HTTP APIs of Prometheus and Alertmanager on your local network.
Nothing goes through a cloud.

## Features

- **One device per PromQL query**, added with the **Add a query** action of
  the configuration: one feature per series (20 at most), named after their
  labels, of the type you choose — number, temperature, percentage, power,
  energy, data rate, size, duration or on/off.
- **A "Prometheus alerts" device**: the firing alerts, in total and by
  severity (critical, warning, info), and the silenced ones.
- **Scene triggers**: an alert fires, an alert is resolved (filters: alert
  name, severities), with its name, severity, summary, instance and labels.
- **Scene actions**: silence an alert in Alertmanager for a while (can be
  turned off), read the firing alerts (counts and list), read a PromQL value.
- **Widget**: the firing alerts, the most severe first, and the silenced ones.
- Optional Basic or Bearer authentication (a reverse proxy), self-signed
  certificates on request.
- Feature names, messages and documentation in English, French, German and
  Spanish.

## Requirements

- Gladys Assistant 5.1.0 or later.
- Prometheus 2.x or 3.x reachable from Gladys; optionally Alertmanager (API
  v2) for the silences. Without Alertmanager, the alerts are read from the
  alerting rules of Prometheus.

## Installation

1. In Gladys, open **Integrations** → **Install from GitHub** and enter the
   address of this repository: `https://github.com/guim31/gladys-prometheus`
   (or install **Prometheus** from the catalog once it is listed).
2. In **Configuration**, enter the address of Prometheus
   (`http://192.168.1.2:9090`) and, optionally, of Alertmanager. Save, then
   click **Test the connection**.
3. Still in **Configuration**, add your queries with **Add a query** (name,
   PromQL expression, type).
4. Open the **Discover** tab and add the devices to follow.

The user guide is in [`docs/en.md`](docs/en.md) (also in
[French](docs/fr.md), [German](docs/de.md) and [Spanish](docs/es.md)); Gladys
links it from the Configuration screen.

## How it works

Every 30 seconds by default (15 seconds to 5 minutes), the integration calls
`/api/v1/status/buildinfo` (health check and version), `/api/v1/query` once per
query, and the alerts: `/api/v2/alerts` of Alertmanager, or `/api/v1/alerts`
of Prometheus (firing alerts only). The states of the added devices are sent
only when they change (and every 6 hours), the scene events on every new or
resolved alert, added device or not. The queries, the series already named and
the alerts already seen are kept in `/data`: a restart neither repeats nor
misses an alert. A silence is a `POST /api/v2/silences` with exact matchers.

## Checked on a real Prometheus

On 18/10/2026, the integration ran in a container with the constraints of the
Gladys sandbox (read-only rootfs, no capability, 256 MB) against Prometheus
3.15.0, Alertmanager 0.34.1 and node-exporter (official images), with alerting
rules that always fire, a target that does not answer, and a rule driven by
stopping node-exporter: queries of several series, a refused PromQL, a range
vector, alerts fired and resolved (scene events), a silence created then
expired, the widget. The answers are kept as fixtures in
[`test/fixtures/real`](test/fixtures/real). Not yet run in a real Gladys
instance: feedback welcome.

## Limitations

- One Prometheus (and one Alertmanager) per integration.
- 20 queries, 20 series per query; values rounded to two decimals.
- Silences can be created, not removed from Gladys.
- The queries live in the data volume of the integration: a reinstallation
  from scratch loses them.

## Development

```bash
npm ci
npm run format:check && npm run lint && npm test
npx -y github:GladysAssistant/integration-store --skip-image-check .
```

The tests run against the fake Gladys of the SDK and an in-memory Prometheus
and Alertmanager (`test/helpers/fakePrometheus.js`) seeded with real answers.
See [`CLAUDE.md`](CLAUDE.md) for the project rules.

## Credits

- Started from the official
  [integration template](https://github.com/GladysAssistant/integration-template-js)
  and the [integration SDK](https://github.com/GladysAssistant/integration-sdk-js)
  of Gladys Assistant (Apache-2.0).
- The Home Assistant custom integrations
  [ha-prometheus-sensor](https://github.com/mweinelt/ha-prometheus-sensor)
  (MIT) and
  [homeassistant-prometheus-query](https://github.com/lfasci/homeassistant-prometheus-query)
  were read for the use cases; no code is copied from them.
- The [Prometheus logo](https://github.com/prometheus/prometheus/blob/main/documentation/images/prometheus-logo.svg)
  (Apache-2.0, The Prometheus Authors) is used on the cover image.
- Architecture shared with
  [gladys-zabbix](https://github.com/guim31/gladys-zabbix).

## Disclaimer

Not affiliated with the Prometheus project or the Cloud Native Computing
Foundation. Prometheus is a trademark of The Linux Foundation.

## License

[Apache-2.0](LICENSE)
