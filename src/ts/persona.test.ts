import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
    dbRef: { db: {} as any },
    saveImage: vi.fn(),
    validatePersonaImage: vi.fn(),
    requestImmediateSave: vi.fn(async () => undefined),
}))

vi.mock(import('./storage/database.svelte'), () => ({
    getDatabase: () => mocks.dbRef.db,
    saveImage: mocks.saveImage,
    setDatabase: vi.fn(),
} as any))

vi.mock(import('./personaImage'), () => ({
    PERSONA_IMAGE_EXTENSIONS: ['png', 'webp', 'gif', 'jpg', 'jpeg'],
    validatePersonaImage: mocks.validatePersonaImage,
} as any))

vi.mock(import('./globalApi.svelte'), () => ({
    AppendableBuffer: class AppendableBuffer {},
    downloadFile: vi.fn(),
    readImage: vi.fn(),
    requestImmediateSave: mocks.requestImmediateSave,
} as any))

vi.mock(import('./util'), () => ({
    selectSingleFile: vi.fn(),
    sleep: vi.fn(async () => undefined),
} as any))

vi.mock(import('./alert'), () => ({
    alertError: vi.fn(),
    alertStore: { set: vi.fn() },
    notifySuccess: vi.fn(),
    notifyError: vi.fn(),
} as any))

vi.mock(import('../lang'), () => ({
    language: {
        unsupportedFileType: 'Unsupported file type',
        errors: { noData: 'No data' },
        successExport: 'Exported',
        successImport: 'Imported',
    },
} as any))

vi.mock(import('./process/files/inlays'), () => ({
    reencodeImage: vi.fn(async (data: Uint8Array) => data),
} as any))

vi.mock(import('./pngChunk'), () => ({
    PngChunk: {
        readGenerator: vi.fn(),
        write: vi.fn(),
    },
} as any))

vi.mock('uuid', () => ({ v4: vi.fn(() => 'generated-persona-id') } as any))

import { setUserPersonaImage } from './persona'

type Deferred<T> = {
    promise: Promise<T>
    resolve: (value: T) => void
    reject: (reason?: unknown) => void
}

function deferred<T>(): Deferred<T> {
    let resolve!: (value: T) => void
    let reject!: (reason?: unknown) => void
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise
        reject = rejectPromise
    })
    return { promise, resolve, reject }
}

function persona(id: string, name: string, icon: string) {
    return {
        id,
        name,
        icon,
        personaPrompt: `${name} prompt`,
        note: `${name} note`,
    }
}

function setupDatabase() {
    const alpha = persona('alpha', 'Alpha', 'alpha-old.png')
    const beta = persona('beta', 'Beta', 'beta-old.png')
    mocks.dbRef.db = {
        personas: [alpha, beta],
        selectedPersona: 0,
        username: alpha.name,
        userIcon: alpha.icon,
        personaPrompt: alpha.personaPrompt,
        userNote: alpha.note,
    }
    return { alpha, beta }
}

beforeEach(() => {
    vi.clearAllMocks()
    mocks.validatePersonaImage.mockResolvedValue({
        type: 'WEBP',
        extension: 'webp',
        mime: 'image/webp',
        width: 1,
        height: 1,
    })
})

describe('setUserPersonaImage', () => {
    it('targets a stable persona id when the array is reordered during storage', async () => {
        const { alpha, beta } = setupDatabase()
        const imageWrite = deferred<string>()
        mocks.saveImage.mockReturnValueOnce(imageWrite.promise)

        const result = setUserPersonaImage(new Uint8Array([1]), 1)
        await vi.waitFor(() => expect(mocks.saveImage).toHaveBeenCalledOnce())
        expect(mocks.saveImage).toHaveBeenCalledWith(
            new Uint8Array([1]),
            '',
            'persona.webp',
        )

        mocks.dbRef.db.personas = [beta, alpha]
        mocks.dbRef.db.selectedPersona = 1
        imageWrite.resolve('assets/new-beta.webp')
        await expect(result).resolves.toBe('assets/new-beta.webp')

        expect(mocks.dbRef.db.personas[0]).toMatchObject({ id: 'beta', icon: 'assets/new-beta.webp' })
        expect(mocks.dbRef.db.personas[1]).toMatchObject({ id: 'alpha', icon: 'alpha-old.png' })
        expect(mocks.dbRef.db.userIcon).toBe('alpha-old.png')
    })

    it('mirrors the icon only when the target is active at storage completion', async () => {
        const { alpha, beta } = setupDatabase()
        const imageWrite = deferred<string>()
        mocks.saveImage.mockReturnValueOnce(imageWrite.promise)

        const result = setUserPersonaImage(new Uint8Array([2]), 1)
        await vi.waitFor(() => expect(mocks.saveImage).toHaveBeenCalledOnce())

        mocks.dbRef.db.personas = [beta, alpha]
        mocks.dbRef.db.selectedPersona = 0
        mocks.dbRef.db.username = 'Beta edited'
        mocks.dbRef.db.userIcon = 'beta-old.png'
        mocks.dbRef.db.personaPrompt = 'Beta edited prompt'
        mocks.dbRef.db.userNote = 'Beta edited note'
        imageWrite.resolve('assets/new-beta.webp')
        await result

        expect(mocks.dbRef.db.userIcon).toBe('assets/new-beta.webp')
        expect(mocks.dbRef.db.personas[0]).toMatchObject({
            id: 'beta',
            name: 'Beta edited',
            icon: 'assets/new-beta.webp',
            personaPrompt: 'Beta edited prompt',
            note: 'Beta edited note',
        })
    })

    it('does not overwrite a remaining persona when the target is deleted', async () => {
        const { alpha } = setupDatabase()
        const imageWrite = deferred<string>()
        mocks.saveImage.mockReturnValueOnce(imageWrite.promise)

        const result = setUserPersonaImage(new Uint8Array([3]), 1)
        await vi.waitFor(() => expect(mocks.saveImage).toHaveBeenCalledOnce())
        mocks.dbRef.db.personas = [alpha]
        mocks.dbRef.db.selectedPersona = 0
        imageWrite.resolve('assets/orphan.webp')

        await expect(result).rejects.toThrow('Persona was removed')
        expect(mocks.dbRef.db.personas).toEqual([alpha])
        expect(mocks.dbRef.db.userIcon).toBe('alpha-old.png')
    })

    it('keeps the old icon unchanged until decode and asset storage both succeed', async () => {
        const { beta } = setupDatabase()
        const decode = deferred<any>()
        const imageWrite = deferred<string>()
        mocks.validatePersonaImage.mockReturnValueOnce(decode.promise)
        mocks.saveImage.mockReturnValueOnce(imageWrite.promise)

        const result = setUserPersonaImage(new Uint8Array([4]), 1)
        expect(beta.icon).toBe('beta-old.png')

        decode.resolve({ type: 'PNG', extension: 'png', mime: 'image/png', width: 1, height: 1 })
        await vi.waitFor(() => expect(mocks.saveImage).toHaveBeenCalledOnce())
        expect(beta.icon).toBe('beta-old.png')

        imageWrite.resolve('assets/new-beta.png')
        await result
        expect(mocks.dbRef.db.personas[1].icon).toBe('assets/new-beta.png')
    })
})
