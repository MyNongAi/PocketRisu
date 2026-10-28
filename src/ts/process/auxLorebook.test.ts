import { describe, expect, it } from 'vitest'
import {
    MAX_AUX_TAGS_PER_REPLY,
    auxAssetSettings,
    auxEntryText,
    auxLorebookEntries,
    buildAuxTagPrompt,
    insertAuxTags,
    isAutoIllustration,
    loreRole,
    markedLorebookEntries,
    mergeAuxLines,
    parseAuxTagEdits,
    rememberAuxLines,
    setAuxMark,
    setLoreRole,
    splitReplyForTags,
    withoutAuxLines,
} from './auxLorebook'

describe('marked entries', () => {
    it('takes the marked entries with text, in order, from every lorebook', () => {
        const rules = { comment: 'rules', content: 'Use <img="name">', nodeOnlyAuxModel: true }
        const story = { comment: 'story', content: 'The world', alwaysActive: true }
        const folder = { comment: 'f', content: '', mode: 'folder', key: 'f1', nodeOnlyAuxModel: true }
        const empty = { comment: 'empty', content: '  ', nodeOnlyAuxModel: true }
        const list = { comment: 'names', content: 'happy, sad', nodeOnlyAuxModel: true }
        expect(auxLorebookEntries([[story, rules], undefined, [folder, empty, list]])).toEqual([rules, list])
        expect(auxLorebookEntries([[story]])).toEqual([])
    })

    it('gives each entry one role: main, asset (🌙) or illustration (🎨)', () => {
        const entry = { content: 'x' } as any
        expect(loreRole(entry)).toBe('main')
        setLoreRole(entry, [], 'illustration')
        expect(loreRole(entry)).toBe('illustration')
        setLoreRole(entry, [], 'asset')
        expect([loreRole(entry), entry.nodeOnlyIllustration]).toEqual(['asset', undefined])
        const art = { content: 'looks', nodeOnlyIllustration: true }
        expect(markedLorebookEntries([[entry, art]], 'illustration')).toEqual([art])
        expect(markedLorebookEntries([[entry, art]], 'asset')).toEqual([entry])
        setLoreRole(entry, [], 'main')
        expect('nodeOnlyAuxModel' in entry || 'nodeOnlyIllustration' in entry).toBe(false)
    })

    // Lightboard's illustration lorebook is for illustrations by its title alone
    // (the user's call, 2026-10-28); a 🌙 or 🎨 the user set still wins.
    it('takes an entry titled "lb-xnai.lb.extra" for illustrations', () => {
        const looks = { comment: ' lb-xnai.lb.extra ', content: 'Mira: red hair', alwaysActive: true } as any
        expect([loreRole(looks), isAutoIllustration(looks)]).toEqual(['illustration', true])
        expect(markedLorebookEntries([[looks]], 'illustration')).toEqual([looks])
        setLoreRole(looks, [], 'illustration')
        expect([loreRole(looks), isAutoIllustration(looks)]).toEqual(['illustration', false])
        setLoreRole(looks, [], 'asset')
        expect(loreRole(looks)).toBe('asset')
        expect(loreRole({ comment: 'lb-xnai.lb.extra', mode: 'folder', content: '' })).toBe('main')
        expect(loreRole({ comment: '[x] lb-xnai.lb.extra', content: 'x' })).toBe('main')
    })

    it('reads an entry without its decorator lines', () => {
        expect(auxEntryText('@@depth 0\n@@unrecursive\n## Image rules\nUse <img="x">')).toBe('## Image rules\nUse <img="x">')
    })

    it('marks and unmarks, a folder with the entries in it', () => {
        const folder = { mode: 'folder', key: 'f1', content: '' } as any
        const inside = { folder: 'f1', content: 'a' } as any
        const outside = { folder: 'f2', content: 'b' } as any
        const all = [folder, inside, outside]
        setAuxMark(folder, all, true)
        expect([folder.nodeOnlyAuxModel, inside.nodeOnlyAuxModel, outside.nodeOnlyAuxModel]).toEqual([true, true, undefined])
        setAuxMark(folder, all, false)
        expect('nodeOnlyAuxModel' in folder || 'nodeOnlyAuxModel' in inside).toBe(false)
    })
})

describe('the lines the auxiliary model added', () => {
    it('are left out of a reply, and only exact lines', () => {
        const text = 'He smiles.\n<img="maah_happy">\n"Hi."\n<img="maah_happy"> and more'
        expect(withoutAuxLines(text, ['<img="maah_happy">'])).toBe('He smiles.\n"Hi."\n<img="maah_happy"> and more')
        expect(withoutAuxLines(text, undefined)).toBe(text)
    })

    it('are remembered once each, a multi-line tag line by line', () => {
        const message = {} as { nodeOnlyAuxLines?: string[] }
        rememberAuxLines(message, ['<img="a">', ' <img="a"> ', '<b>\n<c>'])
        expect(message.nodeOnlyAuxLines).toEqual(['<img="a">', '<b>', '<c>'])
        rememberAuxLines(message, [])
        expect(message.nodeOnlyAuxLines).toEqual(['<img="a">', '<b>', '<c>'])
        expect(mergeAuxLines(['<x>'], ['<x>', '<y>'])).toEqual(['<x>', '<y>'])
        expect(mergeAuxLines(undefined, ['<y>'])).toEqual(['<y>'])
        expect(mergeAuxLines(undefined, undefined)).toBeUndefined()
    })
})

describe("a bot's 🌙 settings", () => {
    it('defaults to two messages with everything off', () => {
        expect(auxAssetSettings(undefined)).toEqual({
            auto: true, contextCount: 2, skipUser: false, description: false, persona: false, mainModel: false, rerollButton: false,
        })
        expect(auxAssetSettings({ auto: false }).auto).toBe(false)
    })

    it('keeps 1–8 messages and only true switches', () => {
        expect(auxAssetSettings({ contextCount: 8, skipUser: true, mainModel: true }).contextCount).toBe(8)
        expect(auxAssetSettings({ contextCount: 1 }).contextCount).toBe(1)
        for (const bad of [0, 9, 2.5, NaN]) expect(auxAssetSettings({ contextCount: bad }).contextCount).toBe(2)
        expect(auxAssetSettings({ persona: 'yes' as any, rerollButton: 1 as any })).toMatchObject({ persona: false, rerollButton: false })
    })
})

describe('tagging a reply', () => {
    it('keeps the reasoning block out of the numbered lines', () => {
        expect(splitReplyForTags('<Thoughts>\nplan\n</Thoughts>\nLine one\nLine two')).toEqual({
            head: '<Thoughts>\nplan\n</Thoughts>\n',
            lines: ['Line one', 'Line two'],
        })
        expect(splitReplyForTags('Only\ntext')).toEqual({ head: '', lines: ['Only', 'text'] })
    })

    it('asks with the rules, the context and the numbered reply', () => {
        const [system, user] = buildAuxTagPrompt({
            rules: ['Use <img="name">', 'Names: happy, sad'],
            lines: ['She laughs.', '"Really?"'],
            context: [{ name: 'User', text: 'Tell me a joke' }],
            charName: 'Maah',
        })
        expect(system.role).toBe('system')
        expect(system.content).toContain('JSON array')
        expect(user.content).toContain('Use <img="name">\n\n---\n\nNames: happy, sad')
        expect(user.content).toContain('User: Tell me a joke')
        expect(user.content).toContain('[1] She laughs.\n[2] "Really?"')
        expect(user.content).not.toContain('(context only)\n')
    })

    it('sends the bot and the persona along only when given', () => {
        const [, user] = buildAuxTagPrompt({
            rules: ['Use <img="name">'],
            lines: ['She laughs.'],
            context: [],
            charName: 'Maah',
            description: 'A cheerful fox girl.',
            persona: { name: 'Jin', text: 'A traveller.' },
        })
        expect(user.content).toContain('# Maah (context only)\nA cheerful fox girl.')
        expect(user.content).toContain('# Jin, the user (context only)\nA traveller.')
        const [, blank] = buildAuxTagPrompt({ rules: ['r'], lines: ['l'], context: [], charName: 'Maah', description: '  ', persona: { name: 'Jin', text: '' } })
        expect(blank.content).not.toContain('context only)\n')
    })

    it('reads the edits from a fenced or bare answer and drops what does not fit', () => {
        expect(parseAuxTagEdits('```json\n[{"line": 1, "content": "<img=\\"a\\">"}]\n```', 2)).toEqual([{ line: 1, content: '<img="a">' }])
        expect(parseAuxTagEdits('Sure: [{"line":"2","content":" <b> "},{"line":9,"content":"x"},{"line":1,"content":""},{"line":1.5,"content":"y"},null]', 2))
            .toEqual([{ line: 2, content: '<b>' }])
        expect(parseAuxTagEdits('no json here', 2)).toEqual([])
        expect(parseAuxTagEdits('[{"line": 1, ', 2)).toEqual([])
        const many = JSON.stringify(Array.from({ length: 30 }, () => ({ line: 1, content: 't' })))
        expect(parseAuxTagEdits(many, 1)).toHaveLength(MAX_AUX_TAGS_PER_REPLY)
    })

    it('inserts after the given lines, before the first for 0, keeping their order', () => {
        const result = insertAuxTags(['a', 'b'], [
            { line: 2, content: '<two>' },
            { line: 0, content: '<top>' },
            { line: 1, content: '<one-1>' },
            { line: 1, content: '<one-2>' },
        ])
        expect(result.lines).toEqual(['<top>', 'a', '<one-1>', '<one-2>', 'b', '<two>'])
        expect(result.added).toEqual(['<two>', '<top>', '<one-1>', '<one-2>'])
    })
})
