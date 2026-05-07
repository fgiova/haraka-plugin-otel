export const ATTR = {
	MESSAGING_SYSTEM: "messaging.system",
	NET_PEER_ADDR: "network.peer.address",
	NET_PEER_PORT: "network.peer.port",
	NET_TRANSPORT: "network.transport",
	SMTP_HELO: "smtp.helo.host",
	SMTP_TLS: "smtp.tls",
	SMTP_TLS_PROTO: "smtp.tls.protocol",
	SMTP_MAIL_FROM_DOMAIN: "smtp.mail.from.domain",
	SMTP_RCPT_COUNT: "smtp.rcpt.count",
	SMTP_RCPT_DOMAINS: "smtp.rcpt.domains",
	SMTP_MESSAGE_SIZE: "smtp.message.size",
	SMTP_MESSAGE_ID: "smtp.message.id",
	SMTP_QUEUE_RESULT: "smtp.queue.result",
	SMTP_QUEUE_ROUTE: "smtp.queue.route",
	SMTP_DENY_CODE: "smtp.deny.code",
	SMTP_DENY_HOOK: "smtp.deny.hook",
	SMTP_AUTH_SPF: "smtp.auth.spf",
	SMTP_AUTH_DKIM: "smtp.auth.dkim",
	SMTP_AUTH_DMARC: "smtp.auth.dmarc",
} as const;

export function safeDomainFromAddress(addr: unknown): string | undefined {
	if (!addr) return undefined;
	if (typeof addr === "string") {
		const at = addr.lastIndexOf("@");
		return at >= 0 ? addr.slice(at + 1).toLowerCase() : undefined;
	}
	const a = addr as { host?: string };
	return a.host ? String(a.host).toLowerCase() : undefined;
}
