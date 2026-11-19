import { createServer } from 'node:http'
import { createHash, timingSafeEqual } from 'node:crypto'
import { Readable } from 'node:stream'
import { pathToFileURL } from 'node:url'

const forbiddenHeaders = new Set([
  'host', 'connection', 'content-length', 'transfer-encoding', 'origin',
  'referer', 'cookie', 'x-relay-key', 'x-relay-target', 'forwarded',
  'x-cloud-trace-context', 'traceparent', 'keep-alive', 'proxy-authenticate',
  'proxy-authorization', 'te', 'trailer', 'upgrade',
  // The browser's list (zstd among them) may name codings Node's fetch cannot
  // decode; fetch asks for its own and decodes, and content-encoding is dropped below.
  'accept-encoding',
])
const responseHopHeaders = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'content-encoding', 'content-length',
])

function allowedTarget(raw) {
  try {
    const url = new URL(raw)
    return url.protocol === 'https:' && !url.username && !url.password && !url.port && (
      url.hostname === 'aiplatform.googleapis.com' ||
      /^[a-z0-9-]+-aiplatform\.googleapis\.com$/.test(url.hostname) ||
      url.hostname === 'generativelanguage.googleapis.com'
    ) ? url : null
  } catch { return null }
}

function sameKey(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string') return false
  const digest = value => createHash('sha256').update(value).digest()
  return timingSafeEqual(digest(actual), digest(expected))
}

function cors(req, res) {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*')
}

export function createRelayHandler({ key, fetchImpl = fetch, region = '' }) {
  return async (req, res) => {
    cors(req, res)
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', req.headers['access-control-request-headers'] || '')
      res.setHeader('Access-Control-Max-Age', '3600')
      res.writeHead(204).end()
      return
    }
    if (req.method === 'GET' && req.url === '/health') {
      res.setHeader('Content-Type', 'application/json')
      res.writeHead(200).end(JSON.stringify({ ok: true, region }))
      return
    }
    if (typeof key !== 'string' || key.length < 16) {
      res.writeHead(500).end('relay key not configured')
      return
    }
    if (!sameKey(req.headers['x-relay-key'], key)) {
      res.writeHead(401).end('unauthorized')
      return
    }
    const target = allowedTarget(req.headers['x-relay-target'])
    if (!target) {
      res.writeHead(403).end('forbidden target')
      return
    }

    const started = Date.now()
    let status = 502
    const controller = new AbortController()
    res.on('close', () => { if (!res.writableFinished) controller.abort() })
    try {
      const headers = new Headers()
      const connectionHeaders = new Set(String(req.headers.connection || '').toLowerCase().split(',').map(x => x.trim()))
      for (const [name, value] of Object.entries(req.headers)) {
        const lower = name.toLowerCase()
        if (forbiddenHeaders.has(lower) || connectionHeaders.has(lower) || lower.startsWith('x-forwarded-')) continue
        if (Array.isArray(value)) value.forEach(v => headers.append(name, v))
        else if (value !== undefined) headers.set(name, value)
      }
      const chunks = []
      if (req.method !== 'GET') for await (const chunk of req) chunks.push(chunk)
      const upstream = await fetchImpl(target.href, {
        method: req.method, headers,
        body: req.method === 'GET' ? undefined : Buffer.concat(chunks),
        redirect: 'manual', signal: controller.signal,
      })
      status = upstream.status
      const upstreamConnectionHeaders = new Set(String(upstream.headers.get('connection') || '').toLowerCase().split(',').map(x => x.trim()))
      for (const [name, value] of upstream.headers) {
        const lower = name.toLowerCase()
        if (responseHopHeaders.has(lower) || upstreamConnectionHeaders.has(lower)) continue
        res.setHeader(name, value)
      }
      cors(req, res)
      res.setHeader('Access-Control-Expose-Headers', '*')
      res.writeHead(status)
      if (upstream.body) {
        const stream = Readable.fromWeb(upstream.body)
        stream.on('error', () => res.destroy())
        stream.pipe(res)
      } else res.end()
    } catch {
      if (!res.headersSent && !res.destroyed) res.writeHead(502).end('upstream error')
    } finally {
      console.log(`${req.method} ${target.hostname} ${status} ${Date.now() - started}ms`)
    }
  }
}

async function metadataRegion() {
  try {
    const response = await fetch('http://metadata.google.internal/computeMetadata/v1/instance/region', {
      headers: { 'Metadata-Flavor': 'Google' }, signal: AbortSignal.timeout(1000),
    })
    if (!response.ok) return ''
    return (await response.text()).trim().split('/').at(-1) || ''
  } catch { return '' }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const region = await metadataRegion()
  createServer(createRelayHandler({ key: process.env.RELAY_KEY, region }))
    .listen(Number(process.env.PORT) || 8080)
}
