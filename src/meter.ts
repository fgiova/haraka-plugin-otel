import {
	type Counter,
	type Histogram,
	metrics,
	type UpDownCounter,
} from "@opentelemetry/api";

export const METER_NAME = "haraka.mail-server";

export interface Instruments {
	connectionsTotal: Counter;
	connectionsActive: UpDownCounter;
	connectionDuration: Histogram;
	mailReceived: Counter;
	mailAccepted: Counter;
	mailDenied: Counter;
	rcptAccepted: Counter;
	rcptDenied: Counter;
	queueSuccess: Counter;
	queueFailure: Counter;
	queueDuration: Histogram;
	transactionDuration: Histogram;
	messageSize: Histogram;
}

let instruments: Instruments | null = null;

function build(): Instruments {
	const meter = metrics.getMeter(METER_NAME);

	return {
		connectionsTotal: meter.createCounter("haraka.connections.total", {
			description: "Total SMTP connections accepted",
		}),
		connectionsActive: meter.createUpDownCounter("haraka.connections.active", {
			description: "Active SMTP connections",
		}),
		connectionDuration: meter.createHistogram("haraka.connection.duration", {
			description: "SMTP connection duration",
			unit: "ms",
		}),
		mailReceived: meter.createCounter("haraka.mail.received", {
			description: "MAIL FROM commands received",
		}),
		mailAccepted: meter.createCounter("haraka.mail.accepted", {
			description: "Transactions accepted (queued)",
		}),
		mailDenied: meter.createCounter("haraka.mail.denied", {
			description: "Transactions denied",
		}),
		rcptAccepted: meter.createCounter("haraka.rcpt.accepted", {
			description: "RCPT TO accepted",
		}),
		rcptDenied: meter.createCounter("haraka.rcpt.denied", {
			description: "RCPT TO denied",
		}),
		queueSuccess: meter.createCounter("haraka.queue.success", {
			description: "Queue operations succeeded",
		}),
		queueFailure: meter.createCounter("haraka.queue.failure", {
			description: "Queue operations failed",
		}),
		queueDuration: meter.createHistogram("haraka.queue.duration", {
			description: "Queue hook duration",
			unit: "ms",
		}),
		transactionDuration: meter.createHistogram("haraka.transaction.duration", {
			description: "SMTP transaction duration (mail → end)",
			unit: "ms",
		}),
		messageSize: meter.createHistogram("haraka.message.size", {
			description: "Message size in bytes",
			unit: "By",
		}),
	};
}

export function get(): Instruments {
	if (!instruments) instruments = build();
	return instruments;
}

export function reset() {
	instruments = null;
}
