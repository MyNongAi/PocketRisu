#!/usr/bin/env node
'use strict';

// The PocketRisu MCP server (mcp-bridge.cjs) for a client that only starts
// local programs, such as Claude Desktop: JSON-RPC lines on stdin go to the
// server's /mcp, its answers come back on stdout.
//
//   node mcp-stdio.cjs http://127.0.0.1:6001/mcp
//   with the token in POCKETRISU_MCP_TOKEN

const readline = require('node:readline');

const url = process.argv[2];
const token = process.env.POCKETRISU_MCP_TOKEN;
if (!url || !token) {
    process.stderr.write('usage: POCKETRISU_MCP_TOKEN=<token> node mcp-stdio.cjs <PocketRisu address>/mcp\n');
    process.exit(2);
}

function reply(message) {
    process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function forward(line) {
    let message;
    try {
        message = JSON.parse(line);
    } catch {
        reply({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
        return;
    }
    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                accept: 'application/json, text/event-stream',
                authorization: `Bearer ${token}`,
            },
            body: JSON.stringify(message),
        });
        if (res.status === 202) return;
        const text = await res.text();
        if (!res.ok) throw new Error(`PocketRisu answered ${res.status}: ${text.slice(0, 200)}`);
        const answer = JSON.parse(text);
        for (const item of Array.isArray(answer) ? answer : [answer]) reply(item);
    } catch (error) {
        if (message && message.id !== undefined && message.id !== null) {
            reply({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: String(error.message ?? error) } });
        }
        process.stderr.write(`[pocketrisu-mcp] ${error.message ?? error}\n`);
    }
}

const lines = readline.createInterface({ input: process.stdin });
lines.on('line', (line) => {
    if (line.trim()) void forward(line);
});
