import { NodeStorage } from "./nodeStorage"

export class AutoStorage{
    isAccount:boolean = false

    realStorage:NodeStorage

    async setItem(key:string, value:Uint8Array):Promise<string|null> {
        await this.realStorage.setItem(key, value)
        return null
    }
    async getItem(key:string):Promise<Buffer> {
        return await this.realStorage.getItem(key)
    }
    async keys():Promise<string[]>{
        return await this.realStorage.keys()
    }
    async removeItem(key:string){
        return await this.realStorage.removeItem(key)
    }

    async checkAccountSync(){
        return false
    }

    async Init(){
        if(!this.realStorage){
            console.log("using node storage")
            this.realStorage = new NodeStorage()
        }
    }

    async createAuth(): Promise<string> {
        if (!this.realStorage) {
            this.realStorage = new NodeStorage()
        }
        return this.realStorage.createAuth()
    }

    async exportBackup() {
        await this.Init()
        return this.realStorage.exportBackup()
    }

    async importBackup(file: Blob) {
        await this.Init()
        return this.realStorage.importBackup(file)
    }

    listItem = this.keys

    // ── Bulk asset operations (3-2-B) ──────────────────────────────────────────
    async getItems(keys: string[]) { return this.realStorage.getItems(keys) }
    async setItems(entries: {key: string, value: Uint8Array}[]) { return this.realStorage.setItems(entries) }

    // ── Entity API operations (3-2) ────────────────────────────────────────────
    async saveCharacter(id: string, data: Uint8Array) { return this.realStorage.saveCharacter(id, data) }
    async loadCharacter(id: string) { return this.realStorage.loadCharacter(id) }
    async listCharacters() { return this.realStorage.listCharacters() }
    async deleteCharacter(id: string) { return this.realStorage.deleteCharacter(id) }
    async saveChat(charId: string, chatId: string, data: Uint8Array) { return this.realStorage.saveChat(charId, chatId, data) }
    async loadChat(charId: string, chatId: string) { return this.realStorage.loadChat(charId, chatId) }
    async listChats(charId: string) { return this.realStorage.listChats(charId) }
    async deleteChat(charId: string, chatId: string) { return this.realStorage.deleteChat(charId, chatId) }
    async saveSettings(data: Uint8Array) { return this.realStorage.saveSettings(data) }
    async loadSettings() { return this.realStorage.loadSettings() }
    async savePreset(id: string, data: Uint8Array) { return this.realStorage.savePreset(id, data) }
    async loadPreset(id: string) { return this.realStorage.loadPreset(id) }
    async listPresets() { return this.realStorage.listPresets() }
    async deletePreset(id: string) { return this.realStorage.deletePreset(id) }
    async saveModule(id: string, data: Uint8Array) { return this.realStorage.saveModule(id, data) }
    async loadModule(id: string) { return this.realStorage.loadModule(id) }
    async listModules() { return this.realStorage.listModules() }
    async deleteModule(id: string) { return this.realStorage.deleteModule(id) }
    subscribeEvents(callback: (ev: {type: string, id: string, updated_at: number}) => void) {
        return this.realStorage.subscribeEvents(callback)
    }
}
