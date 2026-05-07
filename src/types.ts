import type { Context, Span } from "@opentelemetry/api";

export interface OTelLogger {
	debug?: (m: string) => void;
	info?: (m: string) => void;
	warn?: (m: string) => void;
	error?: (m: string) => void;
}

export interface ConnectionOTelState {
	connectionSpan: Span;
	connectionCtx: Context;
	startTime: number;
	denied: boolean;
	ended: boolean;
}

export interface TransactionOTelState {
	txnSpan: Span;
	txnCtx: Context;
	startTime: number;
	rcptCount: number;
	rcptDomains: Set<string>;
	fromDomain: string | undefined;
	ended: boolean;
	queueSpan: Span | null;
	queueCtx?: Context;
	queueStart: number | null;
}

export interface HarakaAddress {
	host?: string;
	user?: string;
}

export interface HarakaConnection {
	remote?: { ip?: string; port?: number };
	remote_ip?: string;
	tls?: { enabled?: boolean; cipher?: { version?: string } };
	using_tls?: boolean;
	transaction?: HarakaTransaction;
	notes?: Record<string, unknown> & { otel?: ConnectionOTelState };
}

export interface HarakaTransaction {
	data_bytes?: number;
	message_stream?: { bytes_read?: number; total_bytes?: number };
	header?: { get(name: string): string | undefined };
	notes?: Record<string, unknown> & {
		otel?: TransactionOTelState;
		mailauth?: {
			spf?: { status?: { result?: string } };
			dkim?: { results?: Array<{ result?: string }> };
			dmarc?: { status?: { result?: string } };
		};
	};
}

export type NextFn = (...args: unknown[]) => void;

export interface OTelPluginConfig {
	main: {
		enabled: boolean;
		include_message_id: boolean;
		include_helo: boolean;
		include_rcpt_domains: boolean;
		include_auth_results: boolean;
	};
	otel?: {
		service_name?: string;
		traces_sampler?: string;
		traces_sampler_arg?: string;
		metrics_exporter?: string;
		metric_export_interval?: string;
	};
	exporter?: {
		endpoint?: string;
		traces_endpoint?: string;
		metrics_endpoint?: string;
	};
	"exporter.headers"?: Record<string, string>;
	resource?: Record<string, string>;
}

export interface HarakaConfigGetOpts {
	booleans?: string[];
}

export interface HarakaConfigApi {
	get(
		name: string,
		opts: HarakaConfigGetOpts,
		callback?: () => void,
	): OTelPluginConfig;
	get(name: string, callback?: () => void): OTelPluginConfig;
}

export interface HarakaPluginInstance {
	logdebug(m: string): void;
	loginfo(m: string): void;
	logwarn(m: string): void;
	logerror(m: string): void;
	register_hook(name: string, method: string, priority?: number): void;
	config?: HarakaConfigApi;
	cfg?: OTelPluginConfig;
	log?: OTelLogger;
	metrics?: ReturnType<typeof import("./meter").get>;
}
