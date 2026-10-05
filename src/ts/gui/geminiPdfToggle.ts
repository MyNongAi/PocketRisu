import { getModelInfo, LLMFormat } from '../model/modellist'
import { resolveChatModelBinding } from '../process/request/modelPresetBinding'
import { getDatabase, type Chat } from '../storage/database.svelte'

/**
 * Whether this chat's replies go to Gemini natively, the requests the
 * "send the context as a PDF" switch applies to (GEMINI-PDF-INPUT): a
 * google-gemini model preset, or a classic Google AI / Vertex Gemini model.
 * The chat input's ☰ menu shows its toggle only then.
 */
export function chatSendsToNativeGemini(chat: Chat | null | undefined): boolean {
    const binding = resolveChatModelBinding(chat, 'model')
    if (binding.kind === 'modelPreset') return binding.preset.profileSnapshot?.adapterKind === 'google-gemini'
    if (binding.kind !== 'classic') return false
    const format = getModelInfo(getDatabase().aiModel).format
    return format === LLMFormat.GoogleCloud || format === LLMFormat.VertexAIGemini
}
