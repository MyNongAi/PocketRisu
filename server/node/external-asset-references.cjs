'use strict'

// Keep this module free of server and storage dependencies. Migration first
// stages and verifies external objects, then uses these helpers to prepare a
// replacement DB without touching the live decoded object.

function isInternalAssetPath(value) {
    return typeof value === 'string' && value.length > 'assets/'.length && value.startsWith('assets/')
}

function isExternalAssetPath(value) {
    return typeof value === 'string' && /^external:\/\/[a-z0-9][a-z0-9._-]*\/[a-f0-9]{64}$/.test(value)
}

// Stored Risu assets are flat `assets/<id>.<extension>` keys. Match those
// keys when they occur as complete tokens inside HTML, CSS, plugin source, or
// other database strings. Explicit boundaries keep remote `/assets/...`
// URLs, longer identifiers such as `notassets/...`, and nested paths from
// retaining an unrelated local object.
const embeddedInternalAssetPattern = /(?:^|[\s"'`([{=,:>])assets\/([A-Za-z0-9][A-Za-z0-9._~-]*)(?=$|[\s"'`()\]}>,;!?&#])/g

/**
 * Conservatively collect the basenames of exact internal asset references
 * embedded anywhere in a decoded database. The input is not mutated, cycles
 * are supported, and accessors are not invoked.
 */
function collectEmbeddedInternalAssetNames(db) {
    const names = new Set()
    const seen = new WeakSet()

    const collectString = (value) => {
        embeddedInternalAssetPattern.lastIndex = 0
        let match
        while ((match = embeddedInternalAssetPattern.exec(value)) !== null) names.add(match[1])
    }

    const visit = (value) => {
        if (typeof value === 'string') {
            collectString(value)
            return
        }
        if (value === null || typeof value !== 'object' || seen.has(value)) return
        seen.add(value)

        if (value instanceof Map) {
            for (const [key, child] of value) {
                visit(key)
                visit(child)
            }
            return
        }
        if (value instanceof Set) {
            for (const child of value) visit(child)
            return
        }
        if (Buffer.isBuffer(value) || ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return

        for (const key of Reflect.ownKeys(value)) {
            const descriptor = Object.getOwnPropertyDescriptor(value, key)
            if (descriptor && 'value' in descriptor) visit(descriptor.value)
        }
    }

    visit(db)
    return names
}

function jsonPointer(segments) {
    return `/${segments.map((part) => String(part).replace(/~/g, '~0').replace(/\//g, '~1')).join('/')}`
}

function ownerId(value, fallback) {
    if (typeof value === 'string' && value.length > 0) return value
    if (typeof value === 'number' && Number.isFinite(value)) return String(value)
    return fallback
}

/**
 * Return every supported character/module asset occurrence. Deliberately do
 * not deduplicate values: callers need all locations in order to rewrite a DB
 * atomically after uploading each unique object once.
 *
 * `path` is an RFC 6901 JSON pointer. `pathSegments` is included for callers
 * that prefer structural access and must not be used to mutate the input DB.
 */
function enumerateAssetReferences(db, predicate = isInternalAssetPath) {
    const references = []

    const add = (ownerType, id, field, pathSegments, value) => {
        if (!predicate(value)) return
        references.push({
            ownerType,
            ownerId: id,
            field,
            path: jsonPointer(pathSegments),
            pathSegments: [...pathSegments],
            value,
        })
    }

    if (!db || typeof db !== 'object') return references

    if (Array.isArray(db.characters)) {
        for (let characterIndex = 0; characterIndex < db.characters.length; characterIndex++) {
            const character = db.characters[characterIndex]
            if (!character || typeof character !== 'object') continue

            const base = ['characters', characterIndex]
            const id = ownerId(character.chaId ?? character.id, `characters[${characterIndex}]`)
            add('character', id, 'image', [...base, 'image'], character.image)

            if (Array.isArray(character.emotionImages)) {
                for (let assetIndex = 0; assetIndex < character.emotionImages.length; assetIndex++) {
                    const asset = character.emotionImages[assetIndex]
                    if (!Array.isArray(asset)) continue
                    add(
                        'character',
                        id,
                        'emotionImages',
                        [...base, 'emotionImages', assetIndex, 1],
                        asset[1],
                    )
                }
            }

            if (Array.isArray(character.additionalAssets)) {
                for (let assetIndex = 0; assetIndex < character.additionalAssets.length; assetIndex++) {
                    const asset = character.additionalAssets[assetIndex]
                    if (!Array.isArray(asset)) continue
                    add(
                        'character',
                        id,
                        'additionalAssets',
                        [...base, 'additionalAssets', assetIndex, 1],
                        asset[1],
                    )
                }
            }

            const vitsFiles = character.vits?.files
            if (vitsFiles && typeof vitsFiles === 'object' && !Array.isArray(vitsFiles)) {
                for (const key of Object.keys(vitsFiles)) {
                    add(
                        'character',
                        id,
                        'vits.files',
                        [...base, 'vits', 'files', key],
                        vitsFiles[key],
                    )
                }
            }

            if (Array.isArray(character.ccAssets)) {
                for (let assetIndex = 0; assetIndex < character.ccAssets.length; assetIndex++) {
                    const asset = character.ccAssets[assetIndex]
                    if (!asset || typeof asset !== 'object') continue
                    add(
                        'character',
                        id,
                        'ccAssets',
                        [...base, 'ccAssets', assetIndex, 'uri'],
                        asset.uri,
                    )
                }
            }

            add(
                'character',
                id,
                'gptSoVitsConfig.ref_audio_data.assetId',
                [...base, 'gptSoVitsConfig', 'ref_audio_data', 'assetId'],
                character.gptSoVitsConfig?.ref_audio_data?.assetId,
            )
        }
    }

    const visitModule = (module, base, fallbackId) => {
        if (!module || typeof module !== 'object') return
        const id = ownerId(module.id, fallbackId)

        if (Array.isArray(module.assets)) {
            for (let assetIndex = 0; assetIndex < module.assets.length; assetIndex++) {
                const asset = module.assets[assetIndex]
                if (!Array.isArray(asset)) continue
                add('module', id, 'assets', [...base, 'assets', assetIndex, 1], asset[1])
            }
        }

        add('module', id, 'icon', [...base, 'icon'], module.icon)
        // This field normally contains inline HTML/CSS. Only treat it as an
        // asset when the complete value is a storage path; scanning arbitrary
        // HTML would risk rewriting user-authored text and CSS fragments.
        add(
            'module',
            id,
            'backgroundEmbedding',
            [...base, 'backgroundEmbedding'],
            module.backgroundEmbedding,
        )
    }

    if (Array.isArray(db.modules)) {
        for (let moduleIndex = 0; moduleIndex < db.modules.length; moduleIndex++) {
            visitModule(db.modules[moduleIndex], ['modules', moduleIndex], `modules[${moduleIndex}]`)
        }
    }

    // Persona-embedded modules use the same RisuModule shape and are consumed
    // like regular modules. Omitting them would strand their asset packs.
    if (Array.isArray(db.personas)) {
        for (let personaIndex = 0; personaIndex < db.personas.length; personaIndex++) {
            const persona = db.personas[personaIndex]
            if (!persona || typeof persona !== 'object' || !persona.embeddedModule) continue
            const personaId = ownerId(persona.id ?? persona.name, `personas[${personaIndex}]`)
            visitModule(
                persona.embeddedModule,
                ['personas', personaIndex, 'embeddedModule'],
                `${personaId}:embeddedModule`,
            )
        }
    }

    return references
}

function collectAssetReferences(db) {
    return enumerateAssetReferences(db).map((reference) => ({
        ownerType: reference.ownerType,
        ownerId: reference.ownerId,
        field: reference.field,
        path: reference.path,
        value: reference.value,
    }))
}

function collectExternalAssetReferences(db) {
    return enumerateAssetReferences(db, isExternalAssetPath).map((reference) => ({
        ownerType: reference.ownerType,
        ownerId: reference.ownerId,
        field: reference.field,
        path: reference.path,
        value: reference.value,
    }))
}

// Allocation-light traversal for very large databases. The detailed collector
// above intentionally builds an owner object and JSON pointer for every
// occurrence; a migration plan with hundreds of thousands of assets only needs
// the value count and unique keys, so constructing those paths can consume
// gigabytes and keep the Node event loop busy for minutes.
function visitAssetSlots(db, visitor) {
    if (!db || typeof db !== 'object' || typeof visitor !== 'function') return

    const visitModule = (module) => {
        if (!module || typeof module !== 'object') return
        if (Array.isArray(module.assets)) {
            for (const asset of module.assets) {
                if (Array.isArray(asset)) visitor(asset[1], (value) => { asset[1] = value })
            }
        }
        visitor(module.icon, (value) => { module.icon = value })
        visitor(module.backgroundEmbedding, (value) => { module.backgroundEmbedding = value })
    }

    if (Array.isArray(db.characters)) {
        for (const character of db.characters) {
            if (!character || typeof character !== 'object') continue
            visitor(character.image, (value) => { character.image = value })
            if (Array.isArray(character.emotionImages)) {
                for (const asset of character.emotionImages) {
                    if (Array.isArray(asset)) visitor(asset[1], (value) => { asset[1] = value })
                }
            }
            if (Array.isArray(character.additionalAssets)) {
                for (const asset of character.additionalAssets) {
                    if (Array.isArray(asset)) visitor(asset[1], (value) => { asset[1] = value })
                }
            }
            const vitsFiles = character.vits?.files
            if (vitsFiles && typeof vitsFiles === 'object' && !Array.isArray(vitsFiles)) {
                for (const key of Object.keys(vitsFiles)) {
                    visitor(vitsFiles[key], (value) => { vitsFiles[key] = value })
                }
            }
            if (Array.isArray(character.ccAssets)) {
                for (const asset of character.ccAssets) {
                    if (asset && typeof asset === 'object') visitor(asset.uri, (value) => { asset.uri = value })
                }
            }
            const refAudio = character.gptSoVitsConfig?.ref_audio_data
            if (refAudio && typeof refAudio === 'object') {
                visitor(refAudio.assetId, (value) => { refAudio.assetId = value })
            }
        }
    }

    if (Array.isArray(db.modules)) {
        for (const module of db.modules) visitModule(module)
    }
    if (Array.isArray(db.personas)) {
        for (const persona of db.personas) visitModule(persona?.embeddedModule)
    }
}

function collectAssetReferenceSummary(db, predicate = isInternalAssetPath) {
    let references = 0
    const uniquePaths = new Set()
    visitAssetSlots(db, (value) => {
        if (!predicate(value)) return
        references++
        uniquePaths.add(value)
    })
    return { references, uniquePaths }
}

/**
 * Rewrite a detached decoded snapshot without cloning it again. Intended for
 * migration workers: callers must never pass the live in-memory client DB.
 */
function rewriteAssetReferencesInPlace(db, mapping, predicate = isInternalAssetPath) {
    let changes = 0
    visitAssetSlots(db, (value, setValue) => {
        if (!predicate(value)) return
        const replacement = replacementFor(mapping, value)
        if (replacement === undefined || replacement === value) return
        setValue(replacement)
        changes++
    })
    return { database: db, changes }
}

function deepClone(value, seen = new WeakMap()) {
    if (value === null || typeof value !== 'object') return value
    if (seen.has(value)) return seen.get(value)

    if (Buffer.isBuffer(value)) {
        const clone = Buffer.from(value)
        seen.set(value, clone)
        return clone
    }
    if (value instanceof Date) {
        const clone = new Date(value.getTime())
        seen.set(value, clone)
        return clone
    }
    if (value instanceof RegExp) {
        const clone = new RegExp(value.source, value.flags)
        clone.lastIndex = value.lastIndex
        seen.set(value, clone)
        return clone
    }
    if (value instanceof Map) {
        const clone = new Map()
        seen.set(value, clone)
        for (const [key, child] of value) clone.set(deepClone(key, seen), deepClone(child, seen))
        return clone
    }
    if (value instanceof Set) {
        const clone = new Set()
        seen.set(value, clone)
        for (const child of value) clone.add(deepClone(child, seen))
        return clone
    }
    if (ArrayBuffer.isView(value)) {
        const clone = new value.constructor(value)
        seen.set(value, clone)
        return clone
    }
    if (value instanceof ArrayBuffer) {
        const clone = value.slice(0)
        seen.set(value, clone)
        return clone
    }

    const clone = Array.isArray(value) ? new Array(value.length) : Object.create(Object.getPrototypeOf(value))
    seen.set(value, clone)
    for (const key of Reflect.ownKeys(value)) {
        if (Array.isArray(value) && key === 'length') continue
        const descriptor = Object.getOwnPropertyDescriptor(value, key)
        if (!descriptor) continue
        if ('value' in descriptor) descriptor.value = deepClone(descriptor.value, seen)
        // The staged DB must remain writable even when a caller freezes its
        // input snapshot. Accessors are retained without invoking them.
        descriptor.configurable = true
        if ('writable' in descriptor) descriptor.writable = true
        Object.defineProperty(clone, key, descriptor)
    }
    return clone
}

function replacementFor(mapping, value) {
    if (!mapping) return undefined
    let replacement
    if (mapping instanceof Map) {
        if (!mapping.has(value)) return undefined
        replacement = mapping.get(value)
    } else if (typeof mapping === 'object' && Object.prototype.hasOwnProperty.call(mapping, value)) {
        replacement = mapping[value]
    } else {
        return undefined
    }
    return typeof replacement === 'string' && replacement.length > 0 ? replacement : undefined
}

function setAtPath(root, segments, value) {
    let target = root
    for (let i = 0; i < segments.length - 1; i++) {
        if (target === null || typeof target !== 'object') {
            throw new TypeError(`Asset reference path became invalid at ${jsonPointer(segments.slice(0, i + 1))}`)
        }
        target = target[segments[i]]
    }
    if (target === null || typeof target !== 'object') {
        throw new TypeError(`Asset reference parent is invalid at ${jsonPointer(segments)}`)
    }
    target[segments[segments.length - 1]] = value
}

/**
 * Produce a fully detached, rewritten DB snapshot. The input is never mutated;
 * if cloning or applying a staged path throws, no partially rewritten object is
 * returned to the caller.
 */
function rewriteReferences(db, mapping, predicate) {
    const staged = deepClone(db)
    const references = enumerateAssetReferences(staged, predicate)
    const changes = []

    for (const reference of references) {
        const replacement = replacementFor(mapping, reference.value)
        if (replacement === undefined || replacement === reference.value) continue
        changes.push({ segments: reference.pathSegments, replacement })
    }

    for (const change of changes) setAtPath(staged, change.segments, change.replacement)
    return staged
}

function rewriteAssetReferences(db, mapping) {
    return rewriteReferences(db, mapping, isInternalAssetPath)
}

function rewriteExternalAssetReferences(db, mapping) {
    return rewriteReferences(db, mapping, isExternalAssetPath)
}

module.exports = {
    collectAssetReferences,
    collectAssetReferenceSummary,
    collectEmbeddedInternalAssetNames,
    collectExternalAssetReferences,
    isExternalAssetPath,
    isInternalAssetPath,
    rewriteAssetReferences,
    rewriteAssetReferencesInPlace,
    rewriteExternalAssetReferences,
}
