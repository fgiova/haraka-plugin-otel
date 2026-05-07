import { trace } from "@opentelemetry/api";
import {
	BasicTracerProvider,
	InMemorySpanExporter,
	SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import tap from "tap";

const spanExporter = new InMemorySpanExporter();
const tracerProvider = new BasicTracerProvider({
	spanProcessors: [new SimpleSpanProcessor(spanExporter)],
});
trace.setGlobalTracerProvider(tracerProvider);

import {
	addEvent,
	endSpan,
	setAttrs,
	setError,
	startSpan,
	TRACER_NAME,
} from "../../src/tracer";

tap.beforeEach(() => spanExporter.reset());

tap.test("TRACER_NAME constant", async (t) => {
	t.equal(TRACER_NAME, "haraka.mail-server");
});

tap.test("startSpan + endSpan: produces a finished span", async (t) => {
	const { span } = startSpan("test.span", { attributes: { foo: "bar" } });
	endSpan(span);
	const finished = spanExporter.getFinishedSpans();
	t.equal(finished.length, 1);
	t.equal(finished[0].name, "test.span");
	t.equal(finished[0].attributes.foo, "bar");
});

tap.test(
	"endSpan with error sets ERROR status + records exception",
	async (t) => {
		const { span } = startSpan("err.span");
		endSpan(span, { error: new Error("boom"), attributes: { extra: "x" } });
		const s = spanExporter.getFinishedSpans()[0];
		t.equal(s.status.code, 2); // SpanStatusCode.ERROR
		t.equal(s.status.message, "boom");
		t.equal(s.attributes.extra, "x");
		t.ok(s.events.find((e) => e.name === "exception"));
	},
);

tap.test("endSpan with null span is a no-op", async (t) => {
	endSpan(null);
	endSpan(undefined);
	t.equal(spanExporter.getFinishedSpans().length, 0);
});

tap.test("setError: marks status without ending span", async (t) => {
	const { span } = startSpan("err2");
	setError(span, "denied");
	endSpan(span);
	const s = spanExporter.getFinishedSpans()[0];
	t.equal(s.status.code, 2);
	t.equal(s.status.message, "denied");
});

tap.test("setError: null span no-op", async (t) => {
	setError(null, "denied");
	setError(undefined, "denied");
	t.pass();
});

tap.test(
	"setAttrs: applies attributes when span and attrs are valid",
	async (t) => {
		const { span } = startSpan("attr.span");
		setAttrs(span, { a: 1, b: "two" });
		endSpan(span);
		const s = spanExporter.getFinishedSpans()[0];
		t.equal(s.attributes.a, 1);
		t.equal(s.attributes.b, "two");
	},
);

tap.test("setAttrs: null span or undefined attrs → no-op", async (t) => {
	setAttrs(null, { x: 1 });
	const { span } = startSpan("noattr");
	setAttrs(span, undefined);
	endSpan(span);
	const s = spanExporter.getFinishedSpans()[0];
	t.notOk(s.attributes.x);
});

tap.test("addEvent: records event on span", async (t) => {
	const { span } = startSpan("evt.span");
	addEvent(span, "thing.happened", { code: 42 });
	endSpan(span);
	const s = spanExporter.getFinishedSpans()[0];
	const ev = s.events.find((e) => e.name === "thing.happened");
	t.ok(ev);
	t.equal(ev?.attributes?.code, 42);
});

tap.test("addEvent: null span no-op", async (t) => {
	addEvent(null, "foo");
	addEvent(undefined, "foo", { a: 1 });
	t.pass();
});

tap.test("startSpan: parentCtx propagates parent linkage", async (t) => {
	const { span: parent, ctx: parentCtx } = startSpan("parent");
	const { span: child } = startSpan("child", { parentCtx });
	endSpan(child);
	endSpan(parent);
	const finished = spanExporter.getFinishedSpans();
	const childFinished = finished.find((s) => s.name === "child");
	const parentFinished = finished.find((s) => s.name === "parent");
	const parentOf = (s: unknown) =>
		(s as { parentSpanContext?: { spanId: string }; parentSpanId?: string })
			?.parentSpanContext?.spanId ||
		(s as { parentSpanId?: string })?.parentSpanId;
	t.equal(parentOf(childFinished), parentFinished?.spanContext().spanId);
});
