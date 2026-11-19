// Cloudflare Worker version of server.mjs: the same relay protocol, run on
// Cloudflare's network instead of Google Cloud Run, so Gemini requests leave
// from a Cloudflare address. wrangler.toml pins it near a cloud region.
//
//   OPTIONS *        CORS preflight, no key
//   GET /health      { ok, colo } (the Cloudflare data center it runs in), no key
//   anything else    x-relay-key must equal the RELAY_KEY secret (401), and
//                    x-relay-target must be a Gemini host (403); the request is
//                    forwarded there and the answer streamed back.

const DROP_REQUEST_HEADERS = new Set([
  'host', 'connection', 'content-length', 'transfer-encoding', 'origin',
  'referer', 'cookie', 'x-relay-key', 'x-relay-target', 'forwarded',
  'x-cloud-trace-context', 'traceparent', 'keep-alive', 'proxy-authenticate',
  'proxy-authorization', 'te', 'trailer', 'upgrade', 'accept-encoding',
  // Cloudflare adds these to the incoming request; they carry the caller's
  // address and must not reach Google.
  'x-real-ip', 'true-client-ip',
])
const DROP_RESPONSE_HEADERS = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
])

export function allowedTarget(raw) {
  try {
    const url = new URL(raw)
    return url.protocol === 'https:' && !url.username && !url.password && !url.port && (
      url.hostname === 'aiplatform.googleapis.com' ||
      /^[a-z0-9-]+-aiplatform\.googleapis\.com$/.test(url.hostname) ||
      url.hostname === 'generativelanguage.googleapis.com'
    ) ? url : null
  } catch { return null }
}

async function sameKey(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string') return false
  const digest = async (value) => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))
  const [a, b] = await Promise.all([digest(actual), digest(expected)])
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]
  return diff === 0
}

function withCors(headers, request) {
  headers.set('Access-Control-Allow-Origin', request.headers.get('origin') || '*')
  headers.set('Access-Control-Expose-Headers', '*')
  headers.append('Vary', 'Origin')
  return headers
}

function plain(status, text, request) {
  return new Response(text, { status, headers: withCors(new Headers({ 'content-type': 'text/plain' }), request) })
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: withCors(new Headers({
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': request.headers.get('access-control-request-headers') || '',
          'Access-Control-Max-Age': '3600',
        }), request),
      })
    }
    const url = new URL(request.url)
    if (request.method === 'GET' && url.pathname === '/health') {
      return new Response(JSON.stringify({ ok: true, colo: request.cf?.colo ?? '' }), {
        headers: withCors(new Headers({ 'content-type': 'application/json' }), request),
      })
    }
    const key = env?.RELAY_KEY
    if (typeof key !== 'string' || key.length < 16) return plain(500, 'relay key not configured', request)
    if (!await sameKey(request.headers.get('x-relay-key'), key)) return plain(401, 'unauthorized', request)
    const target = allowedTarget(request.headers.get('x-relay-target'))
    if (!target) return plain(403, 'forbidden target', request)

    const started = Date.now()
    const headers = new Headers()
    for (const [name, value] of request.headers) {
      const lower = name.toLowerCase()
      if (DROP_REQUEST_HEADERS.has(lower) || lower.startsWith('x-forwarded-') || lower.startsWith('cf-')) continue
      headers.append(name, value)
    }
    let upstream
    try {
      upstream = await fetch(target.href, {
        method: request.method,
        headers,
        body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
        redirect: 'manual',
      })
    } catch {
      console.log(`${request.method} ${target.hostname} 502 ${Date.now() - started}ms`)
      return plain(502, 'upstream error', request)
    }
    console.log(`${request.method} ${target.hostname} ${upstream.status} ${Date.now() - started}ms`)
    const out = new Headers()
    for (const [name, value] of upstream.headers) {
      if (!DROP_RESPONSE_HEADERS.has(name.toLowerCase())) out.append(name, value)
    }
    return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: withCors(out, request) })
  },
}
