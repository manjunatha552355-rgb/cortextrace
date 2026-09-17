import { RISK_DIMENSIONS, type Detection, type RiskDimension, type Severity, type Classification } from '../core/schema.ts';
import type { Config } from '../core/config.ts';

export const SEVERITY_POINTS: Record<Severity, number> = { INFO: 0, LOW: 6, MEDIUM: 18, HIGH: 40, CRITICAL: 75 };
const CLASS_WEIGHT: Record<Classification, number> = { observation: 0.5, suspicious_indicator: 1, policy_violation: 1.2 };
const DECAY = 0.7;
const REPEAT_WEIGHT = 0.25;
const MAX_REPEATS = 3;

export interface RiskFactor {
  detection_id: string;
  rule_id: string;
  rule_name: string;
  dimension: RiskDimension;
  severity: Severity;
  classification: Classification;
  confidence: number;
  points: number;
  evidence: string[];
  timestamp: number;
}

export interface RiskExplanation {
  score: number;
  level: 'none' | 'low' | 'medium' | 'high' | 'critical';
  dimensions: Record<RiskDimension, number>;
  factors: RiskFactor[];
  formula: string;
}

/**
 * Explainable score: each detection contributes severity points × confidence × classification weight.
 * Repeats of the same rule count at 25% (max 3). Contributions are sorted and combined with geometric decay (0.7^rank),
 * so one critical finding dominates while many small ones still accumulate. Capped at 100.
 */
export function computeRisk(detections: Detection[], thresholds: Config['risk']['thresholds']): RiskExplanation {
  const perRule = new Map<string, number>();
  const factors: RiskFactor[] = [];
  const ordered = [...detections].sort((a, b) => a.timestamp - b.timestamp);
  for (const d of ordered) {
    const seen = perRule.get(d.rule_id) ?? 0;
    perRule.set(d.rule_id, seen + 1);
    if (seen > MAX_REPEATS) continue;
    const base = SEVERITY_POINTS[d.severity] * d.confidence * CLASS_WEIGHT[d.classification];
    const points = Math.round(base * (seen === 0 ? 1 : REPEAT_WEIGHT) * 10) / 10;
    if (points <= 0) continue;
    factors.push({
      detection_id: d.detection_id, rule_id: d.rule_id, rule_name: d.rule_name, dimension: d.dimension, severity: d.severity,
      classification: d.classification, confidence: d.confidence, points, evidence: d.evidence.slice(0, 3), timestamp: d.timestamp,
    });
  }
  factors.sort((a, b) => b.points - a.points);
  const combine = (xs: number[]) => Math.min(100, Math.round(xs.reduce((acc, p, i) => acc + p * DECAY ** i, 0)));
  const dimensions = Object.fromEntries(RISK_DIMENSIONS.map((dim) => [dim, combine(factors.filter((f) => f.dimension === dim).map((f) => f.points))])) as Record<RiskDimension, number>;
  const score = combine(factors.map((f) => f.points));
  return { score, level: levelFor(score, thresholds), dimensions, factors: factors.slice(0, 50), formula: 'Σ points_i × 0.7^rank, points = severity × confidence × class weight, repeats at 25%' };
}

export function levelFor(score: number, t: Config['risk']['thresholds']): RiskExplanation['level'] {
  if (score >= t.critical) return 'critical';
  if (score >= t.high) return 'high';
  if (score >= t.medium) return 'medium';
  if (score >= t.low) return 'low';
  return 'none';
}
