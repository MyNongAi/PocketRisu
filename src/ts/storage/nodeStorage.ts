import { language } from "src/lang"
import { alertError, alertInput, waitAlert } from "../alert"
import { base64url, getKeypairStore, saveKeypairStore } from "../util"


export class NodeStorage{

    authChecked = false
    JSONStringlifyAndbase64Url(obj:any){
        return base64url(Buffer.from(JSON.stringify(obj), 'utf-8'))
    }

    async createAuth(){
        const keyPair = await this.getKeyPair()
        const date = Math.floor(Date.now() / 1000)
        
        const header = {
            alg: "ES256",
            typ: "JWT",   
        }
        const payload = {
            iat: date,
            exp: date + 5 * 60, //5 minutes expiration
            pub: await crypto.subtle.exportKey('jwk', keyPair.publicKey)
        }
        const sig = await crypto.subtle.sign(
            {
                name: "ECDSA",
                hash: "SHA-256"
            },
            keyPair.privateKey,
            Buffer.from(
                this.JSONStringlifyAndbase64Url(header) + "." + this.JSONStringlifyAndbase64Url(payload)
            )
        )
        const sigString = base64url(new Uint8Array(sig))
        return this.JSONStringlifyAndbase64Url(header) + "." + this.JSONStringlifyAndbase64Url(payload) + "." + sigString
    }

    async getKeyPair():Promise<CryptoKeyPair>{
        
        const storedKey = await getKeypairStore('node')

        if(storedKey){
            return storedKey
        }

        const keyPair = await crypto.subtle.generateKey(
            {
                name: "ECDSA",
                namedCurve: "P-256"
            },
            false,
            ["sign", "verify"],
        );

        await saveKeypairStore('node', keyPair)

        return keyPair

    }

    async setItem(key:string, value:Uint8Array) {
        await this.checkAuth()
        const da = await fetch('/api/write', {
            method: "POST",
            body: value as any,
            headers: {
                'content-type': 'application/octet-stream',
                'file-path': Buffer.from(key, 'utf-8').toString('hex'),
                'risu-auth': await this.createAuth()
            }
        })
        if(da.status < 200 || da.status >= 300){
            throw "setItem Error"
        }
        const data = await da.json()
        if(data.error){
            throw data.error
        }
    }
    async getItem(key:string):Promise<Buffer> {
        await this.checkAuth()
        const da = await fetch('/api/read', {
            method: "GET",
            headers: {
                'file-path': Buffer.from(key, 'utf-8').toString('hex'),
                'risu-auth': await this.createAuth()
            }
        })
        if(da.status < 200 || da.status >= 300){
            throw "getItem Error"
        }

        const data = Buffer.from(await da.arrayBuffer())
        if (data.length == 0){
            return null
        }
        return data
    }
    async keys(prefix: string = ''):Promise<string[]>{
        await this.checkAuth()
        const headers: Record<string, string> = {
            'risu-auth': await this.createAuth()
        }
        if (prefix) {
            headers['key-prefix'] = prefix
        }
        const da = await fetch('/api/list', {
            method: "GET",
            headers
        })
        if(da.status < 200 || da.status >= 300){
            throw "listItem Error"
        }
        const data = await da.json()
        if(data.error){
            throw data.error
        }
        return data.content
    }
    async removeItem(key:string){
        await this.checkAuth()
        const da = await fetch('/api/remove', {
            method: "GET",
            headers: {
                'file-path': Buffer.from(key, 'utf-8').toString('hex'),
                'risu-auth': await this.createAuth()
            }
        })
        if(da.status < 200 || da.status >= 300){
            throw "removeItem Error"
        }
        const data = await da.json()
        if(data.error){
            throw data.error
        }
    }

    private async checkAuth(){

        if(!this.authChecked){
            const data = await (await fetch('/api/test_auth',{
                headers: {
                    'risu-auth': await this.createAuth()
                }
            })).json()

            if(data.status === 'unset'){
                const input = await digestPassword(await alertInput(language.setNodePassword))
                await fetch('/api/set_password',{
                    method: "POST",
                    body:JSON.stringify({
                        password: input 
                    }),
                    headers: {
                        'content-type': 'application/json'
                    }
                })
                return await this.createAuth()
            }
            else if(data.status === 'incorrect'){
                const keypair = await this.getKeyPair()
                const publicKey = await crypto.subtle.exportKey('jwk', keypair.publicKey)
                const input = await digestPassword(await alertInput(language.inputNodePassword))

                const s = await fetch('/api/login',{
                    method: "POST",
                    body: JSON.stringify({
                        password: input,
                        publicKey: publicKey
                    }),
                    headers: {
                        'content-type': 'application/json'
                    }
                })

                //too many requests
                if(s.status === 429){
                    alertError(`Too many attempts. Please wait and try again later.`)
                    await waitAlert()
                }
                

                return await this.createAuth()
            
            }
            else{
                this.authChecked = true
            }
        }
    }

    listItem = this.keys

    // ── Bulk asset operations (3-2-B) ──────────────────────────────────────────
    async getItems(keys: string[]): Promise<{key: string, value: Buffer}[]> {
        await this.checkAuth()
        const da = await fetch('/api/assets/bulk-read', {
            method: 'POST',
            body: JSON.stringify(keys),
            headers: {
                'content-type': 'application/json',
                'risu-auth': await this.createAuth()
            }
        })
        if (da.status < 200 || da.status >= 300) throw 'getItems Error'
        const results: {key: string, value: string}[] = await da.json()
        return results.map(r => ({ key: r.key, value: Buffer.from(r.value, 'base64') }))
    }

    async setItems(entries: {key: string, value: Uint8Array}[]) {
        for (let i = 0; i < entries.length; i += NodeStorage.BULK_WRITE_CLIENT_BATCH) {
            const batch = entries.slice(i, i + NodeStorage.BULK_WRITE_CLIENT_BATCH)
            const body = batch.map(e => ({
                key: e.key,
                value: Buffer.from(e.value).toString('base64')
            }))
            const da = await this.authFetch('/api/assets/bulk-write', {
                method: 'POST',
                body: JSON.stringify(body),
                headers: {
                    'content-type': 'application/json'
                }
            })
            if (da.status < 200 || da.status >= 300) throw 'setItems Error'
        }
    }

    async exportBackup(): Promise<Response> {
        const da = await this.authFetch('/api/backup/export')
        if (da.status < 200 || da.status >= 300) throw `backup export error: ${da.status}`
        return da
    }

    async prepareImport(size: number): Promise<void> {
        const da = await this.authFetch('/api/backup/import/prepare', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ size }),
        })
        if (da.status === 409) throw new Error('Another import is already in progress')
        if (da.status === 413) throw new Error('Backup file is too large')
        if (da.status === 507) {
            const body = await da.json().catch(() => ({}))
            const avail = body.available != null ? ` (available: ${Math.round(body.available / 1024 / 1024)} MB)` : ''
            throw new Error(`Insufficient disk space${avail}`)
        }
        if (da.status < 200 || da.status >= 300) throw new Error(`backup prepare error: ${da.status}`)
    }

    async importBackup(
        file: Blob,
        onProgress?: (loaded: number, total: number) => void
    ): Promise<{ok: boolean, assetsRestored: number}> {
        await this.prepareImport(file.size)
        const authHeader = await this.createAuth()

        return await new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest()
            xhr.open('POST', '/api/backup/import')
            xhr.setRequestHeader('content-type', 'application/x-risu-backup')
            xhr.setRequestHeader('risu-auth', authHeader)

            xhr.upload.onprogress = (event) => {
                if (event.lengthComputable) {
                    onProgress?.(event.loaded, event.total)
                }
            }

            xhr.onerror = () => reject(new Error('backup import request failed'))
            xhr.onload = () => {
                if (xhr.status < 200 || xhr.status >= 300) {
                    reject(new Error(`backup import error: ${xhr.status}`))
                    return
                }
                try {
                    resolve(JSON.parse(xhr.responseText))
                } catch (error) {
                    reject(error)
                }
            }

            xhr.send(file)
        })
    }

    // ── Entity API methods (3-2) ───────────────────────────────────────────────
    private async entityFetch(path: string, method: string, body?: Uint8Array): Promise<Buffer | null> {
        const headers: Record<string, string> = { 'risu-auth': await this.createAuth() }
        if (body) headers['content-type'] = 'application/octet-stream'
        const da = await fetch(path, { method, headers, body: body as any })
        if (da.status === 404) return null
        if (da.status < 200 || da.status >= 300) throw `entityFetch Error: ${da.status}`
        if (method === 'DELETE' || da.headers.get('content-type')?.includes('application/json')) return null
        return Buffer.from(await da.arrayBuffer())
    }

    async saveCharacter(id: string, data: Uint8Array) {
        await this.checkAuth()
        await this.entityFetch(`/api/db/characters/${encodeURIComponent(id)}`, 'POST', data)
    }
    async loadCharacter(id: string): Promise<Buffer | null> {
        await this.checkAuth()
        return this.entityFetch(`/api/db/characters/${encodeURIComponent(id)}`, 'GET')
    }
    async listCharacters(): Promise<{id: string, updated_at: number}[]> {
        await this.checkAuth()
        const da = await fetch('/api/db/characters', { headers: { 'risu-auth': await this.createAuth() } })
        return da.json()
    }
    async deleteCharacter(id: string) {
        await this.checkAuth()
        await this.entityFetch(`/api/db/characters/${encodeURIComponent(id)}`, 'DELETE')
    }

    async saveChat(charId: string, chatId: string, data: Uint8Array) {
        await this.checkAuth()
        await this.entityFetch(`/api/db/chats/${encodeURIComponent(charId)}/${encodeURIComponent(chatId)}`, 'POST', data)
    }
    async loadChat(charId: string, chatId: string): Promise<Buffer | null> {
        await this.checkAuth()
        return this.entityFetch(`/api/db/chats/${encodeURIComponent(charId)}/${encodeURIComponent(chatId)}`, 'GET')
    }
    async listChats(charId: string): Promise<string[]> {
        await this.checkAuth()
        const da = await fetch(`/api/db/chats/${encodeURIComponent(charId)}`, { headers: { 'risu-auth': await this.createAuth() } })
        return da.json()
    }
    async deleteChat(charId: string, chatId: string) {
        await this.checkAuth()
        await this.entityFetch(`/api/db/chats/${encodeURIComponent(charId)}/${encodeURIComponent(chatId)}`, 'DELETE')
    }

    async saveSettings(data: Uint8Array) {
        await this.checkAuth()
        await this.entityFetch('/api/db/settings', 'POST', data)
    }
    async loadSettings(): Promise<Buffer | null> {
        await this.checkAuth()
        return this.entityFetch('/api/db/settings', 'GET')
    }

    async savePreset(id: string, data: Uint8Array) {
        await this.checkAuth()
        await this.entityFetch(`/api/db/presets/${encodeURIComponent(id)}`, 'POST', data)
    }
    async loadPreset(id: string): Promise<Buffer | null> {
        await this.checkAuth()
        return this.entityFetch(`/api/db/presets/${encodeURIComponent(id)}`, 'GET')
    }
    async listPresets(): Promise<string[]> {
        await this.checkAuth()
        const da = await fetch('/api/db/presets', { headers: { 'risu-auth': await this.createAuth() } })
        return da.json()
    }
    async deletePreset(id: string) {
        await this.checkAuth()
        await this.entityFetch(`/api/db/presets/${encodeURIComponent(id)}`, 'DELETE')
    }

    async saveModule(id: string, data: Uint8Array) {
        await this.checkAuth()
        await this.entityFetch(`/api/db/modules/${encodeURIComponent(id)}`, 'POST', data)
    }
    async loadModule(id: string): Promise<Buffer | null> {
        await this.checkAuth()
        return this.entityFetch(`/api/db/modules/${encodeURIComponent(id)}`, 'GET')
    }
    async listModules(): Promise<string[]> {
        await this.checkAuth()
        const da = await fetch('/api/db/modules', { headers: { 'risu-auth': await this.createAuth() } })
        return da.json()
    }
    async deleteModule(id: string) {
        await this.checkAuth()
        await this.entityFetch(`/api/db/modules/${encodeURIComponent(id)}`, 'DELETE')
    }

    subscribeEvents(callback: (ev: {type: string, id: string, updated_at: number}) => void): () => void {
        const source = new EventSource('/api/events')
        source.onmessage = (e) => {
            try { callback(JSON.parse(e.data)) } catch {}
        }
        return () => source.close()
    }
}

async function digestPassword(message:string) {
    const crypt = await (await fetch('/api/crypto', {
        body: JSON.stringify({
            data: message
        }),
        headers: {
            'content-type': 'application/json'
        },
        method: "POST"
    })).text()
    
    return crypt;
}