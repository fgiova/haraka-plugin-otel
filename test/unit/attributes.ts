import tap from "tap";
import { ATTR, safeDomainFromAddress } from "../../src/attributes";

tap.test("ATTR keys: stable contract", async (t) => {
	t.equal(ATTR.SMTP_MAIL_FROM_DOMAIN, "smtp.mail.from.domain");
	t.equal(ATTR.SMTP_RCPT_DOMAINS, "smtp.rcpt.domains");
	t.equal(ATTR.SMTP_MESSAGE_ID, "smtp.message.id");
	t.equal(ATTR.SMTP_AUTH_SPF, "smtp.auth.spf");
	t.equal(ATTR.NET_PEER_ADDR, "network.peer.address");
});

tap.test("safeDomainFromAddress: undefined / null / empty", async (t) => {
	t.equal(safeDomainFromAddress(undefined), undefined);
	t.equal(safeDomainFromAddress(null), undefined);
	t.equal(safeDomainFromAddress(""), undefined);
});

tap.test(
	"safeDomainFromAddress: string with @ → lowercased domain",
	async (t) => {
		t.equal(safeDomainFromAddress("alice@Example.COM"), "example.com");
		t.equal(safeDomainFromAddress("bob@sub.host.io"), "sub.host.io");
	},
);

tap.test("safeDomainFromAddress: string without @ → undefined", async (t) => {
	t.equal(safeDomainFromAddress("nobody"), undefined);
});

tap.test(
	"safeDomainFromAddress: string with multiple @ → uses lastIndexOf",
	async (t) => {
		t.equal(safeDomainFromAddress("weird@user@Example.com"), "example.com");
	},
);

tap.test("safeDomainFromAddress: object with .host", async (t) => {
	t.equal(safeDomainFromAddress({ host: "Example.COM" }), "example.com");
	t.equal(safeDomainFromAddress({ host: "x.io" }), "x.io");
});

tap.test("safeDomainFromAddress: object without .host", async (t) => {
	t.equal(safeDomainFromAddress({ user: "alice" }), undefined);
	t.equal(safeDomainFromAddress({}), undefined);
});
