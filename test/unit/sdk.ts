// Strip any inherited OTLP env so start() defaults to skip when cfg is empty.
delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
delete process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
delete process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT;
delete process.env.OTEL_EXPORTER_OTLP_HEADERS;
delete process.env.OTEL_RESOURCE_ATTRIBUTES;
delete process.env.OTEL_SERVICE_NAME;
delete process.env.OTEL_TRACES_SAMPLER;
delete process.env.OTEL_TRACES_SAMPLER_ARG;
delete process.env.OTEL_METRICS_EXPORTER;
delete process.env.OTEL_METRIC_EXPORT_INTERVAL;

import {
	AlwaysOffSampler,
	AlwaysOnSampler,
	ParentBasedSampler,
	TraceIdRatioBasedSampler,
} from "@opentelemetry/sdk-trace-base";
import tap from "tap";
import {
	buildSampler,
	joinEndpoint,
	mergeKv,
	nonEmpty,
	parseKvString,
	pickCfgEnv,
	start,
} from "../../src/sdk";

tap.test("nonEmpty", async (t) => {
	t.equal(nonEmpty(undefined), undefined);
	t.equal(nonEmpty(""), undefined);
	t.equal(nonEmpty("   "), undefined);
	t.equal(nonEmpty("x"), "x");
	t.equal(nonEmpty("  hello  "), "hello");
});

tap.test("pickCfgEnv: cfg wins over env", async (t) => {
	process.env._TEST_PICK = "from-env";
	t.equal(pickCfgEnv("from-cfg", "_TEST_PICK"), "from-cfg");
	delete process.env._TEST_PICK;
});

tap.test("pickCfgEnv: empty cfg falls back to env", async (t) => {
	process.env._TEST_PICK = "from-env";
	t.equal(pickCfgEnv(undefined, "_TEST_PICK"), "from-env");
	t.equal(pickCfgEnv("", "_TEST_PICK"), "from-env");
	t.equal(pickCfgEnv("   ", "_TEST_PICK"), "from-env");
	delete process.env._TEST_PICK;
});

tap.test("pickCfgEnv: both empty returns undefined", async (t) => {
	delete process.env._TEST_PICK;
	t.equal(pickCfgEnv(undefined, "_TEST_PICK"), undefined);
	t.equal(pickCfgEnv("", "_TEST_PICK"), undefined);
});

tap.test(
	"joinEndpoint: appends suffix and strips trailing slashes",
	async (t) => {
		t.equal(
			joinEndpoint("http://x:4318", "/v1/traces"),
			"http://x:4318/v1/traces",
		);
		t.equal(
			joinEndpoint("http://x:4318/", "/v1/traces"),
			"http://x:4318/v1/traces",
		);
		t.equal(
			joinEndpoint("http://x:4318///", "/v1/metrics"),
			"http://x:4318/v1/metrics",
		);
	},
);

tap.test("parseKvString: empty/undefined → empty object", async (t) => {
	t.same(parseKvString(undefined), {});
	t.same(parseKvString(""), {});
});

tap.test("parseKvString: parses standard k=v,k2=v2", async (t) => {
	t.same(parseKvString("a=1,b=2"), { a: "1", b: "2" });
});

tap.test(
	"parseKvString: trims whitespace around keys and values",
	async (t) => {
		t.same(parseKvString(" a = 1 , b = hello world "), {
			a: "1",
			b: "hello world",
		});
	},
);

tap.test("parseKvString: skips malformed pairs", async (t) => {
	t.same(parseKvString("a=1,nokey,=novalue,b=2"), { a: "1", b: "2" });
});

tap.test("parseKvString: keeps = inside value (auth token)", async (t) => {
	t.same(parseKvString("authorization=Bearer abc=def"), {
		authorization: "Bearer abc=def",
	});
});

tap.test("mergeKv: cfg wins per-key, env preserved otherwise", async (t) => {
	const cfg = { authorization: "Bearer cfg", "x-tenant": "acme" };
	const env = "authorization=Bearer env,x-region=eu-west-1";
	t.same(mergeKv(cfg, env), {
		authorization: "Bearer cfg",
		"x-tenant": "acme",
		"x-region": "eu-west-1",
	});
});

tap.test("mergeKv: cfg only", async (t) => {
	t.same(mergeKv({ a: "1" }, undefined), { a: "1" });
});

tap.test("mergeKv: env only", async (t) => {
	t.same(mergeKv(undefined, "a=1,b=2"), { a: "1", b: "2" });
});

tap.test("mergeKv: both empty", async (t) => {
	t.same(mergeKv(undefined, undefined), {});
});

tap.test("buildSampler: always_on / always_off", async (t) => {
	t.ok(buildSampler("always_on", undefined) instanceof AlwaysOnSampler);
	t.ok(buildSampler("always_off", undefined) instanceof AlwaysOffSampler);
});

tap.test("buildSampler: traceidratio uses arg", async (t) => {
	const s = buildSampler("traceidratio", "0.25") as TraceIdRatioBasedSampler & {
		_ratio?: number;
	};
	t.ok(s instanceof TraceIdRatioBasedSampler);
	t.equal(s._ratio, 0.25);
});

tap.test("buildSampler: traceidratio missing arg defaults to 1", async (t) => {
	const s = buildSampler(
		"traceidratio",
		undefined,
	) as TraceIdRatioBasedSampler & { _ratio?: number };
	t.ok(s instanceof TraceIdRatioBasedSampler);
	t.equal(s._ratio, 1);
});

tap.test("buildSampler: parentbased_* wraps inner sampler", async (t) => {
	t.ok(
		buildSampler("parentbased_always_on", undefined) instanceof
			ParentBasedSampler,
	);
	t.ok(
		buildSampler("parentbased_always_off", undefined) instanceof
			ParentBasedSampler,
	);
	t.ok(
		buildSampler("parentbased_traceidratio", "0.5") instanceof
			ParentBasedSampler,
	);
});

tap.test("buildSampler: unknown name → undefined", async (t) => {
	t.equal(buildSampler("totally_made_up", undefined), undefined);
	t.equal(buildSampler("", undefined), undefined);
});

tap.test("start(): no endpoint configured → skip + idempotent", async (t) => {
	const logs: Array<{ level: string; msg: string }> = [];
	const log = {
		info: (m: string) => logs.push({ level: "info", msg: m }),
		warn: (m: string) => logs.push({ level: "warn", msg: m }),
		error: (m: string) => logs.push({ level: "error", msg: m }),
	};
	start(log);
	start(log); // second call must be a no-op
	t.equal(logs.length, 1, "logged exactly once across two calls");
	t.match(logs[0].msg, /no OTLP endpoint/);
});
