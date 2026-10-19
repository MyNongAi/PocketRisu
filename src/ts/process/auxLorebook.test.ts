import { describe, expect, it } from 'vitest'
import {
    MAX_AUX_TAGS_PER_REPLY,
    auxEntryText,
    auxLorebookEntries,
    buildAuxTagPrompt,
    insertAuxTags,
    mergeAuxLines,
    parseAuxTagEdits,
    rememberAuxLines,
    setAuxMark,
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
