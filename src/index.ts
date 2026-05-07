import { ATTR, safeDomainFromAddress } from "./attributes";
import { get as getInstruments, type Instruments } from "./meter";
import * as sdk from "./sdk";
import { endSpan, setAttrs, setError, startSpan } from "./tracer";
import type {
	HarakaAddress,
	HarakaConnection,
	HarakaPluginInstance,
	NextFn,
	OTelLogger,
	OTelPluginConfig,
	TransactionOTelState,
} from "./types";

const DEFAULT_CFG: OTelPluginConfig = {
	main: {
		enabled: true,
		include_message_id: true,
		include_helo: true,
		include_rcpt_domains: true,
		include_auth_results: true,
	},
};

const CFG_BOOLEANS = [
	"+main.enabled",
	"+main.include_message_id",
	"+main.include_helo",
	"+main.include_rcpt_domains",
	"+main.include_auth_results",
];

function buildLog(self: HarakaPluginInstance): OTelLogger {
	return {
		debug: (m: string) => self.logdebug(`${m}`),
		warn: (m: string) => self.logwarn(`${m}`),
		info: (m: string) => self.loginfo(`${m}`),
		error: (m: string) => self.logerror(`${m}`),
	};
}

export function load_otel_cfg(this: HarakaPluginInstance) {
	if (this.config?.get) {
		this.cfg = this.config.get("otel.ini", { booleans: CFG_BOOLEANS }, () =>
			load_otel_cfg.call(this),
		);
	}
	this.cfg = this.cfg || DEFAULT_CFG;
	this.cfg.main = { ...DEFAULT_CFG.main, ...(this.cfg.main || {}) };
}

export function register(this: HarakaPluginInstance) {
	this.log = buildLog(this);

	load_otel_cfg.call(this);

	if (!this.cfg?.main.enabled) {
		this.log.info?.("OTel plugin disabled via config (main.enabled=false)");
		return;
	}

	this.log.info?.("Initializing OTel plugin");

	try {
		sdk.start(this.log, this.cfg);
		/* c8 ignore next 3 -- defensive guard; sdk.start() does not throw on documented paths */
	} catch (err) {
		this.log.error?.(`OTel SDK start error: ${(err as Error).message}`);
	}

	this.metrics = getInstruments();

	this.register_hook("init_master", "init_master_otel", -100);
	this.register_hook("init_child", "init_child_otel", -100);
	this.register_hook("connect_init", "connect_init_otel", -110);
	this.register_hook("connect", "connect_otel");
	this.register_hook("helo", "helo_otel");
	this.register_hook("ehlo", "helo_otel");
	this.register_hook("mail", "mail_otel", -90);
	this.register_hook("rcpt_ok", "rcpt_ok_otel");
	this.register_hook("data_post", "data_post_otel");
	this.register_hook("queue", "queue_otel", -110);
	this.register_hook("queue_ok", "queue_ok_otel");
	this.register_hook("deny", "deny_otel");
	this.register_hook("disconnect", "disconnect_otel", 100);
}

export function init_master_otel(next: NextFn) {
	next();
}

export function init_child_otel(next: NextFn) {
	next();
}

export function connect_init_otel(
	this: HarakaPluginInstance,
	next: NextFn,
	connection: HarakaConnection,
) {
	const startTime = Date.now();
	const remoteIp = connection?.remote?.ip || connection?.remote_ip;
	const remotePort = connection?.remote?.port;

	const { span, ctx } = startSpan("smtp.connection", {
		attributes: {
			[ATTR.MESSAGING_SYSTEM]: "smtp",
			[ATTR.NET_TRANSPORT]: "tcp",
			...(remoteIp ? { [ATTR.NET_PEER_ADDR]: remoteIp } : {}),
			...(remotePort ? { [ATTR.NET_PEER_PORT]: remotePort } : {}),
		},
	});

	connection.notes = connection.notes || {};
	connection.notes.otel = {
		connectionSpan: span,
		connectionCtx: ctx,
		startTime,
		denied: false,
		ended: false,
	};

	const m = this.metrics as Instruments;
	m.connectionsTotal.add(1);
	m.connectionsActive.add(1);
	next();
}

export function connect_otel(next: NextFn, connection: HarakaConnection) {
	const otel = connection?.notes?.otel;
	if (!otel) return next();

	const tls = !!connection?.tls?.enabled || !!connection?.using_tls;
	setAttrs(otel.connectionSpan, {
		[ATTR.SMTP_TLS]: tls,
		...(connection?.tls?.cipher?.version
			? { [ATTR.SMTP_TLS_PROTO]: connection.tls.cipher.version }
			: {}),
	});
	next();
}

export function helo_otel(
	this: HarakaPluginInstance,
	next: NextFn,
	connection: HarakaConnection,
	helo?: string,
) {
	const otel = connection?.notes?.otel;
	if (otel && helo && this.cfg?.main.include_helo) {
		setAttrs(otel.connectionSpan, { [ATTR.SMTP_HELO]: helo });
	}
	next();
}

export function mail_otel(
	this: HarakaPluginInstance,
	next: NextFn,
	connection: HarakaConnection,
	params: HarakaAddress[],
) {
	const otel = connection?.notes?.otel;
	if (!otel) return next();

	const from = params?.[0];
	const fromDomain = safeDomainFromAddress(from);
	const startTime = Date.now();

	const { span, ctx } = startSpan("smtp.transaction", {
		parentCtx: otel.connectionCtx,
		attributes: {
			[ATTR.MESSAGING_SYSTEM]: "smtp",
			...(fromDomain ? { [ATTR.SMTP_MAIL_FROM_DOMAIN]: fromDomain } : {}),
		},
	});

	const txn = connection.transaction;
	if (txn) {
		txn.notes = txn.notes || {};
		txn.notes.otel = {
			txnSpan: span,
			txnCtx: ctx,
			startTime,
			rcptCount: 0,
			rcptDomains: new Set<string>(),
			fromDomain,
			ended: false,
			queueSpan: null,
			queueStart: null,
		};
	}

	(this.metrics as Instruments).mailReceived.add(1, {
		...(fromDomain ? { domain: fromDomain } : {}),
	});
	next();
}

export function rcpt_ok_otel(
	this: HarakaPluginInstance,
	next: NextFn,
	connection: HarakaConnection,
	rcpt: HarakaAddress,
) {
	const txnOtel = connection?.transaction?.notes?.otel;
	if (txnOtel) {
		txnOtel.rcptCount += 1;
		const d = rcpt?.host ? String(rcpt.host).toLowerCase() : undefined;
		if (d) txnOtel.rcptDomains.add(d);
	}
	(this.metrics as Instruments).rcptAccepted.add(1);
	next();
}

export function data_post_otel(
	this: HarakaPluginInstance,
	next: NextFn,
	connection: HarakaConnection,
) {
	const txn = connection?.transaction;
	const txnOtel = txn?.notes?.otel;
	if (!txnOtel) return next();

	const cfg = this.cfg?.main;
	const size =
		txn?.data_bytes ||
		txn?.message_stream?.bytes_read ||
		txn?.message_stream?.total_bytes ||
		undefined;
	const messageId =
		cfg?.include_message_id && txn?.header?.get
			? String(txn.header.get("message-id") || "").trim() || undefined
			: undefined;

	setAttrs(txnOtel.txnSpan, {
		...(size ? { [ATTR.SMTP_MESSAGE_SIZE]: size } : {}),
		...(messageId ? { [ATTR.SMTP_MESSAGE_ID]: messageId } : {}),
		[ATTR.SMTP_RCPT_COUNT]: txnOtel.rcptCount,
		...(cfg?.include_rcpt_domains && txnOtel.rcptDomains.size > 0
			? {
					[ATTR.SMTP_RCPT_DOMAINS]: Array.from(txnOtel.rcptDomains).join(","),
				}
			: {}),
	});

	if (size) {
		(this.metrics as Instruments).messageSize.record(Number(size));
	}

	if (cfg?.include_auth_results) {
		const mailauth = txn?.notes?.mailauth || {};
		const spf = mailauth.spf?.status?.result;
		const dmarc = mailauth.dmarc?.status?.result;
		const dkimResults = mailauth.dkim?.results || [];
		const dkim = dkimResults.find((r) => r.result === "pass")
			? "pass"
			: dkimResults.find((r) => r.result)?.result;

		setAttrs(txnOtel.txnSpan, {
			...(spf ? { [ATTR.SMTP_AUTH_SPF]: spf } : {}),
			...(dkim ? { [ATTR.SMTP_AUTH_DKIM]: dkim } : {}),
			...(dmarc ? { [ATTR.SMTP_AUTH_DMARC]: dmarc } : {}),
		});
	}

	next();
}

export function queue_otel(next: NextFn, connection: HarakaConnection) {
	const txnOtel = connection?.transaction?.notes?.otel;
	if (txnOtel) {
		const { span, ctx } = startSpan("smtp.queue", {
			parentCtx: txnOtel.txnCtx,
		});
		txnOtel.queueSpan = span;
		txnOtel.queueCtx = ctx;
		txnOtel.queueStart = Date.now();
	}
	next();
}

function endQueueSpan(
	self: HarakaPluginInstance,
	txnOtel: TransactionOTelState,
	{
		error,
		attributes,
	}: { error?: Error; attributes?: Record<string, unknown> } = {},
) {
	if (!txnOtel?.queueSpan) return;
	endSpan(txnOtel.queueSpan, { error, attributes: attributes as never });
	if (txnOtel.queueStart) {
		(self.metrics as Instruments).queueDuration.record(
			Date.now() - txnOtel.queueStart,
			{ result: error ? "failure" : "success" },
		);
	}
	txnOtel.queueSpan = null;
	txnOtel.queueStart = null;
}

function endTransactionSpan(
	self: HarakaPluginInstance,
	txnOtel: TransactionOTelState,
	{
		error,
		attributes,
	}: { error?: Error; attributes?: Record<string, unknown> } = {},
) {
	if (!txnOtel || txnOtel.ended) return;
	endSpan(txnOtel.txnSpan, {
		error,
		attributes: {
			[ATTR.SMTP_RCPT_COUNT]: txnOtel.rcptCount,
			...((attributes || {}) as Record<string, unknown>),
		} as never,
	});
	if (txnOtel.startTime) {
		(self.metrics as Instruments).transactionDuration.record(
			Date.now() - txnOtel.startTime,
			{ result: error ? "denied" : "accepted" },
		);
	}
	txnOtel.ended = true;
}

export function queue_ok_otel(
	this: HarakaPluginInstance,
	next: NextFn,
	connection: HarakaConnection,
) {
	const txnOtel = connection?.transaction?.notes?.otel;
	if (txnOtel) {
		endQueueSpan(this, txnOtel, {
			attributes: { [ATTR.SMTP_QUEUE_RESULT]: "success" },
		});
		(this.metrics as Instruments).queueSuccess.add(1);
		(this.metrics as Instruments).mailAccepted.add(1, {
			...(txnOtel.fromDomain ? { domain: txnOtel.fromDomain } : {}),
		});
		endTransactionSpan(this, txnOtel);
	}
	next();
}

export function deny_otel(
	this: HarakaPluginInstance,
	next: NextFn,
	connection: HarakaConnection,
	params: unknown[],
) {
	const otel = connection?.notes?.otel;
	const txnOtel = connection?.transaction?.notes?.otel;
	const code = params?.[0] as number | undefined;
	const msg = params?.[1] as string | undefined;
	const hook = params?.[5] as string | undefined;

	const denyAttrs: Record<string, unknown> = {
		...(code !== undefined ? { [ATTR.SMTP_DENY_CODE]: code } : {}),
		...(hook ? { [ATTR.SMTP_DENY_HOOK]: hook } : {}),
	};
	const err = new Error(msg ? String(msg) : "denied");

	if (txnOtel) {
		endQueueSpan(this, txnOtel, {
			error: err,
			attributes: { [ATTR.SMTP_QUEUE_RESULT]: "failure", ...denyAttrs },
		});
		(this.metrics as Instruments).queueFailure.add(
			1,
			hook === "queue" ? { hook } : undefined,
		);
		(this.metrics as Instruments).mailDenied.add(1, {
			...(hook ? { hook } : {}),
			...(code !== undefined ? { code: String(code) } : {}),
		});
		endTransactionSpan(this, txnOtel, { error: err, attributes: denyAttrs });
	} else {
		(this.metrics as Instruments).rcptDenied.add(
			1,
			hook ? { hook } : undefined,
		);
	}

	if (otel) {
		otel.denied = true;
		setAttrs(otel.connectionSpan, denyAttrs as never);
		setError(otel.connectionSpan, msg ? String(msg) : "denied");
	}
	next();
}

export function disconnect_otel(
	this: HarakaPluginInstance,
	next: NextFn,
	connection: HarakaConnection,
) {
	const otel = connection?.notes?.otel;
	if (!otel || otel.ended) return next();

	const txnOtel = connection?.transaction?.notes?.otel;
	if (txnOtel && !txnOtel.ended) {
		endQueueSpan(this, txnOtel);
		endTransactionSpan(this, txnOtel);
	}

	endSpan(otel.connectionSpan);
	if (otel.startTime) {
		(this.metrics as Instruments).connectionDuration.record(
			Date.now() - otel.startTime,
			{ result: otel.denied ? "denied" : "ok" },
		);
	}
	(this.metrics as Instruments).connectionsActive.add(-1);
	otel.ended = true;
	next();
}

export async function shutdown(this: HarakaPluginInstance) {
	this.log?.info?.("Shutting down OTel plugin");
	await sdk.shutdown(this.log);
}

export { ATTR } from "./attributes";
