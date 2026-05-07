# @fgiova/haraka-otel
[![NPM version](https://img.shields.io/npm/v/@fgiova/haraka-otel.svg?style=flat)](https://www.npmjs.com/package/@fgiova/haraka-otel)
[![CI workflow](https://github.com/fgiova/haraka-plugin-otel/actions/workflows/node.js.yml/badge.svg)](https://github.com/fgiova/haraka-plugin-otel/actions/workflows/node.js.yml)
[![TypeScript](https://img.shields.io/badge/%3C%2F%3E-TypeScript-%230074c1.svg)](http://www.typescriptlang.org/)
[![Linted with Biome](https://img.shields.io/badge/Linted_with-Biome-60a5fa?style=flat&logo=biome)](https://biomejs.dev)
[![Maintainability](https://qlty.sh/gh/fgiova/projects/haraka-plugin-otel/maintainability.svg)](https://qlty.sh/gh/fgiova/projects/haraka-plugin-otel)
[![Code Coverage](https://qlty.sh/gh/fgiova/projects/haraka-plugin-otel/coverage.svg)](https://qlty.sh/gh/fgiova/projects/haraka-plugin-otel)

OpenTelemetry tracing and metrics plugin for [Haraka](https://haraka.github.io/) SMTP server.

Emits a three-level span tree per email transaction (`smtp.connection` → `smtp.transaction` → `smtp.queue`) and a focused set of metrics around connections, transactions, recipients, and queue outcomes.

Designed to work either:

- Standalone: ships its own minimal `NodeSDK` with OTLP/HTTP trace + metrics exporters configured via standard OTel env variables.
- Side-by-side with `dd-trace`: when Datadog's tracer is present (e.g. injected at the container level on Kubernetes via `DD_TRACE_OTEL_ENABLED=true`), the plugin defers to it as the global provider and skips its own SDK init.

## Install

```bash
npm install @fgiova/haraka-otel
```

The plugin only hard-depends on `@opentelemetry/api`. The OTel SDK packages (`@opentelemetry/sdk-node`, exporters, etc.) are listed as `optionalDependencies` so a Datadog-injected deployment doesn't need to install them.

For standalone use:

```bash
npm install @fgiova/haraka-otel \
  @opentelemetry/sdk-node \
  @opentelemetry/exporter-trace-otlp-http \
  @opentelemetry/exporter-metrics-otlp-http \
  @opentelemetry/sdk-metrics \
  @opentelemetry/resources \
  @opentelemetry/semantic-conventions
```

## Enable in Haraka

Haraka resolves plugin names from `config/plugins` against `node_modules/haraka-plugin-<name>`. Since this package is published under a scoped name (`@fgiova/haraka-otel`) instead of the unscoped `haraka-plugin-*` convention, you need a one-line bridge file in your Haraka instance:

```js
// haraka_home/plugins/otel.js
Object.assign(exports, require("@fgiova/haraka-otel"));
```

> Use `Object.assign(exports, ...)` — **not** `module.exports = require(...)`. Haraka's plugin loader attaches metadata (e.g. `register_hook`, logging methods) to the original `exports` object after `require()` returns; replacing the whole `module.exports` reference breaks that wiring and the plugin's hooks never fire.

Then add `otel` as the first plugin in your Haraka `config/plugins`:

```
otel
toobusy
mailauth
...
```

The bridge file is the supported pattern when consuming scoped Haraka plugin packages — it keeps the in-config name short while letting npm install the package under its real scoped path.

## Configuration (env / ini)

The bundled `NodeSDK` is initialized **only when at least one OTLP endpoint is configured** (via env or ini). With no endpoint set, the plugin loads its hooks but does not start an SDK — spans/metrics are routed to whatever `TracerProvider`/`MeterProvider` is registered globally (e.g. `dd-trace`) or dropped if none is present. This is the recommended way to run side-by-side with `dd-trace`: simply leave both ini and `OTEL_EXPORTER_OTLP_*` unset.

Every SDK-level setting can be expressed either as a standard `OTEL_*` env var or as a key in `config/otel.ini`. **When both are present, the value in `otel.ini` wins.** For multi-value settings (`headers`, `resource`) the merge is per-key: cfg keys override env keys with the same name; env keys not present in cfg are kept.

### Mapping table

| `otel.ini` key | Env equivalent | Effect |
|---|---|---|
| `[exporter] endpoint` | `OTEL_EXPORTER_OTLP_ENDPOINT` | Base OTLP endpoint. Setting this enables both traces (`/v1/traces`) and metrics (`/v1/metrics`) export. |
| `[exporter] traces_endpoint` | `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | Traces-only full URL. |
| `[exporter] metrics_endpoint` | `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` | Metrics-only full URL. |
| `[exporter.headers]` (multi-key) | `OTEL_EXPORTER_OTLP_HEADERS` (`k=v,k2=v2`) | Headers attached to both exporters. |
| `[otel] service_name` | `OTEL_SERVICE_NAME` | Service name (default `haraka`). |
| `[resource]` (multi-key) | `OTEL_RESOURCE_ATTRIBUTES` (`k=v,k2=v2`) | Extra resource attributes merged into the SDK Resource. |
| `[otel] traces_sampler` | `OTEL_TRACES_SAMPLER` | `always_on` / `always_off` / `traceidratio` / `parentbased_always_on` / `parentbased_always_off` / `parentbased_traceidratio` |
| `[otel] traces_sampler_arg` | `OTEL_TRACES_SAMPLER_ARG` | Numeric arg (0.0 - 1.0) for ratio-based samplers. |
| `[otel] metrics_exporter` | `OTEL_METRICS_EXPORTER` | Set to `none` to disable metrics export even if a metrics endpoint is configured. |
| `[otel] metric_export_interval` | `OTEL_METRIC_EXPORT_INTERVAL` | Periodic metric export interval in ms (default 60000). |

### Example

```ini
[otel]
service_name = mail-edge
traces_sampler = parentbased_traceidratio
traces_sampler_arg = 0.1
metric_export_interval = 30000

[exporter]
endpoint = http://otel-collector.observability:4318

[exporter.headers]
authorization = Bearer s3cr3t
x-tenant-id = acme

[resource]
deployment.environment = prod
service.version = 1.4.2
```

### Plugin behavior toggles (`[main]`)

These are plugin-specific (no env equivalent) and live in the same `config/otel.ini` file:

```ini
[main]

; master kill-switch. false = plugin loaded but no hooks registered
+enabled

; include RFC822 Message-Id as smtp.message.id span attribute
+include_message_id

; include HELO/EHLO greeting as smtp.helo span attribute
+include_helo

; include comma-joined recipient domains as smtp.rcpt.domains span attribute
+include_rcpt_domains

; include SPF/DKIM/DMARC results as span attributes
+include_auth_results
```

| Key | Default | Effect when `false` |
|-----|---------|---------------------|
| `main.enabled` | `true` | Plugin loads but registers no hooks and skips SDK init. Restart required to re-enable. |
| `main.include_message_id` | `true` | `smtp.message.id` attribute omitted from `smtp.transaction` span. |
| `main.include_helo` | `true` | `smtp.helo` attribute omitted from `smtp.connection` span. |
| `main.include_rcpt_domains` | `true` | `smtp.rcpt.domains` attribute omitted from `smtp.transaction` span. |
| `main.include_auth_results` | `true` | `smtp.auth.spf` / `smtp.auth.dkim` / `smtp.auth.dmarc` attributes omitted. |

Use the `+key`/`-key` notation to flip defaults. The PII toggles are intended for deployments with strict GDPR/PII boundaries that need to suppress identifiers reaching the trace backend.

### Hot-reload semantics

`config/otel.ini` is hot-reloaded on file change, but the propagation differs by setting:

- **PII flags** (`include_message_id`, `include_helo`, `include_rcpt_domains`, `include_auth_results`) are read **at request time** in the hook handlers. Edits take effect on the next SMTP transaction — no restart needed.
- **`main.enabled`** controls whether hooks are registered at `register()` time. A change requires a Haraka restart to take effect.
- **SDK-level settings** (`[otel]`, `[exporter]`, `[exporter.headers]`, `[resource]`) are consumed only during `sdk.start()`. The `NodeSDK` is built once at plugin init; later changes to these keys require a restart to apply.

### Co-residence with `dd-trace`

> ⚠️ **Do not configure an OTLP endpoint when `dd-trace` is active.** If you do, this plugin will register its own `TracerProvider`/`MeterProvider` globally, **overriding** the one installed by `dd-trace`, and signals will be exported twice (or only via OTLP, depending on init order). For Datadog deployments inject `dd-trace` as usual and leave both `[exporter]` and `OTEL_EXPORTER_OTLP_*` empty — the plugin will detect that no endpoint is configured and defer to the global provider.

## What it emits

### Spans

```
smtp.connection             (connect_init → disconnect)
└── smtp.transaction        (mail → queue_ok | deny)
    └── smtp.queue          (queue → queue_ok | deny)
```

### Span attributes

`messaging.system`, `network.peer.address`, `network.peer.port`, `network.transport`, `smtp.helo.host`, `smtp.tls`, `smtp.tls.protocol`, `smtp.mail.from.domain`, `smtp.rcpt.count`, `smtp.rcpt.domains`, `smtp.message.size`, `smtp.message.id`, `smtp.auth.spf`, `smtp.auth.dkim`, `smtp.auth.dmarc`, `smtp.queue.result`, `smtp.deny.code`, `smtp.deny.hook`.

PII handling: full addresses, subjects, and bodies are **never** recorded. Only domains and message-id are exposed; suppress `smtp.message.id` / `smtp.helo` / `smtp.rcpt.domains` via the `include_*` toggles in `config/otel.ini` if your deployment treats them as sensitive.

### Metrics

| Name | Type | Unit |
|------|------|------|
| `haraka.connections.total` | counter | – |
| `haraka.connections.active` | up-down counter | – |
| `haraka.connection.duration` | histogram | ms |
| `haraka.mail.received` | counter | – |
| `haraka.mail.accepted` | counter | – |
| `haraka.mail.denied` | counter | – |
| `haraka.rcpt.accepted` | counter | – |
| `haraka.rcpt.denied` | counter | – |
| `haraka.queue.success` | counter | – |
| `haraka.queue.failure` | counter | – |
| `haraka.queue.duration` | histogram | ms |
| `haraka.transaction.duration` | histogram | ms |
| `haraka.message.size` | histogram | By |

## Hook map

| Hook | Priority | Action |
|------|----------|--------|
| `init_master` / `init_child` | -100 | – |
| `connect_init` | -110 | Open `smtp.connection` span |
| `connect` | default | TLS attributes |
| `helo` / `ehlo` | default | HELO host attribute |
| `mail` | -90 | Open `smtp.transaction` span |
| `rcpt_ok` | default | Recipient count + counter |
| `data_post` | default | Message size, message-id, mailauth attrs |
| `queue` | -110 | Open `smtp.queue` span |
| `queue_ok` | default | Close queue + transaction (success) |
| `deny` | default | Close queue + transaction (error) |
| `disconnect` | 100 | Close connection span |

## Contributing

Releases are automated via [semantic-release](https://semantic-release.gitbook.io/) on every push to `main` once CI is green. Use [Conventional Commits](https://www.conventionalcommits.org/) for the commit message format — the version bump is derived from the commit type:

| Commit type | Bump |
|---|---|
| `feat:` | minor |
| `fix:` | patch |
| `perf:` | patch |
| `<type>!:` or `BREAKING CHANGE:` in body | major |
| `chore:`, `docs:`, `test:`, `refactor:`, `style:`, `ci:` | no release |

Example:

```
feat(sdk): support OTEL_TRACES_SAMPLER in otel.ini

Adds parsing for the standard sampler env vars and a per-section
override in [otel] traces_sampler / traces_sampler_arg.
```

CI enforces `npm run lint` (Biome), `npm run test:coverage` (tap on Node 22 + 24), and `npm run build` (tsc) — all four jobs (`lint`, `test`, `build`, `release`) must pass.

## License

MIT
