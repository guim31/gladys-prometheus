# Security policy

## Reporting a vulnerability

Please do **not** report a security problem in a public issue, pull request or
forum post.

Report it privately through GitHub instead: open the **Security** tab of this
repository, then **Report a vulnerability**.

No such button? Private reporting is not enabled yet: open an issue that only
asks the maintainers for a private contact, without any detail of the problem,
and send the report there.

Include, when you can:

- the version of the integration and of Gladys;
- what an attacker can do, and the steps to reproduce it;
- the log lines that help (remove tokens, passwords and addresses first).

The fix ships as a new version of the integration, and the advisory is
published once users can update.

## Supported versions

Only the latest release receives security fixes: update the integration from
Gladys before reporting a problem.

## Scope

In scope: the code of this repository and the Docker image it publishes.

What the integration handles:

- **Secrets**: the optional password and Bearer token are `secret` fields of
  the Gladys configuration. The integration reads them from Gladys at startup,
  keeps them in memory, sends them only in the `Authorization` header of its
  requests to the Prometheus and Alertmanager addresses of the configuration,
  and never writes them to `/data` nor to the logs. An address with
  credentials inside (`http://user:pass@…`) is refused, so that none ends up
  in a log line.
- **Stored in `/data`**: `prometheus-state.json`, the PromQL queries added by
  the user (name, expression, type, label, names of the series already seen)
  and the alerts already seen (labels, summary, start time), so that a restart
  neither repeats nor misses a scene event. No secret.
- **Writes**: the only request that changes anything is the creation of a
  silence in Alertmanager, by the "Silence an alert" scene action, which can be
  turned off in the configuration. PromQL is read-only.
- **Network**: requests go only to the addresses typed in the configuration,
  in HTTP or HTTPS. HTTPS certificates are verified unless the user ticks
  "Accept self-signed certificates"; the integration opens no port and calls
  no cloud service.

Out of scope: Gladys Assistant itself (see its
[security policy](https://github.com/GladysAssistant/Gladys/security/policy)),
Prometheus and Alertmanager themselves, and what they monitor.
