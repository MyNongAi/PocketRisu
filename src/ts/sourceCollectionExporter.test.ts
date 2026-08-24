import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const exporterCode = readFileSync(
    join(process.cwd(), 'public/plugins/pocketrisu-source-collection-exporter.js'),
    'utf8',
)

afterEach(() => {
    vi.restoreAllMocks()
    document.body.replaceChildren()
})

describe('API v3 source collection exporter', () => {
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
})
