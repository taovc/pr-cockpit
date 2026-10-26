import { z } from 'zod'
import { schema } from '~core/db/client'
import { setAgentSettings } from '~core/agent/settings'

const Body = z.object({ chrome: z.boolean().optional() })

// Global agent switch: Claude in Chrome for sessions.
export default defineEventHandler(async (event) => {
  const body = Body.parse((await readBody(event)) || {})
  return setAgentSettings(db(), schema, body)
})
