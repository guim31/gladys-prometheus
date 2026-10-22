# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

## [1.0.1] - 2026-10-22

### Security

- Rebuilt on Node.js 24.22.1, the October 2026 security release (remote code
  execution in the Brotli decoder, CVE-2026-111497; TLS hostname and DNS
  fixes).

## [1.0.0] - 2026-10-18

### Added

- Prometheus in Gladys: one device per PromQL query, added with the "Add a
  query" configuration action (name, expression, type, label naming the
  series), one feature per series (20 at most); types number, temperature,
  percentage, power, energy, data rate, size, duration and on/off.
- A "Prometheus alerts" device: firing alerts in total and by severity
  (critical, warning, info), and silenced alerts — from Alertmanager, or from
  the alerting rules of Prometheus without it.
- Scene triggers "An alert fires" and "An alert is resolved" (filters: alert
  name, severities), never repeated nor missed across a restart.
- Scene actions "Silence an alert" (Alertmanager, can be turned off), "Read
  the alerts" and "Read a PromQL value".
- Dashboard widget "Prometheus alerts".
- Optional Basic or Bearer authentication, self-signed certificates on
  request; "Test the connection".
- Feature names, messages and documentation in English, French, German and
  Spanish.

[Unreleased]: https://github.com/guim31/gladys-prometheus/compare/v1.0.1...HEAD
[1.0.1]: https://github.com/guim31/gladys-prometheus/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/guim31/gladys-prometheus/releases/tag/v1.0.0
