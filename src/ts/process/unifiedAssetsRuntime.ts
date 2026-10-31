// 에셋 통일 in a chat (unifiedAssets.ts has the rules): the bot's and its
// modules' asset names gathered into one index, the reply's image tags
// rewritten through it, and the image rule for the request.
import type { Chat, character } from '../storage/database.svelte'
import { loadAssetManifestItems } from '../globalApi.svelte'
import { getModules, type ModuleRuntimeContext } from './modules'
import { LruMap } from '../util/lruMap'
import {
    buildAssetGuide,
    buildAssetIndex,
    isImageScript,
    replaceImageTags,
    resolveAssetName,
    sourceLabel,
    type AssetIndex,
    type AssetSource,
} from './unifiedAssets'

type AssetOwner = {
    name?: string
    assets?: string[][] | null
    additionalAssets?: string[][] | null
    assetManifest?: { id?: string } | null
    additionalAssetManifest?: { id?: string } | null
}

export function unifiedAssetsOn(chat: Chat | null | undefined): boolean {
    return !!chat?.nodeOnlyUnifiedAssets
}

/** The scripts to run: without the image ones while the switch is on. */
export function withoutImageScripts<T extends { in?: string }>(scripts: T[] | undefined, on: boolean): T[] {
    if (!scripts) return []
    return on ? scripts.filter((script) => !isImageScript(script)) : scripts
}

async function namesOf(owner: AssetOwner): Promise<string[]> {
    const inline = owner.assets ?? owner.additionalAssets
    if (inline?.length) return inline.map((asset) => String(asset[0]))
    const manifest = owner.assetManifest ?? owner.additionalAssetManifest
    if (!manifest) return []
    try {
        const items = await loadAssetManifestItems(manifest as Parameters<typeof loadAssetManifestItems>[0])
        return items.map((item) => String(item[0]))
    } catch {
        return []
    }
}

const indexes = new LruMap<string, { sources: AssetSource[], index: AssetIndex }>(8)

function signature(char: AssetOwner & { chaId?: string }, modules: (AssetOwner & { id?: string })[]): string {
    const part = (owner: AssetOwner, id?: string) =>
        `${id}:${(owner.assets ?? owner.additionalAssets)?.length ?? 0}:${(owner.assetManifest ?? owner.additionalAssetManifest)?.id ?? ''}`
    return [part(char, char.chaId), ...modules.map((module) => part(module, module.id))].join('|')
}

/** The bot first, then its modules, each as one source of names. */
export async function unifiedAssetIndex(char: character, context?: ModuleRuntimeContext): Promise<{ sources: AssetSource[], index: AssetIndex }> {
    const modules = getModules(context).filter(Boolean)
    const key = signature(char, modules)
    const cached = indexes.get(key)
    if (cached) return cached
    const sources: AssetSource[] = [{ label: char.name || 'Bot', names: await namesOf(char) }]
    for (const module of modules) {
        const names = await namesOf(module)
        if (names.length) sources.push({ label: sourceLabel(module.name, 'Module'), names })
    }
    const built = { sources, index: buildAssetIndex(sources) }
    indexes.set(key, built)
    return built
}

// The head (outfit, character) each source last used in a chat, so a reply
// that names only a keyword keeps the look it had.
const lastHeads = new LruMap<string, Map<number, string>>(32)

/**
 * The reply's image tags, whatever their shape: for the screen as the
 * official {{img::name}}, for the request as <img="name"> (the one shape the
 * rule asks for). Names that match nothing are left as they were.
 */
export async function unifyImageTags(
    text: string,
    target: 'display' | 'request',
    char: character,
    chat: Chat | null | undefined,
    context?: ModuleRuntimeContext,
    seed = '',
): Promise<string> {
    if (!text || !/img|imag|lmg/i.test(text)) return text
    const { index } = await unifiedAssetIndex(char, context)
    if (index.entries.length === 0) return text
    const chatKey = `${chat?.id ?? ''}`
    let lastHead = lastHeads.get(chatKey)
    if (!lastHead) {
        lastHead = new Map()
        lastHeads.set(chatKey, lastHead)
    }
    return replaceImageTags(text, (name, occurrence) => {
        const found = resolveAssetName(index, name, { seed: `${seed}:${occurrence}`, lastHead })
        if (!found) return null
        return target === 'display'
            ? `{{img::${found.name}}}`
            : `<img="${found.name.replace(/\.(?:png|webp|jpe?g|gif|avif|bmp|mp4|webm)$/i, '')}">`
    })
}

/** The image rule the request carries while the switch is on. */
export async function unifiedAssetGuide(char: character, context?: ModuleRuntimeContext): Promise<string> {
    const { sources } = await unifiedAssetIndex(char, context)
    return buildAssetGuide(sources)
}
