import { metrics, trace } from "@opentelemetry/api";
import type { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import type { Resource } from "@opentelemetry/resources";
import type { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import type { NodeSDK } from "@opentelemetry/sdk-node";
import type { Sampler } from "@opentelemetry/sdk-trace-base";
import type { OTelLogger, OTelPluginConfig } from "./types";

type NodeSDKCtor = typeof import("@opentelemetry/sdk-node").NodeSDK;
type OTLPTraceExporterCtor =
	typeof import("@opentelemetry/exporter-trace-otlp-http").OTLPTraceExporter;
type OTLPMetricExporterCtor =
	typeof import("@opentelemetry/exporter-metrics-otlp-http").OTLPMetricExporter;
type PeriodicExportingMetricReaderCtor =
	typeof import("@opentelemetry/sdk-metrics").PeriodicExportingMetricReader;
type ResourcesModule = typeof import("@opentelemetry/resources");
type SemconvModule = typeof import("@opentelemetry/semantic-conventions");

let sdkInstance: NodeSDK | null = null;
let started = false;

export function nonEmpty(v: string | undefined): string | undefined {
	if (v === undefined || v === null) return undefined;
	const s = String(v).trim();
	return s.length === 0 ? undefined : s;
}

export function pickCfgEnv(
	cfgVal: string | undefined,
	envName: string,
): string | undefined {
	return nonEmpty(cfgVal) ?? nonEmpty(process.env[envName]);
}

export function joinEndpoint(base: string, suffix: string): string {
	return `${base.replace(/\/+$/, "")}${suffix}`;
}

export function parseKvString(raw: string | undefined): Record<string, string> {
	const out: Record<string, string> = {};
	if (!raw) return out;
	for (const pair of raw.split(",")) {
		const eq = pair.indexOf("=");
		if (eq <= 0) continue;
		const k = pair.slice(0, eq).trim();
		const v = pair.slice(eq + 1).trim();
		if (k) out[k] = v;
	}
	return out;
}

export function mergeKv(
	cfg: Record<string, string> | undefined,
	envRaw: string | undefined,
): Record<string, string> {
	return { ...parseKvString(envRaw), ...(cfg || {}) };
}

export function buildSampler(name: string, arg: string | undefined): unknown {
	let base: typeof import("@opentelemetry/sdk-trace-base");
	try {
		base = require("@opentelemetry/sdk-trace-base");
		/* c8 ignore next 3 -- optional dep unavailable at runtime; not exercised in tests */
	} catch {
		return undefined;
	}
	const ratio = Number.isFinite(Number(arg)) ? Number(arg) : 1;
	switch (name) {
		case "always_on":
			return new base.AlwaysOnSampler();
		case "always_off":
			return new base.AlwaysOffSampler();
		case "traceidratio":
			return new base.TraceIdRatioBasedSampler(ratio);
		case "parentbased_always_on":
			return new base.ParentBasedSampler({ root: new base.AlwaysOnSampler() });
		case "parentbased_always_off":
			return new base.ParentBasedSampler({ root: new base.AlwaysOffSampler() });
		case "parentbased_traceidratio":
			return new base.ParentBasedSampler({
				root: new base.TraceIdRatioBasedSampler(ratio),
			});
		default:
			return undefined;
	}
}

export function start(log?: OTelLogger, cfg?: OTelPluginConfig): void {
	if (started) return;
	started = true;

	const otelCfg = cfg?.otel || {};
	const expCfg = cfg?.exporter || {};
	const headersCfg = cfg?.["exporter.headers"];
	const resourceCfg = cfg?.resource;

	const baseEndpoint = pickCfgEnv(
		expCfg.endpoint,
		"OTEL_EXPORTER_OTLP_ENDPOINT",
	);
	const tracesEndpointRaw = pickCfgEnv(
		expCfg.traces_endpoint,
		"OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
	);
	const metricsEndpointRaw = pickCfgEnv(
		expCfg.metrics_endpoint,
		"OTEL_EXPORTER_OTLP_METRICS_ENDPOINT",
	);

	const tracesUrl =
		tracesEndpointRaw ||
		(baseEndpoint ? joinEndpoint(baseEndpoint, "/v1/traces") : undefined);

	const metricsExporterMode = pickCfgEnv(
		otelCfg.metrics_exporter,
		"OTEL_METRICS_EXPORTER",
	);
	const metricsDisabled = metricsExporterMode === "none";
	const metricsUrl = metricsDisabled
		? undefined
		: metricsEndpointRaw ||
			(baseEndpoint ? joinEndpoint(baseEndpoint, "/v1/metrics") : undefined);

	if (!tracesUrl && !metricsUrl) {
		log?.info?.(
			"OTel SDK init skipped: no OTLP endpoint configured (cfg or env). " +
				"Spans/metrics will route to the globally configured provider (e.g. dd-trace) or be dropped.",
		);
		return;
	}

	let NodeSDKClass: NodeSDKCtor;
	let OTLPTraceExporterClass: OTLPTraceExporterCtor;
	let OTLPMetricExporterClass: OTLPMetricExporterCtor;
	let PeriodicExportingMetricReaderClass: PeriodicExportingMetricReaderCtor;
	let resourcesMod: ResourcesModule;
	let semconv: SemconvModule;
	try {
		NodeSDKClass = require("@opentelemetry/sdk-node").NodeSDK;
		OTLPTraceExporterClass =
			require("@opentelemetry/exporter-trace-otlp-http").OTLPTraceExporter;
		OTLPMetricExporterClass =
			require("@opentelemetry/exporter-metrics-otlp-http").OTLPMetricExporter;
		PeriodicExportingMetricReaderClass =
			require("@opentelemetry/sdk-metrics").PeriodicExportingMetricReader;
		resourcesMod = require("@opentelemetry/resources");
		semconv = require("@opentelemetry/semantic-conventions");
		/* c8 ignore next 6 -- API-only mode (optional deps absent); requires fixture without deps */
	} catch (err) {
		log?.warn?.(
			`OTel SDK optional deps not installed; skipping built-in SDK init: ${(err as Error).message}`,
		);
		return;
	}

	const headers = mergeKv(headersCfg, process.env.OTEL_EXPORTER_OTLP_HEADERS);
	const resourceAttrs = {
		[semconv.ATTR_SERVICE_NAME]:
			pickCfgEnv(otelCfg.service_name, "OTEL_SERVICE_NAME") || "haraka",
		...mergeKv(resourceCfg, process.env.OTEL_RESOURCE_ATTRIBUTES),
	};
	// resourceFromAttributes is the 2.x API; 1.30.x ships only the Resource class.
	const resourcesModWithFactory = resourcesMod as typeof resourcesMod & {
		resourceFromAttributes?: (attrs: typeof resourceAttrs) => Resource;
	};
	const resource: Resource = resourcesModWithFactory.resourceFromAttributes
		? resourcesModWithFactory.resourceFromAttributes(resourceAttrs)
		: new resourcesMod.Resource(resourceAttrs);

	const traceExporter: OTLPTraceExporter | undefined = tracesUrl
		? new OTLPTraceExporterClass({
				url: tracesUrl,
				...(Object.keys(headers).length > 0 ? { headers } : {}),
			})
		: undefined;

	const exportIntervalMillis = Number(
		pickCfgEnv(otelCfg.metric_export_interval, "OTEL_METRIC_EXPORT_INTERVAL") ||
			60000,
	);
	const metricReader: PeriodicExportingMetricReader | undefined = metricsUrl
		? new PeriodicExportingMetricReaderClass({
				exporter: new OTLPMetricExporterClass({
					url: metricsUrl,
					...(Object.keys(headers).length > 0 ? { headers } : {}),
				}),
				exportIntervalMillis,
			})
		: undefined;

	const samplerName = pickCfgEnv(otelCfg.traces_sampler, "OTEL_TRACES_SAMPLER");
	const samplerArg = pickCfgEnv(
		otelCfg.traces_sampler_arg,
		"OTEL_TRACES_SAMPLER_ARG",
	);
	const sampler = samplerName
		? (buildSampler(samplerName, samplerArg) as Sampler | undefined)
		: undefined;
	if (samplerName && !sampler) {
		log?.warn?.(
			`OTel: unknown traces_sampler "${samplerName}"; using default.`,
		);
	}

	sdkInstance = new NodeSDKClass({
		resource,
		traceExporter,
		metricReader,
		...(sampler ? { sampler } : {}),
		instrumentations: [],
	});

	sdkInstance.start();
	log?.info?.(
		`OTel SDK started (traces: ${tracesUrl ? tracesUrl : "off"}, metrics: ${metricsUrl ? metricsUrl : "off"}).`,
	);
}

export async function shutdown(log?: OTelLogger): Promise<void> {
	if (!sdkInstance) return;
	try {
		await sdkInstance.shutdown();
		log?.info?.("OTel SDK shutdown complete.");
		/* c8 ignore next 3 -- NodeSDK.shutdown() throw path; requires mock to exercise */
	} catch (err) {
		log?.error?.(`OTel SDK shutdown error: ${(err as Error).message}`);
	} finally {
		sdkInstance = null;
	}
}

export function getTracer(name: string) {
	return trace.getTracer(name);
}

export function getMeter(name: string) {
	return metrics.getMeter(name);
}
