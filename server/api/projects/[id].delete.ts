import { eq } from 'drizzle-orm'
import { schema } from '~core/db/client'
import { snapshotRatings } from '~core/review/store'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const d = db()
  d.transaction((tx: any) => {
    const reviewIds = (tx.select({ id: schema.reviews.id }).from(schema.reviews).where(eq(schema.reviews.projectId, id)).all() as any[]).map((r) => r.id)
    snapshotRatings(tx, schema, reviewIds, new Date().toISOString()) // ratings stay as eval labels; the reviews go with the project
    tx.delete(schema.projects).where(eq(schema.projects.id, id)).run()
  })
  return { ok: true }
})
