// biome-ignore-all lint/suspicious/noExplicitAny: test mocks intentionally use `any` for flexibility across Haraka shapes
import { randomUUID } from "node:crypto";
import { PassThrough } from "node:stream";

export function createMockNext() {
	let resolveFn: (args: unknown[]) => void;
	const promise = new Promise<unknown[]>((resolve) => {
		resolveFn = resolve;
	});

	const fn: any = (...args: unknown[]) => {
		fn.args = args;
		resolveFn(args);
	};
	fn.args = null;
	fn.promise = promise;
	return fn;
}

export function createMockTransaction(overrides: Record<string, unknown> = {}) {
	const headers: Record<string, string> = {};
	const resultsAdded: Array<{ plugin: unknown; result: unknown }> = [];
	return {
		uuid: randomUUID(),
		rcpt_to: [],
		results: {
			add(plugin: unknown, result: unknown) {
				resultsAdded.push({ plugin, result });
			},
			_added: resultsAdded,
		},
		notes: {} as Record<string, unknown>,
		message_stream: new PassThrough(),
		header: {
			_headers: headers,
			get(name: string) {
				return headers[name.toLowerCase()] || "";
			},
			add(name: string, value: string) {
				headers[name.toLowerCase()] = value;
			},
		},
		...overrides,
	};
}

export function createMockConnection(overrides: Record<string, unknown> = {}) {
	const logs: Array<{ level: string; msg: string }> = [];
	const log = {
		debug: (msg: string) => logs.push({ level: "debug", msg }),
		warn: (msg: string) => logs.push({ level: "warn", msg }),
		info: (msg: string) => logs.push({ level: "info", msg }),
		error: (msg: string) => logs.push({ level: "error", msg }),
		_logs: logs,
	};
	const txn =
		overrides.transaction && typeof overrides.transaction === "object"
			? overrides.transaction
			: createMockTransaction();
	const { transaction: _txn, ...rest } = overrides;
	return {
		transaction: txn,
		log,
		logdebug: log.debug,
		logwarn: log.warn,
		loginfo: log.info,
		logerror: log.error,
		...rest,
	};
}

export function createMockRcpt(user: string, host: string) {
	return {
		user,
		host,
		toString() {
			return `${user}@${host}`;
		},
	};
}

export function createMockSelf() {
	const hooks: Array<{ name: string; method: string; priority?: number }> = [];
	return {
		_hooks: hooks,
		logdebug: (_: string) => {},
		loginfo: (_: string) => {},
		logwarn: (_: string) => {},
		logerror: (_: string) => {},
		register_hook(name: string, method: string, priority?: number) {
			hooks.push({ name, method, priority });
		},
	};
}
