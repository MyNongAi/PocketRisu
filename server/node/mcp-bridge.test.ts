import { EventEmitter } from 'node:events'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { createMcpBridge, TOKEN_FILE } = require('./mcp-bridge.cjs')

class FakeStream extends EventEmitter {
    chunks: string[] = []
    statusCode = 0
    ended = false
    writeHead(status: number) {
        this.statusCode = status
    }
    flushHeaders() {}
    write(chunk: string) {
        this.chunks.push(chunk)
        return true
    }
    end() {
        this.ended = true
    }
    status(code: number) {
        this.statusCode = code
        return this
    }
    send() {
        return this
    }
    calls() {
        return this.chunks.join('').split('\n\n').flatMap((frame) => {
            if (!/^event: call$/m.test(frame)) return []
            return [JSON.parse(/^data: (.+)$/m.exec(frame)![1])]
        })
    }
}

class FakeReply {
    statusCode = 200
    body: any = undefined
    headers: Record<string, string> = {}
    status(code: number) {
        this.statusCode = code
        return this
    }
    set(name: string, value: string) {
        this.headers[name] = value
        return this
    }
    send(body: any) {
        this.body = body
        return this
    }
    end() {
        return this
    }
}

const dirs: string[] = []
function freshDir() {
    const dir = mkdtempSync(path.join(tmpdir(), 'mcp-bridge-'))
    dirs.push(dir)
    return dir
}
afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function bridgeOn(options: Record<string, unknown> = {}) {
    let clock = 1000
    const bridge = createMcpBridge({ dir: freshDir(), logger: { info() {} }, heartbeatMs: 60_000, now: () => clock, ...options })
    const token = bridge.enable()
    return { bridge, token, tick: (ms = 1) => { clock += ms } }
}

async function post(bridge: any, token: string | null, body: unknown) {
    const reply = new FakeReply()
    await bridge.handleHttp({ headers: token ? { authorization: `Bearer ${token}` } : {}, body }, reply)
    return reply
}

/** Let the bridge write its event before the page answers. */
const turn = () => new Promise((resolve) => setImmediate(resolve))

describe('the PocketRisu MCP server', () => {
    it('is off without a token file, and keeps the token out of the database', () => {
        const dir = freshDir()
        const bridge = createMcpBridge({ dir, logger: { info() {} } })
        expect(bridge.status('').enabled).toBe(false)
        const token = bridge.enable()
        expect(token).toMatch(/^prmcp_[A-Za-z0-9_-]{43}$/)
        expect(readFileSync(path.join(dir, TOKEN_FILE), 'utf-8')).toBe(token)
        // A restarted server keeps it.
        expect(createMcpBridge({ dir, logger: { info() {} } }).status('').token).toBe(token)
        bridge.disable()
        expect(existsSync(path.join(dir, TOKEN_FILE))).toBe(false)
    })

    it('answers nobody without the token', async () => {
        const { bridge, token } = bridgeOn()
        expect((await post(bridge, null, { jsonrpc: '2.0', id: 1, method: 'ping' })).statusCode).toBe(401)
        expect((await post(bridge, `${token}x`, { jsonrpc: '2.0', id: 1, method: 'ping' })).statusCode).toBe(401)
        expect((await post(bridge, token, { jsonrpc: '2.0', id: 1, method: 'ping' })).body).toEqual({ jsonrpc: '2.0', id: 1, result: {} })
        bridge.disable()
        expect((await post(bridge, token, { jsonrpc: '2.0', id: 1, method: 'ping' })).statusCode).toBe(404)
    })

    it('initializes without a page and acknowledges notifications', async () => {
        const { bridge, token } = bridgeOn()
        const init = await post(bridge, token, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } })
        expect(init.body.result).toMatchObject({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'PocketRisu' } })
        const unknown = await post(bridge, token, { jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } })
        expect(unknown.body.result.protocolVersion).toBe('2025-11-25')
        const note = await post(bridge, token, { jsonrpc: '2.0', method: 'notifications/initialized' })
        expect(note.statusCode).toBe(202)
        expect((await post(bridge, token, { jsonrpc: '2.0', id: 3, method: 'resources/list' })).body.error.code).toBe(-32601)
    })

    it('passes a call to the page used last and its answer back', async () => {
        const { bridge, token, tick } = bridgeOn()
        const phone = new FakeStream()
        const pc = new FakeStream()
        bridge.attach(phone, 'phone')
        bridge.attach(pc, 'pc')
        tick()
        bridge.markActive('phone')
        tick()
        bridge.markActive('pc')
        expect(bridge.status('pc')).toMatchObject({ receiving: true, pages: 2 })
        expect(bridge.status('phone').receiving).toBe(false)

        const answer = post(bridge, token, { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'risu-list-modules', arguments: { count: 3 } } })
        await turn()
        expect(phone.calls()).toEqual([])
        const [call] = pc.calls()
        expect(call).toMatchObject({ kind: 'call', name: 'risu-list-modules', arguments: { count: 3 } })
        // Only the page asked can answer.
        expect(bridge.settle('phone', { id: call.id, result: { content: [] } })).toBe(false)
        expect(bridge.settle('pc', { id: call.id, result: { content: [{ type: 'text', text: 'ok' }] } })).toBe(true)
        expect((await answer).body).toEqual({ jsonrpc: '2.0', id: 7, result: { content: [{ type: 'text', text: 'ok' }], isError: false } })
    })

    it('lists the tools the page offers, and the last list when no page is open', async () => {
        const { bridge, token } = bridgeOn()
        expect((await post(bridge, token, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).body.error.message).toMatch(/No PocketRisu page/)
        const page = new FakeStream()
        bridge.attach(page, 'p')
        const listed = post(bridge, token, { jsonrpc: '2.0', id: 2, method: 'tools/list' })
        await turn()
        const [call] = page.calls()
        expect(call.kind).toBe('list')
        bridge.settle('p', { id: call.id, result: { tools: [{ name: 'risu-list-modules', inputSchema: { type: 'object' } }], instructions: 'Risu' } })
        expect((await listed).body.result.tools.map((tool: any) => tool.name)).toEqual(['risu-list-modules'])
        page.emit('close')
        expect((await post(bridge, token, { jsonrpc: '2.0', id: 3, method: 'tools/list' })).body.result.tools).toHaveLength(1)
        expect((await post(bridge, token, { jsonrpc: '2.0', id: 4, method: 'initialize', params: {} })).body.result.instructions).toBe('Risu')
    })

    it('tells the client when no page is open, the page closes or it does not answer', async () => {
        const { bridge, token } = bridgeOn({ callTimeoutMs: 20 })
        const none = await post(bridge, token, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'x' } })
        expect(none.body.result).toMatchObject({ isError: true })
        expect(none.body.result.content[0].text).toMatch(/No PocketRisu page/)

        const page = new FakeStream()
        bridge.attach(page, 'p')
        const closing = post(bridge, token, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'x' } })
        await turn()
        page.emit('close')
        expect((await closing).body.result.content[0].text).toMatch(/closed/)

        bridge.attach(new FakeStream(), 'q')
        const late = await post(bridge, token, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'x' } })
        expect(late.body.result.content[0].text).toMatch(/did not answer/)
    })

    it('answers a batch, and turning off drops the pages', async () => {
        const { bridge, token } = bridgeOn()
        const batch = await post(bridge, token, [
            { jsonrpc: '2.0', id: 1, method: 'ping' },
            { jsonrpc: '2.0', method: 'notifications/initialized' },
        ])
        expect(batch.body).toEqual([{ jsonrpc: '2.0', id: 1, result: {} }])
        const page = new FakeStream()
        bridge.attach(page, 'p')
        bridge.disable()
        expect(page.ended).toBe(true)
        expect(bridge.pageCount).toBe(0)
    })

    it('carries a stdio client through the relay script', async () => {
        const { bridge, token } = bridgeOn()
        const server = createServer((req, res) => {
            let raw = ''
            req.on('data', (chunk) => { raw += chunk })
            req.on('end', () => {
                const reply = new FakeReply()
                void bridge.handleHttp({ headers: req.headers, body: JSON.parse(raw) }, reply).then(() => {
                    res.statusCode = reply.statusCode
                    res.end(reply.body === undefined ? '' : JSON.stringify(reply.body))
                })
            })
        })
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
        const port = (server.address() as any).port
        try {
            const child = spawn(process.execPath, [path.join(__dirname, 'mcp-stdio.cjs'), `http://127.0.0.1:${port}/mcp`], {
                env: { ...process.env, POCKETRISU_MCP_TOKEN: token },
            })
            let out = ''
            child.stdout.on('data', (chunk) => { out += chunk })
            child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
            child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'ping' })}\n`)
            for (let i = 0; i < 100 && !out.includes('\n'); i++) await new Promise((resolve) => setTimeout(resolve, 20))
            child.kill()
            expect(out.trim().split('\n').map((line) => JSON.parse(line))).toEqual([{ jsonrpc: '2.0', id: 9, result: {} }])
        } finally {
            server.close()
        }
    })
})
