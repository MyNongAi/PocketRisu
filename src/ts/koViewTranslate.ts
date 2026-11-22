// KO-VIEW (2026-11-22): translating a field for the Korean view (kept apart from koView.ts,
// whose pure helpers card import/export uses without loading the translator).
import { getDatabase } from './storage/database.svelte'
import { translate, translateHTML } from './translator/translator'
import { chunkKoText, maskKoMarkup } from './koView'

export async function translateKoView(english: string): Promise<string> {
    if (!english) return ''
    const db = getDatabase()
    const type = db.translatorType
    // No translator, or no target language ("번역기 언어" is Disabled by default).
    if (type === 'none' || !db.translator) throw new Error('translator-none')
    const llm = type === 'llm'
    const result: string[] = []
    // Separators stay outside translate(), whose existing path trims its output.
    const parts = english.split(llm ? /(\n\s*\n)/ : /(\n+)/)
    for (const part of parts) {
        if (!part || (llm ? /^\n\s*\n$/.test(part) : /^\n+$/.test(part))) { result.push(part); continue }
        const masked = llm ? null : maskKoMarkup(part)
        const translatedChunks: string[] = []
        for (const chunk of chunkKoText(masked?.text ?? part, llm ? 6000 : 1500)) {
            const source = chunk
            if (!source.trim()) { translatedChunks.push(chunk); continue }
            // translate() joins a chunk's lines without a break before it sends
            // them, so a paragraph's lines would run together. The LLM translator
            // goes through translateHTML, which sends the text as it is (the chat's
            // own translate path); the others get one line at a time (split above).
            const translated = llm ? await translateHTML(source, false, '', -1) : await translate(source, false)
            if (typeof translated !== 'string' || translated.startsWith('ERR::') || (translated === source && /[A-Za-z]/.test(source))) throw new Error('translation-failed')
            translatedChunks.push(translated)
        }
        result.push(masked ? masked.restore(translatedChunks.join('')) : translatedChunks.join(''))
    }
    return result.join('')
}
