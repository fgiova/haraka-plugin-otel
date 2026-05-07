// biome-ignore-all lint/suspicious/noExplicitAny: test fixtures need `any` to bypass Haraka type ceremony
// Ensure the bundled SDK does not auto-init during tests by stripping any
// inherited OTLP endpoint env vars. The plugin only starts NodeSDK when at
// least one OTLP endpoint is configured.
delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
delete process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
delete process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT;

import { metrics, trace } from "@opentelemetry/api";
import {
	AggregationTemporality,
	InMemoryMetricExporter,
	MeterProvider,
	PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import {
	BasicTracerProvider,
	InMemorySpanExporter,
	SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import tap from "tap";
import {
	createMockConnection,
	createMockNext,
	createMockRcpt,
	createMockSelf,
	createMockTransaction,
} from "../helpers/harakaMocks";

const spanExporter = new InMemorySpanExporter();
const tracerProvider = new BasicTracerProvider({
	spanProcessors: [new SimpleSpanProcessor(spanExporter)],
});
trace.setGlobalTracerProvider(tracerProvider);

const metricExporter = new InMemoryMetricExporter(
	AggregationTemporality.CUMULATIVE,
);
const metricReader = new PeriodicExportingMetricReader({
	exporter: metricExporter,
	exportIntervalMillis: 60_000,
});
const meterProvider = new MeterProvider({ readers: [metricReader] });
metrics.setGlobalMeterProvider(meterProvider);

import { reset as resetMeter } from "../../src/meter";

resetMeter();

import * as plugin from "../../src/index";

const self = createMockSelf();
plugin.register.call(self as never);

async function collectMetrics() {
	await metricReader.forceFlush();
	const data = metricExporter.getMetrics();
	metricExporter.reset();
	const out: Record<
		string,
		Array<{ value: number; attributes: Record<string, unknown> }>
	> = {};
	for (const rm of data) {
		for (const sm of rm.scopeMetrics) {
			for (const m of sm.metrics) {
				out[m.descriptor.name] = m.dataPoints.map((dp) => ({
					value: (dp as { value: number }).value,
					attributes: dp.attributes as Record<string, unknown>,
				}));
			}
		}
	}
	return out;
}

function findSpan(name: string) {
	return spanExporter.getFinishedSpans().find((s) => s.name === name);
}

const parentOf = (s: unknown) =>
	(s as { parentSpanContext?: { spanId: string }; parentSpanId?: string })
		?.parentSpanContext?.spanId ||
	(s as { parentSpanId?: string })?.parentSpanId;

tap.beforeEach(() => {
	spanExporter.reset();
	metricExporter.reset();
});

tap.test("registers all expected hooks", async (t) => {
	const names = self._hooks.map((h) => h.name);
	t.ok(names.includes("connect_init"));
	t.ok(names.includes("mail"));
	t.ok(names.includes("rcpt_ok"));
	t.ok(names.includes("data_post"));
	t.ok(names.includes("queue"));
	t.ok(names.includes("queue_ok"));
	t.ok(names.includes("deny"));
	t.ok(names.includes("disconnect"));
	t.equal(self._hooks.find((h) => h.name === "connect_init")?.priority, -110);
	t.equal(self._hooks.find((h) => h.name === "disconnect")?.priority, 100);
});

tap.test("happy-path emits 3-level span tree + metrics", async (t) => {
	const txn = createMockTransaction();
	(txn as any).data_bytes = 4321;
	(txn as any).header.add("Message-ID", "<abc@example.com>");
	const conn = createMockConnection({
		transaction: txn,
		remote: { ip: "10.0.0.5", port: 12345 },
		using_tls: true,
	});

	plugin.connect_init_otel.call(self as never, createMockNext(), conn as never);
	plugin.connect_otel(createMockNext(), conn as never);
	plugin.helo_otel.call(
		self as never,
		createMockNext(),
		conn as never,
		"client.example.com",
	);

	plugin.mail_otel.call(self as never, createMockNext(), conn as never, [
		{ host: "sender.com", user: "alice" },
	]);

	plugin.rcpt_ok_otel.call(
		self as never,
		createMockNext(),
		conn as never,
		createMockRcpt("bob", "recipient.com"),
	);
	plugin.rcpt_ok_otel.call(
		self as never,
		createMockNext(),
		conn as never,
		createMockRcpt("carol", "recipient.com"),
	);

	(txn.notes as any).mailauth = {
		spf: { status: { result: "pass" } },
		dkim: { results: [{ result: "pass" }] },
		dmarc: { status: { result: "pass" } },
	};

	plugin.data_post_otel.call(self as never, createMockNext(), conn as never);
	plugin.queue_otel(createMockNext(), conn as never);
	plugin.queue_ok_otel.call(self as never, createMockNext(), conn as never);
	plugin.disconnect_otel.call(self as never, createMockNext(), conn as never);

	const connSpan = findSpan("smtp.connection");
	const txnSpan = findSpan("smtp.transaction");
	const queueSpan = findSpan("smtp.queue");
	t.ok(connSpan);
	t.ok(txnSpan);
	t.ok(queueSpan);
	t.equal(parentOf(txnSpan), connSpan?.spanContext().spanId);
	t.equal(parentOf(queueSpan), txnSpan?.spanContext().spanId);

	t.equal(connSpan?.attributes["messaging.system"], "smtp");
	t.equal(connSpan?.attributes["network.peer.address"], "10.0.0.5");
	t.equal(connSpan?.attributes["network.peer.port"], 12345);
	t.equal(connSpan?.attributes["smtp.helo.host"], "client.example.com");
	t.equal(connSpan?.attributes["smtp.tls"], true);

	t.equal(txnSpan?.attributes["smtp.mail.from.domain"], "sender.com");
	t.equal(txnSpan?.attributes["smtp.rcpt.count"], 2);
	t.equal(txnSpan?.attributes["smtp.rcpt.domains"], "recipient.com");
	t.equal(txnSpan?.attributes["smtp.message.size"], 4321);
	t.equal(txnSpan?.attributes["smtp.message.id"], "<abc@example.com>");
	t.equal(txnSpan?.attributes["smtp.auth.spf"], "pass");
	t.equal(txnSpan?.attributes["smtp.auth.dkim"], "pass");
	t.equal(txnSpan?.attributes["smtp.auth.dmarc"], "pass");

	t.equal(queueSpan?.attributes["smtp.queue.result"], "success");

	const m = await collectMetrics();
	t.ok(m["haraka.connections.total"]);
	t.ok(m["haraka.mail.received"]);
	t.ok(m["haraka.mail.accepted"]);
	t.ok(m["haraka.rcpt.accepted"]);
	t.ok(m["haraka.queue.success"]);
	t.equal(m["haraka.rcpt.accepted"][0].value, 2);
	t.ok(m["haraka.connection.duration"]);
	t.ok(m["haraka.transaction.duration"]);
	t.ok(m["haraka.queue.duration"]);
	t.ok(m["haraka.message.size"]);
});

tap.test(
	"deny path: ERROR status + denied counter with code/hook",
	async (t) => {
		const txn = createMockTransaction();
		const conn = createMockConnection({
			transaction: txn,
			remote: { ip: "10.0.0.6", port: 25000 },
		});

		plugin.connect_init_otel.call(
			self as never,
			createMockNext(),
			conn as never,
		);
		plugin.mail_otel.call(self as never, createMockNext(), conn as never, [
			{ host: "spammer.com", user: "x" },
		]);
		plugin.queue_otel(createMockNext(), conn as never);
		plugin.deny_otel.call(self as never, createMockNext(), conn as never, [
			550,
			"Message failed spam checks",
			"plugin",
			"queue",
			[],
			"queue",
		]);
		plugin.disconnect_otel.call(self as never, createMockNext(), conn as never);

		const txnSpan = findSpan("smtp.transaction");
		t.equal(txnSpan?.status.code, 2);
		t.equal(txnSpan?.attributes["smtp.deny.code"], 550);
		t.equal(txnSpan?.attributes["smtp.deny.hook"], "queue");

		const queueSpan = findSpan("smtp.queue");
		t.equal(queueSpan?.attributes["smtp.queue.result"], "failure");

		const m = await collectMetrics();
		t.ok(m["haraka.mail.denied"]);
		t.equal(m["haraka.mail.denied"][0].attributes.code, "550");
		t.equal(m["haraka.mail.denied"][0].attributes.hook, "queue");
		t.ok(m["haraka.queue.failure"]);
	},
);

tap.test("disconnect without queue closes connection span", async (t) => {
	const conn = createMockConnection({
		remote: { ip: "10.0.0.7", port: 25001 },
	});
	plugin.connect_init_otel.call(self as never, createMockNext(), conn as never);
	plugin.disconnect_otel.call(self as never, createMockNext(), conn as never);
	t.ok(findSpan("smtp.connection"));
	t.notOk(findSpan("smtp.transaction"));
});

tap.test(
	"hooks tolerate connection without otel state (early return)",
	async (t) => {
		const bareConn: any = { notes: {} };
		plugin.connect_otel(createMockNext(), bareConn);
		plugin.helo_otel.call(self as never, createMockNext(), bareConn, "x");
		plugin.mail_otel.call(self as never, createMockNext(), bareConn, [
			{ host: "x", user: "y" },
		]);
		plugin.rcpt_ok_otel.call(
			self as never,
			createMockNext(),
			bareConn,
			createMockRcpt("a", "b.io"),
		);
		plugin.data_post_otel.call(self as never, createMockNext(), bareConn);
		plugin.queue_otel(createMockNext(), bareConn);
		plugin.queue_ok_otel.call(self as never, createMockNext(), bareConn);
		plugin.deny_otel.call(self as never, createMockNext(), bareConn, [
			451,
			"x",
			undefined,
			undefined,
			undefined,
			undefined,
		]);
		plugin.disconnect_otel.call(self as never, createMockNext(), bareConn);
		t.pass("all 9 hooks invoked next() safely without otel state");
	},
);

tap.test(
	"connect_init: falls back to connection.remote_ip when remote.ip absent",
	async (t) => {
		const conn = createMockConnection({ remote_ip: "192.168.1.1" });
		plugin.connect_init_otel.call(
			self as never,
			createMockNext(),
			conn as never,
		);
		plugin.disconnect_otel.call(self as never, createMockNext(), conn as never);
		const s = findSpan("smtp.connection");
		t.equal(s?.attributes["network.peer.address"], "192.168.1.1");
	},
);

tap.test("connect_init: no remote info → no peer attrs", async (t) => {
	const conn = createMockConnection();
	plugin.connect_init_otel.call(self as never, createMockNext(), conn as never);
	plugin.disconnect_otel.call(self as never, createMockNext(), conn as never);
	const s = findSpan("smtp.connection");
	t.notOk(s?.attributes["network.peer.address"]);
	t.notOk(s?.attributes["network.peer.port"]);
});

tap.test(
	"connect_otel: TLS with cipher version → tls.protocol attr",
	async (t) => {
		const conn = createMockConnection({
			tls: { enabled: true, cipher: { version: "TLSv1.3" } },
		});
		plugin.connect_init_otel.call(
			self as never,
			createMockNext(),
			conn as never,
		);
		plugin.connect_otel(createMockNext(), conn as never);
		plugin.disconnect_otel.call(self as never, createMockNext(), conn as never);
		const s = findSpan("smtp.connection");
		t.equal(s?.attributes["smtp.tls"], true);
		t.equal(s?.attributes["smtp.tls.protocol"], "TLSv1.3");
	},
);

tap.test("connect_otel: no TLS → smtp.tls = false", async (t) => {
	const conn = createMockConnection({ remote: { ip: "1.2.3.4", port: 25 } });
	plugin.connect_init_otel.call(self as never, createMockNext(), conn as never);
	plugin.connect_otel(createMockNext(), conn as never);
	plugin.disconnect_otel.call(self as never, createMockNext(), conn as never);
	const s = findSpan("smtp.connection");
	t.equal(s?.attributes["smtp.tls"], false);
});

tap.test("helo_otel: missing helo string → no attribute", async (t) => {
	const conn = createMockConnection({ remote: { ip: "1.2.3.4", port: 25 } });
	plugin.connect_init_otel.call(self as never, createMockNext(), conn as never);
	plugin.helo_otel.call(
		self as never,
		createMockNext(),
		conn as never,
		undefined,
	);
	plugin.disconnect_otel.call(self as never, createMockNext(), conn as never);
	const s = findSpan("smtp.connection");
	t.notOk(s?.attributes["smtp.helo.host"]);
});

tap.test("mail_otel: empty params → no fromDomain attr", async (t) => {
	const txn = createMockTransaction();
	const conn = createMockConnection({
		transaction: txn,
		remote: { ip: "1.2.3.4", port: 25 },
	});
	plugin.connect_init_otel.call(self as never, createMockNext(), conn as never);
	plugin.mail_otel.call(self as never, createMockNext(), conn as never, []);
	plugin.disconnect_otel.call(self as never, createMockNext(), conn as never);
	const s = findSpan("smtp.transaction");
	t.notOk(s?.attributes["smtp.mail.from.domain"]);
});

tap.test(
	"mail_otel: no transaction on connection does not throw",
	async (t) => {
		const conn: any = createMockConnection({
			remote: { ip: "1.2.3.4", port: 25 },
		});
		conn.transaction = undefined;
		plugin.connect_init_otel.call(
			self as never,
			createMockNext(),
			conn as never,
		);
		plugin.mail_otel.call(self as never, createMockNext(), conn as never, [
			{ host: "x.io", user: "u" },
		]);
		plugin.disconnect_otel.call(self as never, createMockNext(), conn as never);
		t.pass("did not throw — txn span is opened but orphaned (no txn.notes)");
	},
);

tap.test("rcpt_ok_otel: rcpt without host → no domain harvested", async (t) => {
	const txn = createMockTransaction();
	const conn = createMockConnection({
		transaction: txn,
		remote: { ip: "1.2.3.4", port: 25 },
	});
	plugin.connect_init_otel.call(self as never, createMockNext(), conn as never);
	plugin.mail_otel.call(self as never, createMockNext(), conn as never, [
		{ host: "x.io", user: "u" },
	]);
	plugin.rcpt_ok_otel.call(
		self as never,
		createMockNext(),
		conn as never,
		{
			user: "noHost",
		} as any,
	);
	plugin.data_post_otel.call(self as never, createMockNext(), conn as never);
	plugin.queue_otel(createMockNext(), conn as never);
	plugin.queue_ok_otel.call(self as never, createMockNext(), conn as never);
	plugin.disconnect_otel.call(self as never, createMockNext(), conn as never);
	const s = findSpan("smtp.transaction");
	t.notOk(s?.attributes["smtp.rcpt.domains"]);
	t.equal(s?.attributes["smtp.rcpt.count"], 1);
});

tap.test("data_post_otel: no size info → message.size omitted", async (t) => {
	const txn = createMockTransaction();
	(txn as any).message_stream = undefined;
	const conn = createMockConnection({
		transaction: txn,
		remote: { ip: "1.2.3.4", port: 25 },
	});
	plugin.connect_init_otel.call(self as never, createMockNext(), conn as never);
	plugin.mail_otel.call(self as never, createMockNext(), conn as never, [
		{ host: "x.io", user: "u" },
	]);
	plugin.data_post_otel.call(self as never, createMockNext(), conn as never);
	plugin.queue_otel(createMockNext(), conn as never);
	plugin.queue_ok_otel.call(self as never, createMockNext(), conn as never);
	plugin.disconnect_otel.call(self as never, createMockNext(), conn as never);
	const s = findSpan("smtp.transaction");
	t.notOk(s?.attributes["smtp.message.size"]);
});

tap.test(
	"data_post_otel: bytes_read fallback when data_bytes absent",
	async (t) => {
		const txn = createMockTransaction();
		(txn as any).message_stream.bytes_read = 999;
		const conn = createMockConnection({
			transaction: txn,
			remote: { ip: "1.2.3.4", port: 25 },
		});
		plugin.connect_init_otel.call(
			self as never,
			createMockNext(),
			conn as never,
		);
		plugin.mail_otel.call(self as never, createMockNext(), conn as never, [
			{ host: "x.io", user: "u" },
		]);
		plugin.data_post_otel.call(self as never, createMockNext(), conn as never);
		plugin.queue_otel(createMockNext(), conn as never);
		plugin.queue_ok_otel.call(self as never, createMockNext(), conn as never);
		plugin.disconnect_otel.call(self as never, createMockNext(), conn as never);
		const s = findSpan("smtp.transaction");
		t.equal(s?.attributes["smtp.message.size"], 999);
	},
);

tap.test(
	"data_post_otel: dkim no pass falls back to first result",
	async (t) => {
		const txn = createMockTransaction();
		(txn.notes as any).mailauth = {
			dkim: { results: [{ result: "fail" }, { result: "neutral" }] },
		};
		const conn = createMockConnection({
			transaction: txn,
			remote: { ip: "1.2.3.4", port: 25 },
		});
		plugin.connect_init_otel.call(
			self as never,
			createMockNext(),
			conn as never,
		);
		plugin.mail_otel.call(self as never, createMockNext(), conn as never, [
			{ host: "x.io", user: "u" },
		]);
		plugin.data_post_otel.call(self as never, createMockNext(), conn as never);
		plugin.queue_otel(createMockNext(), conn as never);
		plugin.queue_ok_otel.call(self as never, createMockNext(), conn as never);
		plugin.disconnect_otel.call(self as never, createMockNext(), conn as never);
		const s = findSpan("smtp.transaction");
		t.equal(s?.attributes["smtp.auth.dkim"], "fail");
	},
);

tap.test(
	"deny_otel: hook != queue → no hook tag on queueFailure",
	async (t) => {
		const txn = createMockTransaction();
		const conn = createMockConnection({
			transaction: txn,
			remote: { ip: "1.2.3.4", port: 25 },
		});
		plugin.connect_init_otel.call(
			self as never,
			createMockNext(),
			conn as never,
		);
		plugin.mail_otel.call(self as never, createMockNext(), conn as never, [
			{ host: "x.io", user: "u" },
		]);
		plugin.queue_otel(createMockNext(), conn as never);
		plugin.deny_otel.call(self as never, createMockNext(), conn as never, [
			550,
			"bad",
			undefined,
			undefined,
			undefined,
			"data",
		]);
		plugin.disconnect_otel.call(self as never, createMockNext(), conn as never);
		const m = await collectMetrics();
		const dp = m["haraka.queue.failure"]?.find(
			(d) => Object.keys(d.attributes).length === 0,
		);
		t.ok(dp, "queue.failure datapoint with no hook tag exists");
	},
);

tap.test(
	"deny_otel: missing msg → 'denied' default on connection span",
	async (t) => {
		const conn = createMockConnection({ remote: { ip: "1.2.3.4", port: 25 } });
		plugin.connect_init_otel.call(
			self as never,
			createMockNext(),
			conn as never,
		);
		plugin.deny_otel.call(self as never, createMockNext(), conn as never, [
			421,
			undefined,
			undefined,
			undefined,
			undefined,
			"connect",
		]);
		plugin.disconnect_otel.call(self as never, createMockNext(), conn as never);
		const s = findSpan("smtp.connection");
		t.equal(s?.status.message, "denied");
	},
);

tap.test("disconnect_otel: idempotent on second call", async (t) => {
	const conn = createMockConnection({ remote: { ip: "1.2.3.4", port: 25 } });
	plugin.connect_init_otel.call(self as never, createMockNext(), conn as never);
	plugin.disconnect_otel.call(self as never, createMockNext(), conn as never);
	const before = spanExporter.getFinishedSpans().length;
	plugin.disconnect_otel.call(self as never, createMockNext(), conn as never);
	t.equal(spanExporter.getFinishedSpans().length, before);
});

tap.test(
	"init_master_otel and init_child_otel call next without args",
	async (t) => {
		const n1 = createMockNext();
		plugin.init_master_otel(n1);
		t.same(n1.args, []);

		const n2 = createMockNext();
		plugin.init_child_otel(n2);
		t.same(n2.args, []);
	},
);

tap.test(
	"deny without active transaction increments rcpt.denied",
	async (t) => {
		const conn = createMockConnection({ remote: { ip: "10.0.0.9", port: 25 } });
		plugin.connect_init_otel.call(
			self as never,
			createMockNext(),
			conn as never,
		);
		plugin.deny_otel.call(self as never, createMockNext(), conn as never, [
			550,
			"bad rcpt",
			undefined,
			undefined,
			undefined,
			"rcpt",
		]);
		const m = await collectMetrics();
		t.ok(m["haraka.rcpt.denied"]);
		const dp = m["haraka.rcpt.denied"].find(
			(d) => d.attributes.hook === "rcpt",
		);
		t.ok(dp, "rcpt.denied datapoint with hook=rcpt exists");
		const connSpan = findSpan("smtp.connection") as never;
		t.notOk(connSpan, "connection span still open until disconnect");
	},
);

tap.test(
	"disconnect with active transaction force-closes txn + queue spans",
	async (t) => {
		const txn = createMockTransaction();
		const conn = createMockConnection({
			transaction: txn,
			remote: { ip: "10.0.0.10", port: 25 },
		});
		plugin.connect_init_otel.call(
			self as never,
			createMockNext(),
			conn as never,
		);
		plugin.mail_otel.call(self as never, createMockNext(), conn as never, [
			{ host: "x.io", user: "u" },
		]);
		plugin.queue_otel(createMockNext(), conn as never);
		// Skip queue_ok / deny — disconnect must close everything itself.
		plugin.disconnect_otel.call(self as never, createMockNext(), conn as never);

		t.ok(findSpan("smtp.queue"), "queue span force-closed on disconnect");
		t.ok(
			findSpan("smtp.transaction"),
			"transaction span force-closed on disconnect",
		);
		t.ok(findSpan("smtp.connection"), "connection span closed on disconnect");
	},
);

tap.test("plugin shutdown logs and forwards to sdk.shutdown", async (t) => {
	const logs: Array<{ level: string; msg: string }> = [];
	const selfWithLog: any = {
		...self,
		log: {
			info: (m: string) => logs.push({ level: "info", msg: m }),
			warn: (m: string) => logs.push({ level: "warn", msg: m }),
			error: (m: string) => logs.push({ level: "error", msg: m }),
			debug: (m: string) => logs.push({ level: "debug", msg: m }),
		},
	};
	await plugin.shutdown.call(selfWithLog);
	t.ok(logs.find((l) => /Shutting down/.test(l.msg)));
});

tap.test("register: enabled=false skips all hook registration", async (t) => {
	const localHooks: Array<{ name: string }> = [];
	const localSelf: any = {
		_hooks: localHooks,
		logdebug: () => {},
		loginfo: () => {},
		logwarn: () => {},
		logerror: () => {},
		register_hook(name: string) {
			localHooks.push({ name });
		},
		config: {
			get: () => ({
				main: {
					enabled: false,
					include_message_id: true,
					include_helo: true,
					include_rcpt_domains: true,
					include_auth_results: true,
				},
			}),
		},
	};
	plugin.register.call(localSelf);
	t.equal(localHooks.length, 0, "no hooks registered when enabled=false");
});

tap.teardown(async () => {
	await tracerProvider.shutdown();
	await meterProvider.shutdown();
});
