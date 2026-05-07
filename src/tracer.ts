import {
	type Attributes,
	type Context,
	context,
	type Span,
	SpanKind,
	SpanStatusCode,
	trace,
} from "@opentelemetry/api";

export const TRACER_NAME = "haraka.mail-server";

export function tracer() {
	return trace.getTracer(TRACER_NAME);
}

export interface StartSpanOptions {
	parentCtx?: Context;
	attributes?: Attributes;
	kind?: SpanKind;
}

export function startSpan(name: string, opts: StartSpanOptions = {}) {
	const ctx = opts.parentCtx || context.active();
	const span = tracer().startSpan(
		name,
		{
			kind: opts.kind ?? SpanKind.SERVER,
			attributes: opts.attributes || {},
		},
		ctx,
	);
	const spanCtx = trace.setSpan(ctx, span);
	return { span, ctx: spanCtx };
}

export interface EndSpanOptions {
	error?: Error;
	attributes?: Attributes;
}

export function endSpan(
	span: Span | null | undefined,
	opts: EndSpanOptions = {},
) {
	if (!span) return;
	if (opts.attributes) span.setAttributes(opts.attributes);
	if (opts.error) {
		span.recordException(opts.error);
		span.setStatus({
			code: SpanStatusCode.ERROR,
			/* c8 ignore next -- fallback for non-Error throwables; rare */
			message: opts.error.message || String(opts.error),
		});
	}
	span.end();
}

export function setError(span: Span | null | undefined, message: string) {
	if (!span) return;
	span.setStatus({ code: SpanStatusCode.ERROR, message });
}

export function setAttrs(
	span: Span | null | undefined,
	attributes: Attributes | undefined,
) {
	if (!span || !attributes) return;
	span.setAttributes(attributes);
}

export function addEvent(
	span: Span | null | undefined,
	name: string,
	attributes?: Attributes,
) {
	if (!span) return;
	span.addEvent(name, attributes);
}

export { SpanKind, SpanStatusCode };
