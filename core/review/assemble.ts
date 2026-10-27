import type { EngineFinding } from './engine'
import type { TierResult } from './agents'

// Rules applied in code after the tier pass: nothing is dropped, refuted findings are never tiered.

export type RawSource = 'engine' | 'context' | 'recheck'
export type RawFinding = { id: string; source: RawSource; file: string; line: number | null; title: string; scenario: string; preExisting: boolean }
export type Tier = 'must' | 'decide' | 'later' | 'edge'
export type VerdictValue = 'confirmed' | 'refuted' | 'unsure'

export type FindingRow = {
  severity: 'High' | 'Medium' | 'Low'
  title: string
  location: string | null
  problem: string | null
  detail: string | null
  fix: string | null
  introducedByPr: boolean
  tier: Tier | null
  evidence: 'inferred' | 'ci'
  source: RawSource | 'both'
  verifyStatus: VerdictValue
  verifyNote: string | null
}

export function fromEngine(list: EngineFinding[]): RawFinding[] {
  return list.map((f, i) => ({ id: `E${i + 1}`, source: 'engine', file: f.file, line: f.line ?? null, title: f.summary, scenario: f.failure_scenario, preExisting: false }))
}

export function fromContext(list: Array<{ file: string; line: number | null; title: string; consequence: string; preExisting: boolean }>): RawFinding[] {
  return list.map((f, i) => ({ id: `C${i + 1}`, source: 'context', file: f.file, line: f.line ?? null, title: f.title, scenario: f.consequence, preExisting: f.preExisting }))
}

const RANK: Record<VerdictValue, number> = { confirmed: 2, unsure: 1, refuted: 0 }
const TIER_ORDER: Array<Tier | null> = ['must', 'decide', 'later', 'edge', null]
const SEV_ORDER = { High: 0, Medium: 1, Low: 2 } as const

export function assembleFindings(raw: RawFinding[], verdicts: Map<string, { verdict: VerdictValue; reason: string }>, tier: TierResult): FindingRow[] {
  const byId = new Map(raw.map((f) => [f.id, f]))
  const used = new Set<string>()
  const rows: FindingRow[] = []
  const verdictOf = (id: string) => verdicts.get(id) ?? { verdict: 'unsure' as const, reason: '' }

  for (const item of tier.items) {
    const ids = item.ids.filter((id) => byId.has(id) && !used.has(id))
    if (!ids.length) continue
    ids.forEach((id) => used.add(id))
    const best = ids.map(verdictOf).sort((a, b) => RANK[b.verdict] - RANK[a.verdict])[0]!
    const sources = new Set(ids.map((id) => byId.get(id)!.source))
    rows.push({
      severity: item.severity, title: item.title, location: item.location || locationOf(byId.get(ids[0]!)!),
      problem: item.problem || null, detail: item.detail || null, fix: item.fix || null,
      introducedByPr: !item.preExisting, tier: best.verdict === 'refuted' ? null : (item.tier ?? 'later'), evidence: item.evidence,
      source: sources.size > 1 ? 'both' : [...sources][0]!, verifyStatus: best.verdict, verifyNote: best.reason || null,
    })
  }
  // Anything the tier pass left out is kept as written, never lost.
  for (const f of raw) {
    if (used.has(f.id)) continue
    const v = verdictOf(f.id)
    rows.push({
      severity: 'Medium', title: f.title, location: locationOf(f), problem: f.scenario || null, detail: null, fix: null,
      introducedByPr: !f.preExisting, tier: v.verdict === 'refuted' ? null : 'later', evidence: 'inferred', source: f.source,
      verifyStatus: v.verdict, verifyNote: v.reason || null,
    })
  }
  return rows.sort((a, b) => TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier) || SEV_ORDER[a.severity] - SEV_ORDER[b.severity])
}

function locationOf(f: RawFinding): string | null {
  return f.file ? `${f.file}${f.line ? `:${f.line}` : ''}` : null
}
