import { EVENT_TYPES, SEVERITIES } from '../core/schema.ts';

const bearer = [{ bearer: [] }];
const json = (schema: object) => ({ content: { 'application/json': { schema } } });
const ok = (description: string, schema: object = { type: 'object' }) => ({ 200: { description, ...json(schema) }, 401: { description: 'Missing or invalid token' }, 429: { description: 'Rate limited' } });
const q = (name: string, type: string, description: string) => ({ name, in: 'query', required: false, schema: { type }, description });

export const OPENAPI = {
  openapi: '3.1.0',
  info: {
    title: 'Cortextrace Local API',
    version: '1',
    description: 'Loopback-only API. Two bearer tokens live in tokens.json in the data directory: `ingest` (write events/hooks/OTLP) and `api` (read + manage). Requests with an Origin header are rejected.',
  },
  servers: [{ url: 'http://127.0.0.1:47631' }],
  components: {
    securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } },
    schemas: {
      Severity: { type: 'string', enum: SEVERITIES },
      EventType: { type: 'string', enum: EVENT_TYPES },
      IngestEvent: {
        type: 'object', required: ['event_type', 'agent_type'],
        properties: {
          event_type: { $ref: '#/components/schemas/EventType' }, agent_type: { type: 'string', pattern: '^[a-zA-Z0-9._-]+$' },
          agent_version: { type: 'string' }, session_id: { type: 'string' }, workspace: { type: 'string' }, timestamp: { type: 'integer', description: 'epoch ms' },
          duration_ms: { type: 'number' }, severity: { $ref: '#/components/schemas/Severity' }, process_id: { type: 'integer' }, correlation_id: { type: 'string' },
          trace_id: { type: 'string' }, span_id: { type: 'string' }, parent_span_id: { type: 'string' }, payload: { type: 'object', additionalProperties: true },
        },
      },
      Event: {
        type: 'object',
        properties: {
          event_id: { type: 'string' }, event_version: { type: 'integer' }, timestamp: { type: 'integer' }, host_id: { type: 'string' }, agent_id: { type: 'string' },
          agent_type: { type: 'string' }, agent_version: { type: ['string', 'null'] }, session_id: { type: ['string', 'null'] }, process_id: { type: ['integer', 'null'] },
          parent_process_id: { type: ['integer', 'null'] }, workspace: { type: ['string', 'null'] }, event_type: { $ref: '#/components/schemas/EventType' },
          source: { type: 'string' }, fidelity: { type: 'string', enum: ['observed', 'inferred'] }, severity: { $ref: '#/components/schemas/Severity' },
          duration_ms: { type: ['number', 'null'] }, payload: { type: 'object' }, correlation_id: { type: ['string', 'null'] }, trace_id: { type: ['string', 'null'] },
          span_id: { type: ['string', 'null'] }, parent_span_id: { type: ['string', 'null'] }, risk_score: { type: 'number' }, security_labels: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
  paths: {
    '/v1/health': { get: { summary: 'Liveness (no auth)', responses: { 200: { description: 'ok' } } } },
    '/v1/hooks/{adapter}/{event}': {
      post: {
        summary: 'Receive a native agent hook payload', security: bearer,
        parameters: [{ name: 'adapter', in: 'path', required: true, schema: { type: 'string' } }, { name: 'event', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: json({ type: 'object' }),
        responses: { 204: { description: 'Accepted, no decision' }, 200: { description: 'Accepted with runtime-specific policy decision body' }, 404: { description: 'Unknown adapter' } },
      },
    },
    '/otlp/v1/logs': { post: { summary: 'OTLP/HTTP JSON logs (token-authenticated variant)', security: bearer, responses: ok('Accepted') } },
    '/otlp/v1/traces': { post: { summary: 'OTLP/HTTP JSON traces', security: bearer, responses: ok('Accepted') } },
    '/otlp/v1/metrics': { post: { summary: 'OTLP/HTTP JSON metrics', security: bearer, responses: ok('Accepted') } },
    '/v1/agents': { get: { summary: 'Agent inventory', security: bearer, responses: ok('Agents', { type: 'array' }) } },
    '/v1/sessions': { get: { summary: 'Sessions', security: bearer, parameters: [q('agent_id', 'string', ''), q('active_since', 'integer', 'epoch ms'), q('limit', 'integer', '')], responses: ok('Sessions', { type: 'array' }) } },
    '/v1/sessions/{id}': { get: { summary: 'Session with risk explanation and detections', security: bearer, parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: ok('Session') } },
    '/v1/events': {
      post: { summary: 'Ingest normalized events (SDK / custom agents)', security: bearer, requestBody: json({ oneOf: [{ $ref: '#/components/schemas/IngestEvent' }, { type: 'array', maxItems: 5000, items: { $ref: '#/components/schemas/IngestEvent' } }] }), responses: ok('Accepted count') },
      get: {
        summary: 'Query events', security: bearer,
        parameters: [q('from', 'integer', 'epoch ms'), q('to', 'integer', 'epoch ms'), q('agent_id', 'string', ''), q('session_id', 'string', ''), q('types', 'string', 'comma separated'), q('min_severity', 'string', ''), q('search', 'string', ''), q('limit', 'integer', 'max 5000'), q('offset', 'integer', ''), q('order', 'string', 'asc|desc')],
        responses: ok('Events', { type: 'array', items: { $ref: '#/components/schemas/Event' } }),
      },
    },
    '/v1/detections': { get: { summary: 'Detections', security: bearer, parameters: [q('from', 'integer', ''), q('session_id', 'string', ''), q('agent_id', 'string', ''), q('limit', 'integer', '')], responses: ok('Detections', { type: 'array' }) } },
    '/v1/alerts': { get: { summary: 'Alerts (deduplicated, grouped into incidents)', security: bearer, parameters: [q('status', 'string', 'open|acknowledged|suppressed'), q('from', 'integer', ''), q('limit', 'integer', '')], responses: ok('Alerts', { type: 'array' }) } },
    '/v1/alerts/{id}/acknowledge': { post: { summary: 'Acknowledge alert', security: bearer, responses: ok('ok') } },
    '/v1/alerts/{id}/reopen': { post: { summary: 'Reopen alert', security: bearer, responses: ok('ok') } },
    '/v1/overview': { get: { summary: 'Dashboard aggregates', security: bearer, parameters: [q('from', 'integer', ''), q('to', 'integer', '')], responses: ok('Overview') } },
    '/v1/system': { get: { summary: 'Self-observability: collectors, adapters, pipeline metrics', security: bearer, responses: ok('System health') } },
  },
};
