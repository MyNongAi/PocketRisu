'use strict';

// Live change feed for other devices (server-sent events).
//
// Every accepted write is published here with a sequence number: a database
// patch carries its ops and the hash before/after, a chat body carries its
// new ETag. Clients apply what they can and fall back to the existing
// conflict/rebase path for anything else, so a missed or skipped event never
// costs data, only freshness.
//
// Recent events are kept in memory so a phone that dozed off can resume from
// the last sequence it saw. A server restart starts a new instance id; a
// client that reconnects with an old id, or a sequence older than the buffer,
// is told to resync instead of being replayed a partial history.

const { randomUUID } = require('node:crypto');

const DEFAULTS = {
    maxEvents: 2000,
    maxBufferBytes: 32 * 1024 * 1024,
    // A single event bigger than this is not worth streaming: the receiver
    // would spend as long applying it as a resync costs. It becomes 'db-stale'.
    maxEventBytes: 8 * 1024 * 1024,
    // A client that stops reading (a phone behind a flaky link) must not make
    // the server buffer without bound. It is dropped and resumes on reconnect.
    maxClientBacklogBytes: 64 * 1024 * 1024,
    heartbeatMs: 20_000,
};

function createSyncHub(options = {}) {
    const config = { ...DEFAULTS, ...options };
    const instanceId = config.instanceId || randomUUID();
    const buffer = []; // { seq, type, frame, bytes }
    let bufferBytes = 0;
    let seq = 0;
    const clients = new Set();

    function frameOf(event) {
        // JSON.stringify never emits a raw newline, so one data line suffices.
        return `id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
    }

    function remember(entry) {
        buffer.push(entry);
        bufferBytes += entry.bytes;
        while (buffer.length > config.maxEvents || (bufferBytes > config.maxBufferBytes && buffer.length > 1)) {
            const dropped = buffer.shift();
            bufferBytes -= dropped.bytes;
        }
    }

    function send(client, frame) {
        if (client.closed) return;
        try {
            client.res.write(frame);
            if (client.res.writableLength > config.maxClientBacklogBytes) {
                drop(client);
            }
        } catch {
            drop(client);
        }
    }

    function drop(client) {
        if (client.closed) return;
        client.closed = true;
        clients.delete(client);
        clearInterval(client.heartbeat);
        try { client.res.end(); } catch { /* already gone */ }
    }

    /**
     * Publish one change. `payload.type` picks the event name; an oversized
     * db-patch is downgraded to db-stale so receivers resync on their own.
     */
    function publish(payload) {
        if (!payload || typeof payload.type !== 'string') return null;
        let event = { ...payload, seq: seq + 1, at: Date.now() };
        let frame = frameOf(event);
        if (Buffer.byteLength(frame) > config.maxEventBytes) {
            event = {
                type: 'db-stale',
                seq: event.seq,
                at: event.at,
                origin: payload.origin ?? '',
                reason: 'too-large',
                nextHash: payload.nextHash,
            };
            frame = frameOf(event);
        }
        seq = event.seq;
        remember({ seq, type: event.type, frame, bytes: Buffer.byteLength(frame) });
        for (const client of clients) send(client, frame);
        return event;
    }

    /**
     * Attach an HTTP response as a live subscriber. `since` and `instance`
     * come from the client's last hello; anything the buffer still holds after
     * `since` is replayed before live events.
     */
    function subscribe(res, { since, instance } = {}) {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            'Connection': 'keep-alive',
            // Reverse proxies (nginx, and Tailscale Serve in front of phones)
            // must pass each event through instead of buffering the stream.
            'X-Accel-Buffering': 'no',
        });
        if (typeof res.flushHeaders === 'function') res.flushHeaders();

        const client = { res, closed: false, heartbeat: null };
        send(client, `retry: 3000\n\n`);

        const sinceSeq = Number.isInteger(since) ? since : null;
        const oldest = buffer.length > 0 ? buffer[0].seq : seq + 1;
        const sameInstance = instance === instanceId;
        let resync = false;
        if (sinceSeq !== null) {
            if (!sameInstance || sinceSeq > seq || sinceSeq < oldest - 1) {
                resync = true;
            }
        }

        send(client, `event: hello\ndata: ${JSON.stringify({ instanceId, seq, resync })}\n\n`);
        if (sinceSeq !== null && !resync) {
            for (const entry of buffer) {
                if (entry.seq > sinceSeq) send(client, entry.frame);
            }
        }

        if (client.closed) return client;
        clients.add(client);
        client.heartbeat = setInterval(() => send(client, `: ping\n\n`), config.heartbeatMs);
        if (typeof client.heartbeat.unref === 'function') client.heartbeat.unref();
        res.on('close', () => drop(client));
        return client;
    }

    return {
        instanceId,
        publish,
        subscribe,
        get seq() { return seq; },
        get clientCount() { return clients.size; },
        closeAll() { for (const client of [...clients]) drop(client); },
    };
}

module.exports = { createSyncHub };
