# Prometheus

Bring your [Prometheus](https://prometheus.io/) monitoring into Gladys: the
PromQL queries you choose become sensors (a temperature, a disk usage, the
power of a rack, targets up or down), a "Prometheus alerts" device counts the
firing alerts by severity, and your scenes react when an alert fires or is
resolved — a red light for a critical alert, a message for a full disk. With
[Alertmanager](https://prometheus.io/docs/alerting/latest/alertmanager/), a
scene can also silence an alert for a while, and a dashboard widget lists the
alerts in progress.

The integration reads the HTTP API of Prometheus (and of Alertmanager) on your
local network. Nothing goes through a cloud.

Tested against a real Prometheus 3.15 and Alertmanager 0.34 (official Docker
images, node-exporter, alerting rules, a silence created then expired).
Feedback welcome:
[github.com/guim31/gladys-prometheus/issues](https://github.com/guim31/gladys-prometheus/issues).

## What you need

- Gladys Assistant 5.1.0 or later.
- Prometheus 2.x or 3.x, reachable from the Gladys machine (port 9090 by
  default). Servers with the same query API (Thanos Query, VictoriaMetrics)
  should work too, untested.
- Optionally Alertmanager (API v2, port 9093 by default): it gives the
  silences, and the "Silence an alert" scene action. Without it, the alerts are
  read from the alerting rules of Prometheus.
- No account: Prometheus and Alertmanager have no authentication of their own.
  Behind a reverse proxy, a user and password (Basic) or a Bearer token.

## Getting started

### 1. Configure the integration

In Gladys, open the configuration of the integration:

- **Prometheus address**: the address you open Prometheus with, e.g.
  `http://192.168.1.2:9090`. A bare `192.168.1.2` gets port 9090; the URL of a
  page (`…/graph?g0.expr=…`) or a path prefix (`https://example.com/prometheus`)
  works too.
- **Alertmanager address (optional)**: e.g. `http://192.168.1.2:9093`.
- **User (Basic)**, **Password (Basic)**, **Bearer token**: only when a reverse
  proxy asks for them. The same credentials go to both servers; the token wins
  over the user and password.
- **Refresh interval**: 30 seconds by default, from 15 seconds to 5 minutes.
- **Allow silencing from scenes**: untick to turn off the silence action.
- **Accept self-signed certificates**: only for an `https://` address whose
  certificate your browser does not trust either.
- **Language of the names**: the language of the feature names and of the
  scene results.

Click **Test the connection**: it answers with the version of Prometheus, the
queries and the firing alerts, or with what goes wrong.

### 2. Add your queries

Still in the configuration, the **Add a query** action asks for:

- **Name**: the name of the device, e.g. `NAS temperature`. Adding a query with
  the same name again replaces it (same device).
- **PromQL expression**: an instant query whose result is a number per series,
  e.g. `node_hwmon_temp_celsius{chip="platform_coretemp_0"}`, or
  `100 - 100 * node_filesystem_avail_bytes{mountpoint="/"} / node_filesystem_size_bytes{mountpoint="/"}`.
  A range vector (`up[5m]`) or a text is refused: wrap it in `rate()` or
  `avg_over_time()`.
- **Type**: what Gladys shows. Number (no unit), Temperature (°C),
  Percentage (%), Power (W), Energy (kWh), Data rate (bytes/s), Size (bytes),
  Duration (seconds), or On/off (0 or 1) — the last one turns any non-zero
  value into 1. Convert in PromQL when needed (`/ 1000` for kWh from Wh).
- **Label naming the series (optional)**: when the query returns several
  series, each one becomes a feature named after this label (e.g. `instance`).
  Empty: the labels that differ from one series to the other.

The query is checked against Prometheus first: a PromQL error is answered
with the message of Prometheus, and nothing is saved. **Remove a query**
takes a name.

### 3. Add the devices

Open the **Discover** tab of the integration and add the devices to follow.
The scene triggers work even if the alerts device is not added.

## The devices

**One device per query**, with one feature per series, 20 at most. The name
of a feature is set when the series is first seen, and Gladys keeps it once
the device is added. A series seen later adds a feature: Gladys then proposes
**Update** in the Discover tab. A series that disappears keeps its feature,
without new values.

**Prometheus alerts**, from Alertmanager when its address is set, from the
alerting rules of Prometheus otherwise (firing alerts only, not pending ones):

- **Firing alerts**: the alerts that fire and are not silenced nor inhibited;
- **Critical alerts**, **Warning alerts**, **Info alerts**: the same, by
  severity;
- **Silenced alerts**: the alerts silenced or inhibited in Alertmanager.

The severity comes from the `severity` label of the alert: `critical`,
`error`, `page`, `high` count as critical; `warning`, `warn`, `average` as
warning; `info`, `none`, `low` as info. Any other value counts in the total
only.

A device is marked unreachable while its server does not answer, and keeps
its last values.

## Dashboard

The **Prometheus alerts** widget shows the firing, critical and silenced
alerts, then one row per firing alert, the most severe first, with its
instance (or its summary). The **Refresh** button reads the servers again.

## Scenes

### Triggers

- **An alert fires**: a new firing alert. Filters: the alert name, and the
  severities (empty: any). A silenced alert is announced when its silence
  ends, if it still fires.
- **An alert is resolved**: an alert announced by the first trigger stops
  firing. Same filters, plus its duration in minutes.

Both give the scene: the alert name, the severity (in the language of the
names), the severity key (`critical`, `warning`, `info`, `other`), the
`severity` label as in Prometheus, the summary, the instance, all the labels
as text, and the fingerprint of the alert.

The alerts already firing when the integration starts the first time are not
announced. An alert that fires or resolves while Gladys or the integration
restarts is announced once it is back.

### Actions

- **Silence an alert** (Alertmanager): creates a silence for an alert name,
  and other labels if given (`instance=nas:9100, job=node`), for 15 minutes to
  a week (1 hour by default). Results: the silence id, and the firing alerts
  it silenced. Give the other labels one by one
  (`instance=…`), not the variable holding all the labels. It can be turned off in the configuration.
- **Read the alerts**: counts and lists the firing alerts, all or of one
  severity. Results: firing, critical and warning alerts, highest severity,
  and the alerts as text (`TargetDown (nas:9100), DiskFull`).
- **Read a PromQL value**: runs an expression once, without creating a device.
  Results: the value of the first series (0 when there is none), the number of
  series, and the values as text.

### Scene ideas

- **An alert fires**, severity Critical → turn the hall light red and send
  "Alert: {alert name} on {instance}" to your phone.
- **An alert is resolved** → send "{alert name} resolved after {duration}
  minutes".
- A dashboard button "I'm on it" → **Silence an alert** with the name of the
  last alert, for 2 hours.
- Every morning → **Read a PromQL value** `sum(increase(node_network_receive_bytes_total[24h])) / 1e9`
  and send "Yesterday: {value} GB downloaded".

## Troubleshooting

- **"does not answer"**: check the address and the port from the Gladys
  machine (`curl http://192.168.1.2:9090/api/v1/status/buildinfo`). Gladys runs
  the integration in a container on a bridge network: `localhost` is the
  container, not the host.
- **"access refused"**: the reverse proxy refuses the user, the password or
  the token.
- **"certificate refused"**: tick **Accept self-signed certificates**.
- **"the address redirects"**: enter the `https://` address, or the one
  without the login page of a proxy.
- **"no Prometheus or Alertmanager API at this address"**: another service
  answers there; check the port.
- **A query shows no value**: **Test the connection** tells which query has no
  series for now. Try it in the Prometheus web interface (Graph tab).
- **Logs**: in Gladys, the integration page shows its logs. Add `LOG_LEVEL=debug`
  for every read.

## Limits

- 20 queries, and 20 series per query. A query runs at every refresh: keep
  heavy queries to recording rules.
- The queries are stored in the data volume of the integration: reinstalling it
  from scratch loses them (add them again with the same names: same devices).
- Values are rounded to two decimals.
- Silences can be created, not removed: they end on their own, or in the
  Alertmanager interface.
- The alert filters of the triggers match exact values only: a threshold
  belongs to a query device and a scene condition.
- Tested with the test tools of the Gladys SDK, not yet in a real Gladys
  instance: feedback welcome.
