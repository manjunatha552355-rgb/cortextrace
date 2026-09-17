export interface SecretPattern {
  label: string;
  re: RegExp;
  keep?: number; // leading chars of the match kept visible (e.g. the "key=" prefix group handled via group 1)
}

// Order matters: specific token formats before generic key=value.
export const SECRET_PATTERNS: SecretPattern[] = [
  { label: 'private_key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g },
  { label: 'aws_access_key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { label: 'github_token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})\b/g },
  { label: 'anthropic_key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { label: 'openai_key', re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}/g },
  { label: 'google_api_key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { label: 'slack_token', re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g },
  { label: 'stripe_key', re: /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}/g },
  { label: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  { label: 'bearer_token', re: /(\bBearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi },
  { label: 'url_credentials', re: /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+(@)/gi },
  {
    label: 'assigned_secret',
    re: /(\b[A-Za-z0-9_.-]*(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret)[A-Za-z0-9_.-]*\s*[=:]\s*["']?)(?!\[REDACTED)[^\s"'&;,]{4,}/gi,
  },
];

const SENSITIVE_KEY = /^(?:authorization|cookie|set-cookie|password|passwd|secret|token|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key|x-api-key)$/i;

export const MAX_STRING = 4096;

export interface RedactResult {
  text: string;
  labels: string[];
}

export function redactText(input: string, extra: SecretPattern[] = []): RedactResult {
  let text = input;
  const labels = new Set<string>();
  for (const p of [...SECRET_PATTERNS, ...extra]) {
    p.re.lastIndex = 0;
    text = text.replace(p.re, (_match: string, ...rest: unknown[]) => {
      labels.add(p.label);
      // replace() passes capture groups, then the numeric offset; only the groups are prefix/suffix to keep.
      const groups = rest.slice(0, rest.findIndex((x) => typeof x === 'number'));
      const g1 = typeof groups[0] === 'string' ? groups[0] : '';
      const g2 = typeof groups[1] === 'string' ? groups[1] : '';
      return `${g1}[REDACTED:${p.label}]${g2}`;
    });
  }
  return { text, labels: [...labels] };
}

export function truncate(s: string, max = MAX_STRING): string {
  return s.length > max ? `${s.slice(0, max)}…[truncated ${s.length - max} chars]` : s;
}

// Deep-redacts a JSON-like value. Sensitive keys are masked entirely; strings are pattern-scanned and truncated.
export function redactValue(value: unknown, labels: Set<string>, extra: SecretPattern[] = [], depth = 0): unknown {
  if (depth > 12) return '[depth-limit]';
  if (typeof value === 'string') {
    const r = redactText(value, extra);
    r.labels.forEach((l) => labels.add(l));
    return truncate(r.text);
  }
  if (Array.isArray(value)) return value.slice(0, 500).map((v) => redactValue(v, labels, extra, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (SENSITIVE_KEY.test(k) && v != null && v !== '') {
        labels.add('sensitive_field');
        out[k] = '[REDACTED:sensitive_field]';
      } else {
        out[k] = redactValue(v, labels, extra, depth + 1);
      }
    }
    return out;
  }
  return value;
}

export function compileUserPatterns(patterns: { label: string; regex: string }[]): SecretPattern[] {
  const out: SecretPattern[] = [];
  for (const p of patterns) {
    try {
      out.push({ label: p.label.slice(0, 48), re: new RegExp(p.regex, 'g') });
    } catch {
      // invalid user regex is skipped; config validation surfaces it
    }
  }
  return out;
}
