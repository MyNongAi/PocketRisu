'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_FILE = path.resolve(__dirname, '../..', 'gemini-relay.local.json');

function createGeminiRelayDefaults({ filePath = DEFAULT_FILE, logger = console } = {}) {
    function readDefaults() {
        let source;
        try {
            source = fs.readFileSync(filePath, 'utf8');
        } catch (error) {
            if (error.code === 'ENOENT') return {};
            logger.warn('[gemini-relay-defaults] Could not read local defaults file');
            return {};
        }
        try {
            const value = JSON.parse(source);
            if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid shape');
            const result = {};
            for (const name of ['jpUrl', 'usUrl']) {
                if (value[name] === undefined) continue;
                if (typeof value[name] !== 'string') throw new Error('invalid URL');
                const url = new URL(value[name]);
                if (url.protocol !== 'https:') throw new Error('invalid URL');
                result[name] = value[name];
            }
            if (value.rotateUrls !== undefined) {
                if (!Array.isArray(value.rotateUrls)) throw new Error('invalid rotation URLs');
                for (const entry of value.rotateUrls) {
                    if (typeof entry !== 'string' || new URL(entry).protocol !== 'https:') {
                        throw new Error('invalid rotation URL');
                    }
                }
                result.rotateUrls = value.rotateUrls;
            }
            if (value.key !== undefined) {
                if (typeof value.key !== 'string' || value.key.length < 16) throw new Error('invalid key');
                result.key = value.key;
            }
            return result;
        } catch {
            logger.warn('[gemini-relay-defaults] Invalid local defaults file');
            return {};
        }
    }

    function registerRoutes(app, { auth } = {}) {
        app.get('/api/gemini-relay-defaults', async (req, res) => {
            res.set('Cache-Control', 'no-store');
            if (!await auth(req, res)) return;
            res.json(readDefaults());
        });
    }

    return { registerRoutes };
}

module.exports = { createGeminiRelayDefaults };
