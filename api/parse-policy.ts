import { parseWithGemini } from '../server/geminiPolicyApi.ts'

const maxPolicyLength = 4000

export default async function handler(request: Request): Promise<Response> {
  if (request.method !== 'POST') return Response.json({ error: 'Only POST is supported.' }, { status: 405 })
  try {
    const body = await request.json() as { text?: unknown }
    if (typeof body.text !== 'string' || !body.text.trim() || body.text.length > maxPolicyLength) {
      return Response.json({ error: 'Enter a policy between 1 and 4,000 characters.' }, { status: 400 })
    }
    const structured = await parseWithGemini(body.text, process.env.GEMINI_API_KEY, process.env.GEMINI_MODEL || 'gemini-3.7-flash')
    return Response.json({ structured, source: 'gemini' })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Gemini could not parse that policy.'
    const status = message.includes('not configured') ? 503 : message.includes('too large') ? 413 : 502
    return Response.json({ error: message }, { status })
  }
}
