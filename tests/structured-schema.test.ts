import assert from 'node:assert/strict'
import { z } from 'zod'
import { jsonSchemaFor } from '../core/agent/structured'
import { EngineResultSchema } from '../core/review/engine'
import { ContextFindingSchema, TierResultSchema, VerdictSchema } from '../core/review/agents'
import { ReviewResultSchema } from '../core/agent/review'
import { RecheckSchema } from '../core/agent/recheck'
import { VerifyResultSchema } from '../core/agent/verify'

// jsonSchemaFor feeds the CLI's outputFormat (the CLI validates the final message against it). A zod upgrade can change
// how a type is written out; the shapes below pin what the model is asked for, so a bump that changes them fails here.

const TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'])

// One line per schema: {key: shape} with ? for optional keys, [item], a|b for enums, T|null for nullable.
function shape(n: any, where: string): string {
  assert.equal(n.$schema, undefined, `${where}: no $schema (the CLI takes a bare schema)`)
  for (const t of [n.type].flat().filter(Boolean)) assert.ok(TYPES.has(t), `${where}: unknown type ${t}`)
  if (n.anyOf) return n.anyOf.map((x: any, i: number) => shape(x, `${where}|${i}`)).join('|')
  if (n.enum) return n.enum.join('|')
  if (Array.isArray(n.type)) return n.type.join('|')
  if (n.type === 'array') return `[${shape(n.items, `${where}[]`)}]`
  if (n.type === 'object') {
    assert.equal(n.additionalProperties, false, `${where}: objects are closed`)
    const req = new Set<string>(n.required ?? [])
    for (const r of req) assert.ok(r in n.properties, `${where}: required ${r} is a property`)
    return `{${Object.entries<any>(n.properties).map(([k, v]) => `${k}${req.has(k) ? '' : '?'}:${shape(v, `${where}.${k}`)}`).join(',')}}`
  }
  return n.type
}

const snap = (s: z.ZodType) => shape(jsonSchemaFor(s), 'root')

assert.equal(snap(EngineResultSchema), '{findings:[{file:string,line:integer|null,summary:string,failure_scenario:string,label:important|pre-existing|nit|null,suggested_fix:string}]}')
assert.equal(snap(z.object({ findings: z.array(ContextFindingSchema) })), '{findings:[{file:string,line:integer|null,title:string,consequence:string,lens:string,preExisting:boolean}]}')
assert.equal(snap(z.object({ verdicts: z.array(VerdictSchema) })), '{verdicts:[{id:string,verdict:confirmed|refuted|unsure,reason:string}]}')
assert.equal(snap(TierResultSchema), '{conclusion:string,notDone:string,reviewMdSuggestion:string,items:[{ids:[string],tier:must|decide|later|edge|null,severity:High|Medium|Low,evidence:inferred|ci,preExisting:boolean,location:string,title:string,problem:string,detail:string,fix:string}]}')
assert.equal(snap(VerifyResultSchema), '{verdicts:[{fid:string,verdict:confirmed|refuted|unsure,reason:string}]}')
assert.equal(snap(ReviewResultSchema), '{findings:[{severity:High|Medium|Low,title:string,location:string,problem:string,detail:string,fix:string,introducedByPr:boolean}],logic:string,quality:string,risk:string,conclusion:string,requirement:string,testPath:string}')
// Only the recheck has optional keys (an adjusted finding's new wording); its Codex twin is hand-written with nulls.
assert.equal(snap(RecheckSchema), '{rechecks:[{fid:string,status:fixed|partial|unaddressed|replied|new,stance:kept|retracted|adjusted|discuss,stanceReason?:string,severity?:High|Medium|Low,title?:string,location?:string,problem?:string,detail?:string,fix?:string,text:string}],newFindings:[{severity:High|Medium|Low,title:string,location:string,problem:string,detail:string,fix:string,text:string}],conclusion:string}')

// Every other schema is strict-mode shaped (closed objects, every key required), the form Codex's outputSchema also accepts.
for (const s of [EngineResultSchema, TierResultSchema, VerifyResultSchema, ReviewResultSchema]) assert.ok(!snap(s).includes('?'))

// zod 4.6 writes a nullable primitive as a type list; both forms are plain JSON Schema.
assert.deepEqual(jsonSchemaFor(z.object({ a: z.string().nullable() })).properties, { a: { type: ['string', 'null'] } })
assert.equal(shape(jsonSchemaFor(z.object({ a: z.string().nullable() })), 'root'), '{a:string|null}')

console.log('structured-schema: ok')
