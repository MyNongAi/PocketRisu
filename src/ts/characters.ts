import { get, writable } from "svelte/store";
import { saveImage, setDatabase, type character, type Chat, defaultSdDataFunc, type loreBook, getDatabase, getCharacterByIndex, setCharacterByIndex, getCurrentChat, loadTogglesFromChat, normalizeChat, newChatModelDefaults } from "./storage/database.svelte";
import { ensureChatHydrated } from "./storage/chatStorage";
import { alertAddCharacter, alertConfirm, alertError, alertInput, alertSelect, alertStore, alertWait, notifySuccess, notifyInfo } from "./alert";
import { archiveCharacter } from "./characterArchive";
import { chatHydrationOverlayStore, chatDeselected } from "./stores.svelte";
import { language } from "../lang";
import { checkNullish, findCharacterbyId, findCharacterIndexbyId, getUserName, selectMultipleFile, selectSingleFile } from "./util";
import { v4 as uuidv4, v4 } from 'uuid';
import { getImageType } from "./media";
import { MobileGUIStack, OpenRealmStore, selectedCharID } from "./stores.svelte";
import { AppendableBuffer, changeChatTo, checkCharOrder, downloadFile, getFileSrc, getFileThumbnailSrc, requiresFullEncoderReload } from "./globalApi.svelte";
import { updateInlayScreen } from "./process/inlayScreen";
import { parseMarkdownSafe } from "./parser/parser.svelte";
import { translateHTML } from "./translator/translator";
import { importCharacter, importCharacterProcess } from "./characterCards";
import { importCharacterPackage } from "./characterPackage";
import { forageStorage } from "./globalApi.svelte";
import { isNodeServer } from "./platform";
import { PngChunk } from "./pngChunk";
import { promoteDepartedCharacter } from "./characterRecentOrder";
import { BoundedObjectUrlCache, createDeduplicatedImageLoader } from "./storage/boundedObjectUrlCache";

const CHAT_HYDRATION_INDICATOR_DELAY_MS = 180
const CHAT_PREFETCH_DELAY_MS = 110
let characterSelectionHydrationSerial = 0
let characterPrefetchTimer: ReturnType<typeof setTimeout> | null = null
let characterPrefetchIndex = -1

// HaejeokRisu's bounded-avatar-cache principle, adapted to PocketRisu's
// existing provider/thumbnail APIs. Keep only the visible/recent working set
// and collapse concurrent requests for the same asset.
const characterImageCache = new BoundedObjectUrlCache(
    typeof window !== 'undefined' && window.innerWidth <= 800 ? 64 : 128,
    typeof window !== 'undefined' && window.innerWidth <= 800 ? 8 : 16,
)
const loadCharacterImageSource = createDeduplicatedImageLoader(characterImageCache)

function hideChatHydrationIndicator(requestId?: string) {
    chatHydrationOverlayStore.update((current) => {
        if(requestId && current.requestId !== requestId) return current
        return { active: false, text: '', onCancel: null, requestId: null }
    })
}

export function prefetchCharacterChat(index: number): Promise<Chat | null> {
    const char = getDatabase().characters[index]
    const chat = char?.chats?.[char.chatPage]
    if(!char || !chat || !chat._placeholder) return Promise.resolve(chat ?? null)
    return ensureChatHydrated(char.chats, char.chatPage, char.chaId).catch((error) => {
        console.warn('[prefetchCharacterChat] hydration failed:', error)
        return null
    })
}

export function scheduleCharacterChatPrefetch(index: number) {
    if(characterPrefetchTimer && characterPrefetchIndex === index) return
    cancelCharacterChatPrefetch()
    characterPrefetchIndex = index
    characterPrefetchTimer = setTimeout(() => {
        characterPrefetchTimer = null
        characterPrefetchIndex = -1
        void prefetchCharacterChat(index)
    }, CHAT_PREFETCH_DELAY_MS)
}

export function cancelCharacterChatPrefetch(index?: number) {
    if(index !== undefined && characterPrefetchIndex !== index) return
    if(characterPrefetchTimer) clearTimeout(characterPrefetchTimer)
    characterPrefetchTimer = null
    characterPrefetchIndex = -1
}

async function waitForChatWarmupIdle() {
    if(typeof window !== 'undefined' && 'requestIdleCallback' in window) {
        await new Promise<void>((resolve) => window.requestIdleCallback(() => resolve(), { timeout: 1200 }))
        return
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 50))
}

export async function warmRecentCharacterChats(indices: number[], shouldContinue: () => boolean = () => true) {
    for(const index of [...new Set(indices)]) {
        if(!shouldContinue()) return
        await waitForChatWarmupIdle()
        if(!shouldContinue()) return
        await prefetchCharacterChat(index)
    }
}

export function createNewCharacter() {
    let db = getDatabase()
    db.characters.push(createBlankChar())
    checkCharOrder()
    return db.characters.length - 1
}

export async function getCharImage(loc:string, type:'plain'|'css'|'contain'|'lgcss') {
    const db = getDatabase()
    
    // Return placeholder when hideAllImages is enabled
    if(db.hideAllImages){
        if(type === 'plain'){
            return '/none.webp'
        }
        return ''  // For CSS types, return empty to show default ? icon
    }
    
    if(!loc || loc === ''){
        if(type ==='css'){
            return ''
        }
        return null
    }
    const filesrc = await loadCharacterImageSource(
        `full:${loc}`,
        () => getFileSrc(loc),
        true,
    )
    if(type === 'plain'){
        return filesrc
    }
    else if(type ==='css'){
        return `background: url("${filesrc}");background-size: cover;`
    }
    else if(type === 'lgcss'){
        return `background: url("${filesrc}");background-size: cover;height: 10.66rem;`

    }

    else{
        return `background: url("${filesrc}");background-size: contain;background-repeat: no-repeat;background-position: center;`
    }
}

/** Lightweight character-list image. Full character/profile views keep using getCharImage. */
export async function getCharThumbnail(loc: string, type: 'plain'|'css' = 'plain') {
    const db = getDatabase()
    if(db.hideAllImages) return type === 'plain' ? '/none.webp' : ''
    if(!loc) return type === 'plain' ? null : ''
    const src = await loadCharacterImageSource(
        `thumb:${loc}`,
        () => getFileThumbnailSrc(loc),
    )
    return type === 'plain'
        ? src
        : `background: url("${src}");background-size: cover;background-position: center;`
}

export function clearCharacterImageCache() {
    characterImageCache.clear()
}

export async function selectCharImg(charIndex:number) {
    const selected = await selectSingleFile(['png', 'webp', 'gif', 'jpg', 'jpeg'])
    if(!selected){
        return
    }
    const img = selected.data
    let db = getDatabase()

    const type = getImageType(img)

    try {
        if(type === 'PNG'){
            const gen = PngChunk.readGenerator(img)
            const allowedChunk = [
                'parameters', 'Comment', 'Title', 'Description', 'Author', 'Software', 'Source', 'Disclaimer', 'Warning', 'Copyright',
            ]
            for await (const chunk of gen){
                if(chunk instanceof AppendableBuffer){
                    continue
                }
                if(!chunk){
                    continue
                }
                if(chunk.value.length > 20_000){
                    continue
                }
                if(allowedChunk.includes(chunk.key)){
                    console.log(chunk.key, chunk.value)
                    db.characters[charIndex].extentions ??= {}
                    db.characters[charIndex].extentions.pngExif ??= {}
                    db.characters[charIndex].extentions.pngExif[chunk.key] = chunk.value
                }
            }
            console.log(db.characters[charIndex].extentions)
        }   
    } catch (error) {
        console.error(error)
    }



    const imgp = await saveImage(img)
    dumpCharImage(charIndex)
    db.characters[charIndex].image = imgp
}

export function dumpCharImage(charIndex:number) {
    let db = getDatabase()
    const char = db.characters[charIndex] as character
    if(!char.image || char.image === ''){
        return
    }
    char.ccAssets ??= []
    char.ccAssets.push({
        type: 'icon',
        name: 'iconx',
        uri: char.image,
        ext: 'png'
    })
    char.image = ''
    db.characters[charIndex] = char
}

export function changeCharImage(charIndex:number,changeIndex:number) {
    let db = getDatabase()
    const char = db.characters[charIndex] as character
    const image = char.ccAssets[changeIndex].uri
    char.ccAssets.splice(changeIndex, 1)
    dumpCharImage(charIndex)
    char.image = image
    db.characters[charIndex] = char
}


export const addingEmotion = writable(false)

export async function addCharEmotion(charId:number) {
    addingEmotion.set(true)
    const selected = await selectMultipleFile(['png', 'webp', 'gif'])
    if(!selected){
        addingEmotion.set(false)
        return
    }
    let db = getDatabase()
    for(const f of selected){
        const img = f.data
        const imgp = await saveImage(img)
        const name = f.name.replace('.png','').replace('.webp','')
        let dbChar = db.characters[charId]
        dbChar.emotionImages.push([name,imgp])
        db.characters[charId] = dbChar
    }
    addingEmotion.set(false)
}

export function rmCharEmotion(charId:number, emotionId:number) {
    let db = getDatabase()
    let dbChar = db.characters[charId]
    dbChar.emotionImages.splice(emotionId, 1)
    db.characters[charId] = dbChar
}


export async function exportChat(page:number){
    try {

        const mode = await alertSelect(['Export as JSON', "Export as TXT", "Export as HTML File", "Export as HTML Embed"])
        const doTranslate = (mode === '2' || mode === '3') ? (await alertSelect([language.translateContent, language.doNotTranslate])) === '0' : false
        const anonymous = (mode === '2' || mode === '3') ? ((await alertSelect([language.includePersonaName, language.hidePersonaName])) === '1') : false
        const selectedID = get(selectedCharID)
        const db = getDatabase()
        const char = db.characters[selectedID]
        // Ensure chat is hydrated before export
        if(char.chats[page]?._placeholder){
            await ensureChatHydrated(char.chats, page, char.chaId)
        }
        if(char.chats[page]?._placeholder){
            alertError('Failed to load chat data. Export aborted.')
            return
        }
        const chat = char.chats[page]
        const date = new Date().toJSON();
        const htmlChatParse = async (v:string) => {
            v = parseMarkdownSafe(v)

            if(doTranslate){
                v = await translateHTML(v, false, '', -1)
            }

            if(anonymous){
                //case insensitive match, replace all
                const excapedName = char.name.replace(/[-\/\\^$*+\?\.()|[\]{}]/g, '\\$&')

                v = v.replace(new RegExp(`${excapedName}`, 'gi'), '×××')
            }

            return v
        }

        if(mode === '0'){
            let folders = []
            if(chat.folderId) {
                folders = db.characters[selectedID].chatFolders?.filter(f => f.id === chat.folderId)
            }
            const stringl = Buffer.from(JSON.stringify({
                type: 'risuChat',
                ver: 2,
                data: chat,
                folders: folders
            }), 'utf-8')
    
            await downloadFile(`${char.name}_${date}_chat`.replace(/[<>:"/\\|?*\.\,]/g, "") + '.json', stringl)
    
        }
        else if(mode === '2'){

            let chatContentHTML = ''

            let i = 0
            for(const v of chat.message){
                alertWait(`Translating... ${i++}/${chat.message.length}`)
                const name = v.saying ? findCharacterbyId(v.saying).name : v.role === 'char' ? char.name : anonymous ? '×××' : getUserName()
                chatContentHTML += `<div class="chat">
                    <h2>${name}</h2>
                    <div>${await htmlChatParse(v.data)}</div>
                </div>`
            }

            const doc = `
                <!DOCTYPE html>
                <html>
                    <head>
                        <title>${char.name} Chat</title>
                        <style>
                            body{
                                font-family: Arial, sans-serif;
                                display: flex;
                                justify-content: center;
                            }
                            .container{
                                max-width: 800px;
                                padding: 1rem;
                                border-radius: 10px;
                                display: flex;
                                flex-direction: column;
                                gap: 1rem;
                            }
                            .chat{
                                background: #f0f0f0;
                                padding: 1rem;
                                border-radius: 10px;
                                display: flex;
                                flex-direction: column;
                            }
                            .idat{
                                display: none;
                            }
                            h2{
                                margin: 0;
                            }
                            .chat div{
                                margin-top: 0.5rem;
                                break-word: break-all;
                            }
                        </style>
                    </head>
                    <body>
                        <div class="container">
                            <div class="chat">
                                <h2>${char.name}</h2>
                                <div>${await htmlChatParse(
                                    chat.fmIndex === -1 ? char.firstMessage : char.alternateGreetings?.[chat.fmIndex ?? 0]
                                )}</div>
                            </div>
                            ${chatContentHTML}
                        </div>
                        <div class="idat">${
                            JSON.stringify(chat).replace(/</g, '&lt;').replace(/>/g, '&gt;')
                        }</div>
                    </body>
            `


            await downloadFile(`${char.name}_${date}_chat`.replace(/[<>:"/\\|?*\.\,]/g, "") + '.html', Buffer.from(doc, 'utf-8'))
        }
        else if(mode === '3'){
            //create a html table
            let chatContentHTML = ''

            let i = 0
            for(const v of chat.message){
                alertWait(`Translating... ${i++}/${chat.message.length}`)
                const name = v.saying ? findCharacterbyId(v.saying).name : v.role === 'char' ? char.name : anonymous ? '×××' : getUserName()
                chatContentHTML += `<tr>
                    <td>${name}</td>
                    <td>${await htmlChatParse(v.data)}</td>
                </tr>`
            }

            const template = `
                <table>
                    <tr>
                        <th>Character</th>
                        <th>Message</th>
                    </tr>
                    <tr>
                        <td>${char.name}</td>
                        <td>${await htmlChatParse(char.firstMessage)}</td>
                    </tr>
                    ${chatContentHTML}
                </table>
                <p>Chat from PocketRisu</p>
            `

            //copy to clipboard

            const item = new ClipboardItem({
                'text/html': new Blob([template], { type: 'text/html' }),
                'text/plain': new Blob([template], { type: 'text/plain' })
            })
            await navigator.clipboard.write([item])

            notifyInfo(language.clipboardSuccess)
            return

        }
        else{
            
            let stringl = chat.message.map((v) => {
                if(v.saying){
                    return `--${findCharacterbyId(v.saying).name}\n${v.data}`
                }
                else{
                    return `--${v.role === 'char' ? char.name : getUserName()}\n${v.data}`
                }
            }).join('\n\n')

            stringl = `--${char.name}\n${char.firstMessage}\n\n` + stringl

            await downloadFile(`${char.name}_${date}_chat`.replace(/[<>:"/\\|?*\.\,]/g, "") + '.txt', Buffer.from(stringl, 'utf-8'))

        }
        notifySuccess(language.successExport)
    } catch (error) {
        alertError(error)
    }
}

export async function importChat(){
    const dat =await selectSingleFile(['json','jsonl','txt','html'])
    if(!dat){
        return
    }
    try {
        const selectedID = get(selectedCharID)
        let db = getDatabase()

        if(dat.name.endsWith('jsonl')){
            const lines = Buffer.from(dat.data).toString('utf-8').split('\n')
            let newChat:Chat = {
                message: [],
                note: "",
                name: "Imported Chat",
                localLore: [],
                fmIndex: -1,
                id: v4(),
                ...newChatModelDefaults()
            }

            let isFirst = true
            for(const line of lines){
                
                const presedLine = JSON.parse(line)
                if(presedLine.name && presedLine.is_user, presedLine.mes){
                    if(!isFirst){
                        newChat.message.push({
                            role: presedLine.is_user ? "user" : 'char',
                            data: formatTavernChat(presedLine.mes, db.characters[selectedID].name)
                        })
                    }
                }

                isFirst = false
            }

            if(newChat.message.length === 0){
                alertError(language.errors.noData)
                return
            }

            if(db.characters[selectedID].chatFolders
                .filter(folder => folder.id === newChat.folderId).length === 0) {
                newChat.folderId = null
            }

            db.characters[selectedID].chats.unshift(newChat)
            changeChatTo(0)
            notifySuccess(language.successImport)
        }
        else if(dat.name.endsWith('json')){
            const json = JSON.parse(Buffer.from(dat.data).toString('utf-8'))
            if((json.type === 'risuAllChats' || json.type === 'risuChat') && json.ver === 2){
                const folders = json.folders || []
                const chats = Array.isArray(json.data) ? json.data : [json.data]
                const selectedID = get(selectedCharID)
                let db = getDatabase()
                let folderIdMap = {}
                folders.forEach(folder => {
                    if(db.characters[selectedID].chatFolders?.some(f => f.id === folder.id)){
                        const newId = uuidv4()
                        folderIdMap[folder.id] = newId
                        folder.id = newId
                    } else {
                        folderIdMap[folder.id] = folder.id
                    }
                })
                if(db.characters[selectedID].chatFolders === undefined){
                    db.characters[selectedID].chatFolders = []
                }
                db.characters[selectedID].chatFolders.push(...folders)
                chats.forEach(chat => {
                    if(chat.folderId && folderIdMap[chat.folderId]){
                        chat.folderId = folderIdMap[chat.folderId]
                    }
                    chat.id = v4()
                })
                db.characters[selectedID].chats.unshift(...chats.map(c => normalizeChat(c)))
                notifySuccess(language.successImport)
                return
            }
            if(json.type === 'risuAllChats' && json.ver === 1){
                const chats = json.data
                if(Array.isArray(chats) && chats.length > 0){
                    db.characters[selectedID].chats.unshift(...(chats.map((v) => {
                        if(!v.id){
                            v.id = uuidv4()
                        }
                        if(!v.localLore){
                            v.localLore = []
                        }
                        v.fmIndex ??= -1
                        return normalizeChat(v)
                    })))
                    notifySuccess(language.successImport)
                    return
                } else {
                    alertError(language.errors.noData)
                    return
                }
            }
            if(json.type === 'risuChat' && json.ver === 1){
                const das:Chat = json.data
                if(!(checkNullish(das.message) || checkNullish(das.note) || checkNullish(das.name) || checkNullish(das.localLore))){
                    das.fmIndex ??= -1
                    das.id = v4()
                    db.characters[selectedID].chats.unshift(normalizeChat(das))
                    notifySuccess(language.successImport)
                    return
                }
                else{
                    alertError(language.errors.noData)
                    return   
                }
            }
            else{
                alertError(language.errors.noData)
                return
            }
        }
        else if(dat.name.endsWith('html')){
            const doc = new DOMParser().parseFromString(Buffer.from(dat.data).toString('utf-8'), 'text/html')
            const chat = doc.querySelector('.idat').textContent
            const json = JSON.parse(chat)
            if(json.message && json.note && json.name && json.localLore){
                db.characters[selectedID].chats.unshift(normalizeChat(json))
                notifySuccess(language.successImport)
            }
            else{
                alertError(language.errors.noData)
            }
        }
    } catch (error) {
        alertError(error)
    }
}

export async function exportAllChats() {
    try {
        const selectedID = get(selectedCharID)
        const db = getDatabase()
        const char = db.characters[selectedID]
        const date = new Date().toISOString().replace(/[:.]/g, "-")

        for (let i = 0; i < char.chats.length; i++) {
            if (char.chats[i]?._placeholder) {
                alertWait(`Loading chat data... (${i + 1}/${char.chats.length})`)
                await ensureChatHydrated(char.chats, i, char.chaId)
            }
            if (char.chats[i]?._placeholder) {
                alertError(`Failed to load chat data for "${char.chats[i].name}". Export aborted to prevent data loss.`)
                return
            }
        }

        const allChats = char.chats
        const allFolders = char.chatFolders
        const stringl = Buffer.from(JSON.stringify({
            type: 'risuAllChats',
            ver: 2,
            data: allChats,
            folders: allFolders
        }), 'utf-8')
        await downloadFile(`${char.name}_all_chats_${date}`.replace(/[<>:"/\\|?*.,]/g, "") + '.json', stringl)
        notifySuccess(language.successExport)
    } catch (error) {
        alertError(error)
    }
}

function formatTavernChat(chat:string, charName:string){
    const db = getDatabase()
    return chat.replace(/<([Uu]ser)>|\{\{([Uu]ser)\}\}/g, getUserName()).replace(/((\{\{)|<)([Cc]har)(=.+)?((\}\})|>)/g, charName)
}

export function characterFormatUpdate(indexOrCharacter:number|character, arg:{
    updateInteraction?:boolean,
} = {}){
    let cha = typeof(indexOrCharacter) === 'number' ? getCharacterByIndex(indexOrCharacter) : indexOrCharacter
    if(cha.chats.length === 0){
        cha.chats = [{
            message: [],
            note: '',
            name: 'Chat 1',
            localLore: [],
            ...newChatModelDefaults()
        }]
    }
    if(!cha.chats[cha.chatPage]){
        cha.chatPage = 0
    }
    if(!cha.chats[cha.chatPage].message){
        cha.chats[cha.chatPage].message = []
    }
    if(!cha.type){
        cha.type = 'character'
    }
    if(!cha.chaId){
        cha.chaId = uuidv4()
    }
    if(checkNullish(cha.sdData)){
        cha.sdData = defaultSdDataFunc()
    }
    if(checkNullish(cha.utilityBot)){
        cha.utilityBot = false
    }
    cha.triggerscript = cha.triggerscript ?? []
    cha.alternateGreetings = cha.alternateGreetings ?? []
    cha.exampleMessage = cha.exampleMessage ?? ''
    cha.creatorNotes = cha.creatorNotes ?? ''
    cha.systemPrompt = cha.systemPrompt ?? ''
    cha.tags = cha.tags ?? []
    cha.creator = cha.creator ?? ''
    cha.characterVersion = cha.characterVersion ?? ''
    cha.personality = cha.personality ?? ''
    cha.scenario = cha.scenario ?? ''
    cha.firstMsgIndex = cha.firstMsgIndex ?? -1
    cha.additionalData = cha.additionalData ?? {
        tag: [],
        creator: '',
        character_version: ''
    }
    cha.voicevoxConfig = cha.voicevoxConfig ?? {
        SPEED_SCALE: 1,
        PITCH_SCALE: 0,
        INTONATION_SCALE: 1,
        VOLUME_SCALE: 1
    }
    if(cha.postHistoryInstructions){
        cha.chats[cha.chatPage].note += "\n" + cha.postHistoryInstructions
        cha.chats[cha.chatPage].note = cha.chats[cha.chatPage].note.trim()
        cha.postHistoryInstructions = null
    }
    cha.additionalText ??= ''
    cha.depth_prompt ??= {
        depth: 0,
        prompt: ''
    }
    cha.hfTTS ??= {
        model: '',
        language: 'en'
    }
    cha.backgroundHTML ??= ''
    cha.backgroundCSS ??= ''
    cha.creation_date ??= Date.now()
    cha.globalLore = updateLorebooks(cha.globalLore)
    if(!cha.newGenData){
        cha = updateInlayScreen(cha)
    }
    // Migrate legacy 'none' value to '' for UI dropdown compatibility
    // Using '' because it's falsy, so `if (ttsMode)` correctly detects enabled TTS
    if (cha.ttsMode === 'none') {
        cha.ttsMode = ''
    }
    cha.ttsMode ??= ''
    if(checkNullish(cha.customscript)){
        cha.customscript = []
    }
    cha.lastInteraction = Date.now()
    if(typeof(indexOrCharacter) === 'number'){
        setCharacterByIndex(indexOrCharacter, cha)
    }
    for(let i = 0; i < cha.chats.length; i++){
        const chat = cha.chats[i]
        chat.fmIndex ??= cha.firstMsgIndex ?? -1
        if(!chat.id){
            chat.id = uuidv4()
        }
        if(!chat.localLore){
            chat.localLore = []
        }
    }
    return cha
}

export function updateLorebooks(book:loreBook[]){
    return book.map((v) => {
        v.bookVersion ??= 1
        if(v.bookVersion >= 2){
            return v
        }
        if(v.activationPercent){
            const perc = v.activationPercent
            v.activationPercent = null

            v.content = `@@probability ${perc}\n${v.content}`
        }
        v.content = v.content.replace(/@@@?end/g, '@@depth 0').replace(/\<(char|bot)\>/g, '{{char}}').replace(/\<(user)\>/g, '{{user}}')
        v.bookVersion = 2
        return v
    })

}

// SYNC: server/node/server.cjs promoteFailedColdStorageStub() mirrors these defaults.
export function createBlankChar():character{
    return {
        name: '',
        firstMessage: '',
        desc: '',
        notes: '',
        chats: [{
            message: [],
            note: '',
            name: 'Chat 1',
            localLore: [],
            ...newChatModelDefaults()
        }],
        chatFolders: [],
        chatPage: 0,
        emotionImages: [],
        bias: [],
        viewScreen: 'none',
        globalLore: [],
        chaId: uuidv4(),
        type: 'character',
        sdData: defaultSdDataFunc(),
        utilityBot: false,
        customscript: [],
        exampleMessage: '',
        creatorNotes:'',
        systemPrompt:'',
        postHistoryInstructions:'',
        alternateGreetings:[],
        tags:[],
        creator:"",
        characterVersion: '',
        personality:"",
        scenario:"",
        firstMsgIndex: -1,
        replaceGlobalNote: "",
        triggerscript: [{
            comment: "",
            type: "manual",
            conditions: [],
            effect: [{
                type: "v2Header",
                code: "",
                indent: 0
            }]
        }, {
            comment: "New Event",
            type: 'manual',
            conditions: [],
            effect: []
        }],
        additionalText: ''
    }
}


export function recordCurrentCharacterDeparture(nextCharacterId?: string) {
    const db = getDatabase()
    const currentIndex = get(selectedCharID)
    const departedCharacterId = db.characters[currentIndex]?.chaId
    const promotedOrder = promoteDepartedCharacter(
        db.characterOrder,
        departedCharacterId,
        nextCharacterId,
        new Set(db.characters.filter((character) => character.favorite).map((character) => character.chaId)),
    )
    if (promotedOrder !== db.characterOrder) db.characterOrder = promotedOrder
}

export function deselectCharacter() {
    recordCurrentCharacterDeparture()
    try {
        localStorage.removeItem('risu-last-active-character')
    } catch {
        // Best effort only.
    }
    selectedCharID.set(-1)
}

export async function removeChar(identifier:string|number,name:string, type:'normal'|'permanent'|'permanentForce' = 'normal', arg:{ skipConfirm?: boolean } = {}){
    const db = getDatabase()
    // skipConfirm: bulk callers (character manager) confirm once for the whole set.
    // Moving to the trash is reversible, so it asks once; permanent deletion asks twice.
    if(type !== 'permanentForce' && !arg.skipConfirm){
        const conf = await alertConfirm((type === 'normal' ? language.moveToTrashConfirm : language.removeConfirm) + name)
        if(!conf){
            return
        }
        if(type === 'permanent'){
            const conf2 = await alertConfirm(language.removeConfirm2 + name)
            if(!conf2){
                return
            }
        }
    }
    let chars = db.characters
    // Resolve identifier to actual index at the time of deletion to avoid
    // race conditions when concurrent deletions shift the array.
    const index = typeof identifier === 'string'
        ? findCharacterIndexbyId(identifier)
        : identifier
    if (index === -1 || index >= chars.length) {
        return
    }
    if(type === 'normal'){
        // Trash = deactivate + marker: the character leaves memory and the
        // database blob like any deactivation (src/ts/characterArchive.ts).
        // Bulk callers confirmed once already; they also get one summary instead of a toast per character.
        await archiveCharacter(index, { skipConfirm: true, trash: true, silent: arg.skipConfirm })
        return
    }
    chars.splice(index, 1)
    checkCharOrder()
    db.characters = chars
    requiresFullEncoderReload.state = true
    deselectCharacter()
}

export async function addCharacter(arg:{
    reseter?:()=>any,
    setCatalogLayout?:(mode:'single'|'split')=>void,
} = {}){
    MobileGUIStack.set(100)
    const reseter = arg.reseter ?? (() => {})
    const r = await alertAddCharacter()
    if(r === 'sidebarLayoutSingle' || r === 'sidebarLayoutSplit'){
        arg.setCatalogLayout?.(r === 'sidebarLayoutSplit' ? 'split' : 'single')
        MobileGUIStack.set(1)
        return
    }
    if(r === 'importFromRealm'){
        deselectCharacter()
        OpenRealmStore.set(true)
        MobileGUIStack.set(0)
        return
    }
    reseter();
    switch(r){
        case 'createfromScratch':
            createNewCharacter()
            break
        case 'importCharacter':
            await importCharacter()
            break
        case 'importPackage':
            await importCharacterPackage()
            break
        case 'importFromProton':
            await importFromProtonDrive()
            break
        default:
            MobileGUIStack.set(1)
            return
    }
    let db = getDatabase()
    if(db.characters[db.characters.length-1]){
        changeChar(db.characters.length-1)
    }
    MobileGUIStack.set(1)
}

async function importFromProtonDrive() {
    const url = await alertInput(language.protonDriveUrlPrompt)

    if (url && url.includes('drive.proton.me/urls/')) {
        window.open(url, '_blank')
    }

    if (isNodeServer) {
        await watchDownloadsAndImport('character')
        return
    }

    const files = await selectMultipleFile(['charx', 'png', 'json', 'risum', 'risup'])
    if (!files || files.length === 0) return
    for (const file of files) {
        await importCharacterProcess(file)
    }
    notifySuccess(language.protonImportSuccess)
}

async function watchDownloadsAndImport(mode: 'character' | 'module') {
    const extensions = mode === 'module'
        ? 'json,lorebook,risum,charx'
        : 'charx,png,json,risum,risup'

    alertWait(language.protonWatchingDownloads)

    const auth = await forageStorage.createAuth()
    let aborted = false

    try {
        const resp = await fetch(`/api/import/watch-downloads?extensions=${extensions}`, {
            headers: { 'risu-auth': auth || '' },
        })
        if (!resp.ok || !resp.body) {
            alertError('Failed to start download watcher')
            return
        }

        const reader = resp.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        let importedCount = 0

        while (!aborted) {
            const { done, value } = await reader.read()
            if (done) break

            buffer += decoder.decode(value, { stream: true })
            const lines = buffer.split('\n')
            buffer = lines.pop() || ''

            for (const line of lines) {
                if (!line.startsWith('data: ')) continue
                const json = line.slice(6)
                let msg: any
                try { msg = JSON.parse(json) } catch { continue }

                if (msg.done) { aborted = true; break }
                if (msg.status === 'watching') continue

                if (msg.filename && msg.data) {
                    let bytes = Uint8Array.from(atob(msg.data), c => c.charCodeAt(0))
                    if (bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) {
                        bytes = bytes.slice(3)
                    }
                    const imported = { name: msg.filename, data: bytes }

                    alertWait(`${language.protonImporting} ${msg.filename}`)

                    if (mode === 'module') {
                        const { importModuleFile } = await import('./process/modules')
                        await importModuleFile(imported)
                    } else {
                        await importCharacterProcess(imported)
                    }
                    importedCount++
                    notifySuccess(`${msg.filename} ${language.successImport}`)
                }
            }
        }

        reader.cancel().catch(() => {})

        if (importedCount === 0) {
            const files = await selectMultipleFile(
                mode === 'module'
                    ? ['json', 'lorebook', 'risum', 'charx']
                    : ['charx', 'png', 'json', 'risum', 'risup']
            )
            if (files && files.length > 0) {
                for (const file of files) {
                    if (mode === 'module') {
                        const { importModuleFile } = await import('./process/modules')
                        await importModuleFile(file)
                    } else {
                        await importCharacterProcess(file)
                    }
                }
                notifySuccess(language.protonImportSuccess)
            }
        }
    } catch (e) {
        alertError(e?.message || 'Watch failed')
    }
}

export { watchDownloadsAndImport }

export function changeChar(index: number, arg:{
    reseter?:()=>any,
} = {}) {
    const reseter = arg.reseter ?? (() => {})
    cancelCharacterChatPrefetch(index)
    const hydrationSerial = ++characterSelectionHydrationSerial
    const hydrationRequestId = `character:${hydrationSerial}`
    hideChatHydrationIndicator()
    const nextCharacterId = getDatabase().characters[index]?.chaId
    recordCurrentCharacterDeparture(nextCharacterId)
    reseter();
    chatDeselected.set(false)
    characterFormatUpdate(index, {
      updateInteraction: true,
    });
    const db = getDatabase()
    selectedCharID.set(index);

    // Remember only canonical, successfully selected characters.
    // Android/Firefox may recreate the tab while PocketRisu is backgrounded.
    try {
        if (db.characters[index]?.chaId) {
            localStorage.setItem('risu-last-active-character', db.characters[index].chaId)
        }
    } catch { /* best effort only */ }

    const chat = getCurrentChat()
    if(chat){
        if(chat._placeholder){
            const db = getDatabase()
            const char = db.characters[index]
            const capturedIndex = index
            const capturedChatId = chat.id
            if(char){
                let cancelled = false
                const indicatorTimer = setTimeout(() => {
                    if(cancelled || hydrationSerial !== characterSelectionHydrationSerial) return
                    const currentChar = getDatabase().characters[capturedIndex]
                    const activeChatId = currentChar?.chats?.[currentChar.chatPage]?.id
                    if(get(selectedCharID) !== capturedIndex || activeChatId !== capturedChatId) return
                    chatHydrationOverlayStore.set({ active: true, text: language.chatLoading ?? language.loading ?? '', requestId: hydrationRequestId, onCancel: () => {
                        cancelled = true
                        characterSelectionHydrationSerial++
                        chatDeselected.set(true)
                        hideChatHydrationIndicator(hydrationRequestId)
                    }})
                }, CHAT_HYDRATION_INDICATOR_DELAY_MS)
                void ensureChatHydrated(char.chats, char.chatPage, char.chaId).then((hydrated) => {
                    if(cancelled || hydrationSerial !== characterSelectionHydrationSerial) return
                    const currentChar = getDatabase().characters[capturedIndex]
                    const activeChatId = currentChar?.chats?.[currentChar.chatPage]?.id
                    if(hydrated && get(selectedCharID) === capturedIndex && activeChatId === capturedChatId) {
                        loadTogglesFromChat(hydrated)
                    }
                }).catch((e) => {
                    console.error('[selectCharacter] hydration failed:', e)
                }).finally(() => {
                    clearTimeout(indicatorTimer)
                    if(!cancelled && hydrationSerial === characterSelectionHydrationSerial) hideChatHydrationIndicator(hydrationRequestId)
                })
            }
        } else {
            loadTogglesFromChat(chat)
        }
    }
}
