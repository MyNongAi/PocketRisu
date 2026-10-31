import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('src/ts/globalApi.svelte', () => ({ forageStorage: { createAuth: async () => 'jwt' } }))

const { EXTERNAL_TOOLS, answerCall, startMcpBridge } = await import('./externalBridge')

const risuAccessDir = path.join(__dirname, 'risuaccess')

function declaredTools(): string[] {
    const names: string[] = []
    for (const file of readdirSync(risuAccessDir)) {
        if (!file.endsWith('.ts') || file.endsWith('.test.ts')) continue
        for (const match of readFileSync(path.join(risuAccessDir, file), 'utf-8').matchAll(/name: '(risu-[a-z-]+)'/g)) names.push(match[1])
    }
    return names.sort()
}

describe('the tools PocketRisu offers MCP apps outside', () => {
    // A tool Risu Access gains (from upstream or ours) stays inside until it
    // is looked at and added to the list.
    it('are exactly the Risu Access tools looked at', () => {
        expect([...EXTERNAL_TOOLS].sort()).toEqual(declaredTools())
    })

    it('reach no prompt preset, template, memory prompt or model preset', () => {
        for (const name of EXTERNAL_TOOLS) expect(name).not.toMatch(/preset|prompt|template|toggle|hypa|memory|summar|model/)
    })

    it('leaves out a tool not on the list, and refuses to run it', async () => {
        const callTool = vi.fn(async () => [{ type: 'text' as const, text: 'ran' }])
        const host = {
            serverInfo: { instructions: 'Risu' },
            getToolList: async () => [
                { name: 'risu-list-modules', description: '', inputSchema: {} },
                { name: 'risu-get-prompt-preset', description: '', inputSchema: {} },
            ] as any,
            callTool,
        }
        expect(await answerCall(host, { id: '1', kind: 'list' })).toEqual({ tools: [{ name: 'risu-list-modules', description: '', inputSchema: {} }], instructions: 'Risu' })
        expect(await answerCall(host, { id: '2', kind: 'call', name: 'risu-get-prompt-preset' })).toMatchObject({ isError: true })
        expect(callTool).not.toHaveBeenCalled()
        expect(await answerCall(host, { id: '3', kind: 'call', name: 'risu-list-modules', arguments: { count: 2 } })).toEqual({ content: [{ type: 'text', text: 'ran' }] })
        expect(callTool).toHaveBeenCalledWith('risu-list-modules', { count: 2 })
    })
})

const jsonResponse = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })

function sse(frames: string[]) {
    const encoder = new TextEncoder()
    let push: (text: string) => void = () => {}
    const body = new ReadableStream<Uint8Array>({
        start(controller) {
            push = (text) => controller.enqueue(encoder.encode(text))
            for (const frame of frames) push(frame)
        },
    })
    return { response: new Response(body, { status: 200 }), push }
}

describe('a page taking the calls', () => {
    it('stays quiet while the server is off, connects when woken, and answers one call at a time', async () => {
        let enabled = false
        const results: any[] = []
        let stream: ReturnType<typeof sse> | null = null
        let release: () => void = () => {}
        const fetch = vi.fn(async (url: string, init?: RequestInit) => {
            if (url.startsWith('/api/mcp/status')) return jsonResponse({ enabled })
            if (url.startsWith('/api/mcp/bridge?')) {
                stream = sse(['event: hello\ndata: {}\n\n'])
                return stream.response
            }
            if (url === '/api/mcp/bridge/result') results.push(JSON.parse(String(init?.body)))
            return jsonResponse({ ok: true })
        })
        const order: string[] = []
        const host = {
            serverInfo: {},
            getToolList: async () => [],
            callTool: async (name: string) => {
                order.push(`start ${name}`)
                if (name === 'risu-set-module-info') await new Promise<void>((resolve) => { release = resolve })
                order.push(`end ${name}`)
                return [{ type: 'text' as const, text: name }]
            },
        }
        const bridge = startMcpBridge({ fetch, host: async () => host, pageId: 'page-1', wait: async () => {} })
        await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
        await new Promise((resolve) => setTimeout(resolve, 10))
        expect(fetch).toHaveBeenCalledTimes(1)

        enabled = true
        bridge.wake()
        await vi.waitFor(() => expect(stream).not.toBeNull())
        stream!.push(`event: call\ndata: ${JSON.stringify({ id: 'a', kind: 'call', name: 'risu-set-module-info' })}\n\n`)
        stream!.push(`event: call\ndata: ${JSON.stringify({ id: 'b', kind: 'call', name: 'risu-list-modules' })}\n\n`)
        await vi.waitFor(() => expect(order).toEqual(['start risu-set-module-info']))
        release()
        await vi.waitFor(() => expect(results).toHaveLength(2))
        expect(order).toEqual(['start risu-set-module-info', 'end risu-set-module-info', 'start risu-list-modules', 'end risu-list-modules'])
        expect(results).toEqual([
            { page: 'page-1', id: 'a', result: { content: [{ type: 'text', text: 'risu-set-module-info' }] } },
            { page: 'page-1', id: 'b', result: { content: [{ type: 'text', text: 'risu-list-modules' }] } },
        ])
        expect(fetch.mock.calls.some(([url]) => url === '/api/mcp/bridge/active')).toBe(true)
        bridge.stop()
    })
})
