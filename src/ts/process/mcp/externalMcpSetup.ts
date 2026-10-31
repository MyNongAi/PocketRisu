// How each MCP app is pointed at the PocketRisu MCP server (externalBridge.ts),
// shown on its settings page to copy: the command or the config entry, with
// this server's address and token in it.

export interface McpSetup {
    id: 'claude-code' | 'codex' | 'gemini' | 'antigravity' | 'claude-desktop'
    name: string
    /** Where it goes: a terminal, or the config file. */
    where: string
    text: string
}

const SERVER_NAME = 'pocketrisu'

function json(value: unknown): string {
    return JSON.stringify(value, null, 2)
}

export function mcpClientSetups(address: string, token: string, stdioScript?: string): McpSetup[] {
    const bearer = `Bearer ${token}`
    return [
        {
            id: 'claude-code',
            name: 'Claude Code',
            where: 'terminal',
            text: `claude mcp add --transport http --scope user ${SERVER_NAME} ${address} --header "Authorization: ${bearer}"`,
        },
        {
            id: 'codex',
            name: 'Codex',
            where: '~/.codex/config.toml',
            text: [
                `[mcp_servers.${SERVER_NAME}]`,
                `url = "${address}"`,
                `http_headers = { "Authorization" = "${bearer}" }`,
                'tool_timeout_sec = 600',
            ].join('\n'),
        },
        {
            id: 'gemini',
            name: 'Gemini CLI',
            where: '~/.gemini/settings.json',
            text: json({ mcpServers: { [SERVER_NAME]: { httpUrl: address, headers: { Authorization: bearer }, timeout: 600000 } } }),
        },
        {
            id: 'antigravity',
            name: 'Antigravity',
            where: 'mcp_config.json',
            text: json({ mcpServers: { [SERVER_NAME]: { serverUrl: address, headers: { Authorization: bearer } } } }),
        },
        {
            id: 'claude-desktop',
            name: 'Claude Desktop',
            where: 'claude_desktop_config.json',
            text: json({
                mcpServers: {
                    [SERVER_NAME]: {
                        command: 'node',
                        args: [stdioScript || 'mcp-stdio.cjs', address],
                        env: { POCKETRISU_MCP_TOKEN: token },
                    },
                },
            }),
        },
    ]
}
