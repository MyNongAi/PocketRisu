import { describe, expect, it } from 'vitest'
import { mcpClientSetups } from './externalMcpSetup'

describe('how each MCP app is pointed at PocketRisu', () => {
    const setups = mcpClientSetups('http://127.0.0.1:6001/mcp', 'prmcp_T', 'C:\pr\server\node\mcp-stdio.cjs')
    const byId = Object.fromEntries(setups.map((setup) => [setup.id, setup]))

    it('carries the address and the token in every app', () => {
        expect(setups.map((setup) => setup.id)).toEqual(['claude-code', 'codex', 'gemini', 'antigravity', 'claude-desktop'])
        for (const setup of setups) {
            expect(setup.text).toContain('http://127.0.0.1:6001/mcp')
            expect(setup.text).toContain('prmcp_T')
        }
        expect(byId['claude-code'].text).toBe('claude mcp add --transport http --scope user pocketrisu http://127.0.0.1:6001/mcp --header "Authorization: Bearer prmcp_T"')
    })

    it('uses each config file\'s own keys', () => {
        expect(byId.codex.text).toContain('url = "http://127.0.0.1:6001/mcp"')
        expect(byId.codex.text).toContain('tool_timeout_sec = 600')
        expect(JSON.parse(byId.gemini.text).mcpServers.pocketrisu).toEqual({ httpUrl: 'http://127.0.0.1:6001/mcp', headers: { Authorization: 'Bearer prmcp_T' }, timeout: 600000 })
        expect(JSON.parse(byId.antigravity.text).mcpServers.pocketrisu).toEqual({ serverUrl: 'http://127.0.0.1:6001/mcp', headers: { Authorization: 'Bearer prmcp_T' } })
        expect(JSON.parse(byId['claude-desktop'].text).mcpServers.pocketrisu).toEqual({
            command: 'node',
            args: ['C:\pr\server\node\mcp-stdio.cjs', 'http://127.0.0.1:6001/mcp'],
            env: { POCKETRISU_MCP_TOKEN: 'prmcp_T' },
        })
    })
})
