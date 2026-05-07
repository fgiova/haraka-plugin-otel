// Isolated test file: tap forks per file, so the module-level `started`
// flag in src/sdk.ts is fresh here. Cannot share a process with sdk.test.ts.

delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
delete process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
delete process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT;
delete process.env.OTEL_EXPORTER_OTLP_HEADERS;
delete process.env.OTEL_RESOURCE_ATTRIBUTES;
delete process.env.OTEL_SERVICE_NAME;
delete process.env.OTEL_TRACES_SAMPLER;
delete process.env.OTEL_METRICS_EXPORTER;
delete process.env.OTEL_METRIC_EXPORT_INTERVAL;

import tap from "tap";
import * as sdkMod from "../../src/sdk";

tap.test(
	"getTracer / getMeter: return proxies even before start()",
	async (t) => {
		const tr = sdkMod.getTracer("test-tracer");
		const me = sdkMod.getMeter("test-meter");
		t.type(tr.startSpan, "function");
		t.type(me.createCounter, "function");
	},
);

tap.test("shutdown() before start: no-op", async (t) => {
	await sdkMod.shutdown();
	t.pass("did not throw");
});

tap.test(
	"start() with cfg endpoint + unknown sampler logs warn + initializes SDK",
	async (t) => {
		const logs: Array<{ level: string; msg: string }> = [];
		const log = {
			info: (m: string) => logs.push({ level: "info", msg: m }),
			warn: (m: string) => logs.push({ level: "warn", msg: m }),
			error: (m: string) => logs.push({ level: "error", msg: m }),
		};

		sdkMod.start(log, {
			main: {
				enabled: true,
				include_message_id: true,
				include_helo: true,
				include_rcpt_domains: true,
				include_auth_results: true,
			},
			otel: {
				service_name: "test-svc",
				traces_sampler: "totally_made_up",
				metric_export_interval: "120000",
			},
			exporter: {
				endpoint: "http://127.0.0.1:1",
			},
			"exporter.headers": {
				authorization: "Bearer test",
			},
			resource: {
				"deployment.environment": "test",
			},
		});

		t.ok(
			logs.find(
				(l) => l.level === "warn" && /unknown traces_sampler/.test(l.msg),
			),
			"warns on unknown sampler name",
		);
		t.ok(
			logs.find(
				(l) =>
					l.level === "info" &&
					/SDK started/.test(l.msg) &&
					/v1\/traces/.test(l.msg) &&
					/v1\/metrics/.test(l.msg),
			),
			"logs started with derived endpoint paths",
		);

		// Idempotency: second call must not log again.
		const before = logs.length;
		sdkMod.start(log);
		t.equal(logs.length, before, "second start() is a no-op");

		// Cleanup: shut down the real NodeSDK we just started so timers/connections
		// don't keep the test process alive.
		await sdkMod.shutdown(log);
		t.ok(
			logs.find((l) => l.level === "info" && /shutdown complete/.test(l.msg)),
			"shutdown logged",
		);
	},
);
