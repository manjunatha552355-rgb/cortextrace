import { randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { severityRank, type Detection } from '../core/schema.ts';
import type { Config } from '../core/config.ts';
import type { Logger } from '../core/observe.ts';
import type { AlertRow, Store } from '../storage/db.ts';

const INCIDENT_WINDOW_MS = 30 * 60_000;

export interface AlertOutcome {
  alert: AlertRow;
  created: boolean;
}

export class AlertManager {
  private store: Store;
  private config: () => Config;
  private log: Logger;
  private alertLogPath: string | null;
  private notify: (a: AlertRow, d: Detection) => void;

  constructor(store: Store, config: () => Config, log: Logger, alertLogPath: string | null, notify: (a: AlertRow, d: Detection) => void) {
    this.store = store;
    this.config = config;
    this.log = log;
    this.alertLogPath = alertLogPath;
    this.notify = notify;
  }

  process(d: Detection): AlertOutcome | null {
    const cfg = this.config().alerts;
    if (severityRank(d.severity) < severityRank(cfg.min_severity)) return null;
    const now = d.timestamp;
    const suppressed = cfg.suppressions.some((s) => s.rule_id === d.rule_id && (!s.agent_type || s.agent_type === d.agent_type) && (!s.until || s.until > now));
    const dedupKey = [d.rule_id, d.session_id ?? d.agent_id, normalizeEvidence(d.evidence[0] ?? '')].join('|');

    const existing = this.store.findOpenAlert(dedupKey, now - cfg.dedup_window_sec * 1000);
    if (existing) {
      this.store.bumpAlert(existing.alert_id, now, d.detection_id);
      return { alert: { ...existing, count: existing.count + 1, last_ts: now }, created: false };
    }

    const incident = this.store.recentIncident(d.session_id ?? d.agent_id, now - INCIDENT_WINDOW_MS) ?? `inc-${randomUUID().slice(0, 8)}`;
    const alert: AlertRow = {
      alert_id: randomUUID(), dedup_key: dedupKey, incident_id: incident, first_ts: now, last_ts: now, count: 1,
      rule_id: d.rule_id, title: d.rule_name, severity: d.severity, agent_id: d.agent_id, agent_type: d.agent_type,
      session_id: d.session_id, detection_id: d.detection_id, status: suppressed ? 'suppressed' : 'open', acked_at: null,
    };
    this.store.insertAlert(alert);

    if (this.alertLogPath) {
      try {
        appendFileSync(this.alertLogPath, `${JSON.stringify({ ...alert, reason: d.reason, evidence: d.evidence, classification: d.classification, confidence: d.confidence, recommended_action: d.recommended_action })}\n`, { mode: 0o600 });
      } catch (e) {
        this.log.warn('alerts', 'alert log write failed', { error: (e as Error).message });
      }
    }
    if (!suppressed) {
      if (cfg.desktop_notifications && severityRank(d.severity) >= severityRank(cfg.notify_min_severity)) this.notify(alert, d);
      if (cfg.webhook_url) void this.webhook(cfg.webhook_url, alert, d);
    }
    return { alert, created: true };
  }

  private async webhook(url: string, alert: AlertRow, d: Detection) {
    try {
      // Only alert metadata is sent: no prompts, file contents or raw payloads.
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'user-agent': 'cortextrace-alerts' },
        body: JSON.stringify({ alert, detection: { rule_id: d.rule_id, reason: d.reason, severity: d.severity, confidence: d.confidence, classification: d.classification, evidence: d.evidence, recommended_action: d.recommended_action } }),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) this.log.warn('alerts', `webhook returned ${res.status}`);
    } catch (e) {
      this.log.warn('alerts', 'webhook failed', { error: (e as Error).message });
    }
  }
}

// Numbers, hex ids and timestamps vary between otherwise identical alerts.
export const normalizeEvidence = (s: string) => s.replace(/\b[0-9a-f]{8,}\b/gi, '#').replace(/\d+/g, '#').slice(0, 120);
