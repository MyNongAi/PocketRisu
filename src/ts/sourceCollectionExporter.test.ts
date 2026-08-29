import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const exporterCode = readFileSync(
    join(process.cwd(), 'public/plugins/pocketrisu-source-collection-exporter.js'),
    'utf8',
)

afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    document.body.replaceChildren()
})

describe('API v3 source collection exporter', () => {
    it('requests DB permission before opening fullscreen so old hosts cannot hide the prompt', async () => {
        let settingCallback: (() => Promise<void> | void) | undefined
        const calls: string[] = []
        const risuai = {
            getArgument: vi.fn(async () => ''),
            setArgument: vi.fn(async () => undefined),
            getDatabase: vi.fn(async (keys: string[]) => {
                calls.push(`database:${keys.length}`)
                return {}
            }),
            showContainer: vi.fn(async () => { calls.push('show') }),
            registerSetting: vi.fn(async (_name: string, callback: () => Promise<void> | void) => {
                settingCallback = callback
                return { id: 'source-exporter' }
            }),
        }

        new Function('risuai', exporterCode)(risuai)
        await vi.waitFor(() => expect(settingCallback).toBeTypeOf('function'))
        await settingCallback!()

        expect(calls).toEqual(['database:0', 'show'])
        expect(document.querySelector('#status')?.textContent).toContain('권한 확인은 완료')
    })

    it('uses the public subset API, excludes non-bots, and respects the 10,000 entry part contract', async () => {
        const characters = Array.from({ length: 10_001 }, (_, index) => ({
            type: 'character',
            name: `Bot ${index}`,
            chaId: `bot-${index}`,
            chats: [{ message: [{ role: 'user', data: 'history must not leave' }] }],
            chatFolders: [{ name: 'old chat folder' }],
            sourceInfo: { label: 'old source' },
        }))
        characters.push(
            { type: 'group', name: 'Group', chaId: 'group', chats: [], chatFolders: [], sourceInfo: undefined } as any,
            { type: 'character', name: 'Temp', chaId: '§temp', chats: [], chatFolders: [], sourceInfo: undefined } as any,
            { type: 'character', name: 'Playground', chaId: '§playground', chats: [], chatFolders: [], sourceInfo: undefined } as any,
        )

        const blobs: Blob[] = []
        vi.spyOn(URL, 'createObjectURL').mockImplementation((blob: Blob | MediaSource) => {
            blobs.push(blob as Blob)
            return `blob:test-${blobs.length}`
        })
        vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
        vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)

        let settingCallback: (() => Promise<void> | void) | undefined
        const risuai = {
            getArgument: vi.fn(async (key: string) => key === 'source_label' ? '모바일웹리스' : 12),
            setArgument: vi.fn(async () => undefined),
            getDatabase: vi.fn(async () => ({ characters })),
            readImage: vi.fn(),
            showContainer: vi.fn(),
            registerSetting: vi.fn(async (_name: string, callback: () => Promise<void> | void) => {
                settingCallback = callback
                return { id: 'source-exporter' }
            }),
        }

        new Function('risuai', exporterCode)(risuai)
        await vi.waitFor(() => expect(settingCallback).toBeTypeOf('function'))
        await settingCallback!()
        expect(risuai.showContainer).toHaveBeenCalledWith('fullscreen')

        const button = document.querySelector<HTMLButtonElement>('button[data-kind="characters"]')!
        button.click()
        await vi.waitFor(() => {
            expect(document.querySelector('#status')?.textContent).toContain('완료: 10001개 항목')
        }, { timeout: 5_000 })

        expect(risuai.getDatabase).toHaveBeenCalledWith(['characters'])
        expect(risuai.readImage).not.toHaveBeenCalled()
        expect(blobs).toHaveLength(2)
        const parts = await Promise.all(blobs.map(async (blob) => JSON.parse(await blob.text())))
        expect(parts.map((part) => [part.entities.length, part.last])).toEqual([
            [10_000, false],
            [1, true],
        ])
        expect(parts[0].entities[0]).toMatchObject({ chats: [], chatFolders: [], chatPage: 0 })
        expect(parts[0].entities[0]).not.toHaveProperty('sourceInfo')
    })

    it('uses the host entropy bridge and portable SHA in a no-WebCrypto iframe, persisting the relation id by source', async () => {
        vi.stubGlobal('crypto', {})
        const storageData = new Map<string, unknown>()
        const storage = {
            getItem: vi.fn(async (key: string) => storageData.get(key) ?? null),
            setItem: vi.fn(async (key: string, value: unknown) => { storageData.set(key, value) }),
        }
        let randomCall = 0
        const getSecureRandomBytes = vi.fn(async (length: number) => {
            randomCall += 1
            return Array.from({ length }, (_, index) => (index + randomCall) & 0xff)
        })
        const blobs: Blob[] = []
        vi.spyOn(URL, 'createObjectURL').mockImplementation((blob: Blob | MediaSource) => {
            blobs.push(blob as Blob)
            return `blob:secure-${blobs.length}`
        })
        vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
        vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)

        const runExport = async (kind: 'modules' | 'characters') => {
            let settingCallback: (() => Promise<void> | void) | undefined
            const risuai = {
                getArgument: vi.fn(async (key: string) => key === 'source_label' ? '모바일웹리스' : 12),
                setArgument: vi.fn(async () => undefined),
                getDatabase: vi.fn(async () => kind === 'modules'
                    ? { modules: [{ id: 'old-module', name: 'Module', icon: 'assets/icon.bin' }] }
                    : { characters: [{ type: 'character', chaId: 'old-character', name: 'Bot', modules: ['old-module'], chats: [] }] }),
                readImage: vi.fn(async () => new TextEncoder().encode('asset')),
                getSecureRandomBytes,
                getLocalPluginStorage: vi.fn(async () => storage),
                showContainer: vi.fn(),
                registerSetting: vi.fn(async (_name: string, callback: () => Promise<void> | void) => {
                    settingCallback = callback
                    return { id: 'source-exporter' }
                }),
            }
            new Function('risuai', exporterCode)(risuai)
            await vi.waitFor(() => expect(settingCallback).toBeTypeOf('function'))
            await settingCallback!()
            document.querySelector<HTMLButtonElement>(`button[data-kind="${kind}"]`)!.click()
            await vi.waitFor(() => {
                expect(document.querySelector('#status')?.textContent).toContain('완료:')
            }, { timeout: 5_000 })
        }

        await runExport('modules')
        document.body.replaceChildren()
        await runExport('characters')

        const parts = await Promise.all(blobs.map(async (blob) => JSON.parse(await blob.text())))
        const moduleParts = parts.filter((part) => part.kind === 'modules')
        const characterParts = parts.filter((part) => part.kind === 'characters')
        expect(moduleParts.length).toBeGreaterThan(0)
        expect(characterParts.length).toBeGreaterThan(0)
        expect(new Set([...moduleParts, ...characterParts].map((part) => part.collectionId)).size).toBe(1)
        expect(moduleParts.flatMap((part) => part.assets)[0].sha256).toBe(
            'd59386e0ae435e292fbe0ebcdb954b75ed5fb3922091277cb19f798fc5d50718',
        )
        expect(storage.setItem).toHaveBeenCalledOnce()
        expect(getSecureRandomBytes).toHaveBeenCalled()
    })

    it('records a single oversized asset as omitted instead of failing the entire kind', async () => {
        const blobs: Blob[] = []
        vi.spyOn(URL, 'createObjectURL').mockImplementation((blob: Blob | MediaSource) => {
            blobs.push(blob as Blob)
            return `blob:omitted-${blobs.length}`
        })
        vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
        vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
        let settingCallback: (() => Promise<void> | void) | undefined
        const risuai = {
            getArgument: vi.fn(async (key: string) => key === 'source_label' ? '모바일웹리스' : 12),
            setArgument: vi.fn(async () => undefined),
            getDatabase: vi.fn(async () => ({
                characters: [{ type: 'character', chaId: 'old', name: 'Bot', image: 'assets/large.bin', chats: [] }],
            })),
            readImage: vi.fn(async () => new Uint8Array((16 * 1024 * 1024) + 1)),
            getLocalPluginStorage: vi.fn(async () => ({ getItem: async () => null, setItem: async () => undefined })),
            showContainer: vi.fn(),
            registerSetting: vi.fn(async (_name: string, callback: () => Promise<void> | void) => {
                settingCallback = callback
                return { id: 'source-exporter' }
            }),
        }

        new Function('risuai', exporterCode)(risuai)
        await vi.waitFor(() => expect(settingCallback).toBeTypeOf('function'))
        await settingCallback!()
        document.querySelector<HTMLButtonElement>('button[data-kind="characters"]')!.click()
        await vi.waitFor(() => {
            expect(document.querySelector('#status')?.textContent).toContain('에셋 누락 1')
        }, { timeout: 5_000 })

        const parts = await Promise.all(blobs.map(async (blob) => JSON.parse(await blob.text())))
        expect(parts.flatMap((part) => part.omittedAssets)).toEqual([{
            path: 'assets/large.bin',
            size: (16 * 1024 * 1024) + 1,
            reason: 'too-large',
        }])
        expect(parts.some((part) => part.last)).toBe(true)
        expect(parts.flatMap((part) => part.entities)[0].image).toBe('assets/large.bin')
    })

    it('finishes a persona export while recording an unreadable host asset', async () => {
        const blobs: Blob[] = []
        vi.spyOn(URL, 'createObjectURL').mockImplementation((blob: Blob | MediaSource) => {
            blobs.push(blob as Blob)
            return `blob:read-failed-${blobs.length}`
        })
        vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
        vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
        vi.spyOn(console, 'warn').mockImplementation(() => undefined)
        let settingCallback: (() => Promise<void> | void) | undefined
        const risuai = {
            getArgument: vi.fn(async (key: string) => key === 'source_label' ? '로컬리스' : 12),
            setArgument: vi.fn(async () => undefined),
            getDatabase: vi.fn(async () => ({
                personas: [{ id: 'persona-1', name: 'Persona', icon: 'assets/missing.png' }],
            })),
            readImage: vi.fn(async () => { throw new Error('Host execution error') }),
            getLocalPluginStorage: vi.fn(async () => ({ getItem: async () => null, setItem: async () => undefined })),
            showContainer: vi.fn(),
            registerSetting: vi.fn(async (_name: string, callback: () => Promise<void> | void) => {
                settingCallback = callback
                return { id: 'source-exporter' }
            }),
        }

        new Function('risuai', exporterCode)(risuai)
        await vi.waitFor(() => expect(settingCallback).toBeTypeOf('function'))
        await settingCallback!()
        document.querySelector<HTMLButtonElement>('button[data-kind="personas"]')!.click()
        await vi.waitFor(() => {
            expect(document.querySelector('#status')?.textContent).toContain('완료: 1개 항목')
        }, { timeout: 5_000 })

        const parts = await Promise.all(blobs.map(async (blob) => JSON.parse(await blob.text())))
        expect(parts.flatMap((part) => part.omittedAssets)).toEqual([{
            path: 'assets/missing.png',
            size: 0,
            reason: 'read-failed',
        }])
        expect(parts.some((part) => part.last)).toBe(true)
        expect(parts.flatMap((part) => part.entities)[0].icon).toBe('assets/missing.png')
    })
})
