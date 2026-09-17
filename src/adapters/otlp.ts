import type { EventInput, EventType } from '../core/schema.ts';
import { classifyTool } from './builtin.ts';

type AnyValue = { stringValue?: string; intValue?: string | number; doubleValue?: number; boolValue?: boolean; arrayValue?: { values?: AnyValue[] }; kvlistValue?: { values?: KeyValue[] }; bytesValue?: string };
type KeyValue = { key: string; value?: AnyValue };

export function anyValue(v: AnyValue | undefined): unknown {
  if (!v) return null;
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.intValue !== undefined) return Number(v.intValue);
  if (v.doubleValue !== undefined) return v.doubleValue;
  if (v.boolValue !== undefined) return v.boolValue;
  if (v.arrayValue) return (v.arrayValue.values ?? []).map(anyValue);
  if (v.kvlistValue) return attrs(v.kvlistValue.values);
  if (v.bytesValue !== undefined) return `[bytes ${v.bytesValue.length}]`;
  return null;
}

export function attrs(list: KeyValue[] | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const kv of list ?? []) if (kv && typeof kv.key === 'string') out[kv.key] = anyValue(kv.value);
  return out;
}

const nanoToMs = (n: unknown) => {
  if (n == null) return undefined;
  const s = String(n);
  const ms = s.length > 6 ? Number(s.slice(0, -6)) : Math.floor(Number(s) / 1e6);
  return Number.isFinite(ms) && ms > 0 ? ms : undefined;
};

const num = (v: unknown) => (v == null || v === '' ? undefined : Number.isFinite(Number(v)) ? Number(v) : undefined);
const parseMaybe = (v: unknown): Record<string, any> => {
  if (v && typeof v === 'object') return v as Record<string, any>;
  if (typeof v !== 'string') return {};
  try { const o = JSON.parse(v); return o && typeof o === 'object' ? o : {}; } catch { return {}; }
};

export interface OtlpNormalized {
  service: string;
  events: EventInput[];
}

export function normalizeOtlpLogs(body: any): OtlpNormalized[] {
  const out: OtlpNormalized[] = [];
  for (const rl of Array.isArray(body?.resourceLogs) ? body.resourceLogs : []) {
    const res = attrs(rl?.resource?.attributes);
    const service = String(res['service.name'] ?? 'unknown');
    const events: EventInput[] = [];
    for (const sl of rl?.scopeLogs ?? []) {
      for (const lr of sl?.logRecords ?? []) {
        const a = { ...attrs(lr?.attributes) };
        const name = String(a['event.name'] ?? (typeof lr?.body?.stringValue === 'string' ? lr.body.stringValue : '') ?? '');
        const e = mapLogEvent(name, a);
        if (!e) continue;
        e.timestamp = nanoToMs(lr?.timeUnixNano) ?? nanoToMs(lr?.observedTimeUnixNano) ?? Date.now();
        e.trace_id = typeof lr?.traceId === 'string' && lr.traceId ? lr.traceId.slice(0, 64) : null;
        e.span_id = typeof lr?.spanId === 'string' && lr.spanId ? lr.spanId.slice(0, 32) : null;
        e.agent_version = typeof res['service.version'] === 'string' ? res['service.version'] : null;
        events.push(e);
      }
    }
    out.push({ service, events });
  }
  return out;
}

const SHELL_TOOLS = /^(bash|shell|exec_command|run_shell_command|local_shell|powershell|container\.exec)$/i;

export function mapLogEvent(name: string, a: Record<string, unknown>): EventInput | null {
  const suffix = name.split('.').pop() ?? name;
  const base: Partial<EventInput> = {
    source: 'otlp',
    session_id: (a['session.id'] ?? a['conversation.id'] ?? a['session_id'] ?? null) as string | null,
    correlation_id: (a['tool_use_id'] ?? a['call_id'] ?? a['prompt.id'] ?? null) as string | null,
  };
  const ev = (t: EventType, payload: Record<string, unknown>, extra: Partial<EventInput> = {}) =>
    ({ ...base, event_type: t, payload: { otel_event: name, ...payload }, ...extra }) as EventInput;
  const duration = num(a['duration_ms']);

  switch (suffix) {
    case 'user_prompt':
      return ev('prompt_observed', { prompt: a['prompt'], prompt_length: num(a['prompt_length']) ?? (typeof a['prompt'] === 'string' ? a['prompt'].length : null) });
    case 'tool_decision': {
      const decision = String(a['decision'] ?? '').toLowerCase();
      const t: EventType = /reject|deny|denied|abort/.test(decision) ? 'approval_denied' : 'approval_granted';
      return ev(t, { tool_name: a['tool_name'], decision, decision_source: a['source'] });
    }
    case 'tool_result':
    case 'tool_call': {
      const tool = String(a['tool_name'] ?? a['function_name'] ?? 'unknown');
      const params = parseMaybe(a['tool_parameters'] ?? a['arguments'] ?? a['function_args']);
      const success = a['success'] === undefined ? undefined : String(a['success']) === 'true';
      const extra = { duration_ms: duration ?? null, severity: success === false ? 'LOW' as const : 'INFO' as const };
      const command = params.bash_command ?? params.command ?? params.cmd;
      if (SHELL_TOOLS.test(tool) && command) {
        return ev('command_execution', { tool_name: tool, command: Array.isArray(command) ? command.join(' ') : String(command), success, error: a['error'], output_length: typeof a['output'] === 'string' ? a['output'].length : undefined }, extra);
      }
      if (tool.startsWith('mcp__') || a['mcp_server_name'] || params.mcp_server_name) {
        const e = classifyTool(tool, params, (t, p) => ev(t, p, extra));
        if (e.event_type === 'mcp_call') return e;
        return ev('mcp_call', { tool_name: tool, mcp_server: a['mcp_server_name'] ?? params.mcp_server_name, mcp_tool: a['mcp_tool_name'] ?? params.mcp_tool_name ?? tool, success }, extra);
      }
      return suffix === 'tool_call' ? classifyTool(tool, params, (t, p) => ev(t, p, extra))
        : ev('tool_result', { tool_name: tool, success, error: a['error'], output: a['output'], output_length: typeof a['output'] === 'string' ? a['output'].length : undefined }, extra);
    }
    case 'api_request':
    case 'api_response':
    case 'response':
    case 'sse_event':
      if (suffix === 'sse_event' && !a['input_token_count'] && !a['output_token_count']) return null;
      return ev('response_metadata', {
        model: a['model'], input_tokens: num(a['input_tokens'] ?? a['input_token_count']), output_tokens: num(a['output_tokens'] ?? a['output_token_count']),
        cache_read_tokens: num(a['cache_read_tokens'] ?? a['cached_token_count']), cost_usd: num(a['cost_usd']), status: a['status_code'],
      }, { duration_ms: duration ?? null });
    case 'api_error':
    case 'error':
      return ev('error', { model: a['model'], error: a['error'] ?? a['error.message'], status: a['status_code'], attempt: num(a['attempt']) }, { severity: 'LOW', duration_ms: duration ?? null });
    case 'config':
    case 'conversation_starts':
    case 'session_start':
      return ev('session_started', { model: a['model'], provider: a['provider_name'], approval_policy: a['approval_policy'], sandbox_policy: a['sandbox_policy'] });
    default:
      return name ? ev('response_metadata', { unmapped: true, attributes: a }) : null;
  }
}

export function normalizeOtlpTraces(body: any): OtlpNormalized[] {
  const out: OtlpNormalized[] = [];
  for (const rs of Array.isArray(body?.resourceSpans) ? body.resourceSpans : []) {
    const res = attrs(rs?.resource?.attributes);
    const service = String(res['service.name'] ?? 'unknown');
    const events: EventInput[] = [];
    for (const ss of rs?.scopeSpans ?? []) {
      for (const sp of ss?.spans ?? []) {
        const a = attrs(sp?.attributes);
        const start = nanoToMs(sp?.startTimeUnixNano) ?? Date.now();
        const end = nanoToMs(sp?.endTimeUnixNano);
        const name = String(sp?.name ?? 'span');
        const toolName = (a['gen_ai.tool.name'] ?? a['tool_name'] ?? a['tool.name']) as string | undefined;
        const failed = sp?.status?.code === 2 || sp?.status?.code === 'STATUS_CODE_ERROR';
        const common: Partial<EventInput> = {
          source: 'otlp', timestamp: start, duration_ms: end ? Math.max(0, end - start) : null,
          trace_id: typeof sp?.traceId === 'string' ? sp.traceId.slice(0, 64) : null,
          span_id: typeof sp?.spanId === 'string' ? sp.spanId.slice(0, 32) : null,
          parent_span_id: typeof sp?.parentSpanId === 'string' && sp.parentSpanId ? sp.parentSpanId.slice(0, 32) : null,
          session_id: (a['session.id'] ?? a['gen_ai.conversation.id'] ?? null) as string | null,
          severity: failed ? 'LOW' : 'INFO',
        };
        if (toolName) {
          const params = parseMaybe(a['gen_ai.tool.call.arguments'] ?? a['tool_parameters']);
          events.push(classifyTool(String(toolName), params, (t, p) => ({ ...common, event_type: t, payload: { span: name, success: !failed, ...p } }) as EventInput));
        } else {
          events.push({ ...common, event_type: failed ? 'error' : 'response_metadata', payload: { span: name, model: a['gen_ai.request.model'] ?? a['gen_ai.response.model'], input_tokens: num(a['gen_ai.usage.input_tokens']), output_tokens: num(a['gen_ai.usage.output_tokens']), attributes: a } } as EventInput);
        }
      }
    }
    out.push({ service, events });
  }
  return out;
}

export interface MetricPoint {
  service: string;
  name: string;
  value: number;
  attributes: Record<string, unknown>;
}

export function normalizeOtlpMetrics(body: any): MetricPoint[] {
  const out: MetricPoint[] = [];
  for (const rm of Array.isArray(body?.resourceMetrics) ? body.resourceMetrics : []) {
    const service = String(attrs(rm?.resource?.attributes)['service.name'] ?? 'unknown');
    for (const sm of rm?.scopeMetrics ?? []) {
      for (const m of sm?.metrics ?? []) {
        const dps = m?.sum?.dataPoints ?? m?.gauge?.dataPoints ?? [];
        for (const dp of dps) {
          const value = dp?.asDouble ?? (dp?.asInt !== undefined ? Number(dp.asInt) : undefined);
          if (value === undefined || !Number.isFinite(Number(value))) continue;
          out.push({ service, name: String(m.name), value: Number(value), attributes: attrs(dp?.attributes) });
        }
      }
    }
  }
  return out;
}
