import { describe, expect, it } from 'vitest'
import {
    baseChatName,
    branchGraphTarget,
    buildBranchForest,
    buildBranchGraphGitRows,
    buildBranchGraphLanes,
    compactChat,
    compactMessage,
    CONTEXT_RADIUS,
    MAX_SWIPE_NODES,
    parseBranchLink,
    pickChatsToLoad,
    previewText,
    projectBranchGraph,
    resolveSwipeIndex,
    unloadedChat,
    visibleSwipeIndexes,
    type GraphChat,
    type SourceMessage,
} from './branches'

// ── Fixtures ────────────────────────────────────────────────────────────────

const user = (data: string, chatId = data): SourceMessage => ({ role: 'user', data, chatId })
const char = (data: string, chatId = data, extra: Partial<SourceMessage> = {}): SourceMessage => ({ role: 'char', data, chatId, ...extra })
const branchComment = (parentId: string, parentName: string, messageId: string, chatId = `c-${parentId}-${messageId}`): SourceMessage => ({
    role: 'char',
    data: `{{specialcomment::branchedfrom::${parentId}::${parentName}::${messageId}::}}`,
    isComment: true,
    disabled: true,
    chatId,
})

function chat(index: number, id: string, messages: (SourceMessage | null)[], extra: { name?: string, lastDate?: number, folderId?: string } = {}): GraphChat {
    return compactChat({ id, name: extra.name ?? id, message: messages, lastDate: extra.lastDate, folderId: extra.folderId }, index, 'Hello there')
}

// Branch like Chat.svelte does: copy up to `at`, fresh ids, comment last.
function branchOf(index: number, id: string, parentId: string, parent: SourceMessage[], at: number, extra: { name?: string, lastDate?: number, folderId?: string } = {}, more: SourceMessage[] = []): GraphChat {
    const copied = parent.slice(0, at + 1).map((message, k) => ({ ...message, chatId: `${id}-copy-${k}` }))
    return chat(index, id, [...copied, branchComment(parentId, parentId, parent[at].chatId ?? ''), ...more], extra)
}

function linear(count: number, prefix = 'm'): SourceMessage[] {
    return Array.from({ length: count }, (_, k) => k % 2 === 0 ? user(`${prefix}${k}`) : char(`${prefix}${k}`))
}

function pathPreviews(forest: ReturnType<typeof buildBranchForest>, chatIndex: number): string[] {
    const end = [...forest.terminals].find(([, chats]) => chats.includes(chatIndex))![0]
    const previews: string[] = []
    let current: string | null = end
    while (current) {
        const node = forest.nodes.get(current)!
        previews.unshift(node.kind === 'message' ? node.preview : `[${node.kind}]`)
        current = node.parent
    }
    return previews
}

// ── Parsing and compaction ──────────────────────────────────────────────────

describe('parseBranchLink', () => {
    it('reads the parent chat, its name and the branched message', () => {
        expect(parseBranchLink('{{specialcomment::branchedfrom::chat-1::My chat::msg-9::}}')).toEqual({
            parentChatId: 'chat-1', parentChatName: 'My chat', parentMessageId: 'msg-9',
        })
    })

    it('keeps a chat name that contains the separator', () => {
        expect(parseBranchLink('{{specialcomment::branchedfrom::a::x::y::m::}}')?.parentChatName).toBe('x::y')
        expect(parseBranchLink('{{specialcomment::branchedfrom::a::x::y::m::}}')?.parentMessageId).toBe('m')
    })

    it('treats a missing message id as unknown and ignores other text', () => {
        expect(parseBranchLink('{{specialcomment::branchedfrom::a::n::undefined::}}')?.parentMessageId).toBe('')
        expect(parseBranchLink('hello')).toBeNull()
        expect(parseBranchLink('{{specialcomment::branchedfrom::::n::m::}}')).toBeNull()
        expect(parseBranchLink(undefined)).toBeNull()
    })
})

describe('previewText', () => {
    it('drops tags, folds whitespace and caps the length', () => {
        expect(previewText('<p>Hi\n\n  <b>there</b></p>')).toBe('Hi there')
        const long = previewText('word '.repeat(500))
        expect(long.length).toBeLessThanOrEqual(160)
        expect(long.endsWith('…')).toBe(true)
        expect(previewText(42)).toBe('')
    })

    it('reads only the head of a huge message', () => {
        expect(previewText('a'.repeat(10) + ' ' + 'b'.repeat(5_000_000)).startsWith('aaaaaaaaaa b')).toBe(true)
    })
})

describe('compactMessage', () => {
    it('keeps swipe previews only when there is something to switch to', () => {
        expect(compactMessage(char('a', 'a', { swipes: ['a', 'b', 'c'], swipeId: 1 }))).toMatchObject({ swipes: ['a', 'b', 'c'], swipeId: 1 })
        expect(compactMessage(char('a', 'a', { swipes: ['a'], swipeId: 0 })).swipes).toBeNull()
        expect(compactMessage(char('a', 'a', { swipes: ['a', 'b'], swipeId: 9 })).swipeId).toBe(1)
    })

    it('turns a broken slot into an empty message so positions line up', () => {
        expect(compactMessage(null)).toMatchObject({ id: '', role: 'char', preview: '' })
    })

    it('shows a branch comment as the parent chat name', () => {
        expect(compactMessage(branchComment('p', 'Parent', 'm'))).toMatchObject({ preview: 'Parent', isComment: true, link: { parentChatId: 'p' } })
    })
})

// ── Forest ──────────────────────────────────────────────────────────────────

describe('buildBranchForest', () => {
    it('makes one chain per chat with its greeting as the root', () => {
        const forest = buildBranchForest([chat(0, 'A', linear(4))], 0)
        expect(forest.roots).toEqual(['root:A'])
        expect(forest.nodes.get('root:A')?.preview).toBe('Hello there')
        expect(pathPreviews(forest, 0)).toEqual(['[root]', 'm0', 'm1', 'm2', 'm3'])
        expect(forest.activePath.size).toBe(5)
        expect(forest.messageCount).toBe(4)
        expect(forest.activePositions.get('msg:A:2')).toBe(2)
    })

    it('hangs a branch off the message it was made at and draws the copy once', () => {
        const a = linear(6)
        const forest = buildBranchForest([
            branchOf(0, 'B', 'A', a, 3, {}, [user('b4'), char('b5')]),
            chat(1, 'A', a),
        ], 0)
        expect(forest.roots).toEqual(['root:A'])
        const marker = forest.nodes.get('branch:B')!
        expect(marker.parent).toBe('msg:A:3')
        expect(marker.messageIndex).toBe(4)
        expect(forest.nodes.get('msg:A:3')!.children).toEqual(['msg:A:4', 'branch:B'])
        expect(pathPreviews(forest, 0)).toEqual(['[root]', 'm0', 'm1', 'm2', 'm3', '[branch]', 'b4', 'b5'])
        expect(forest.messageCount).toBe(8)
        // The active branch shares the parent's first messages.
        expect(forest.activeRoot).toBe('root:A')
        expect(forest.activePositions.get('msg:A:1')).toBe(1)
        expect(forest.activePositions.get('branch:B')).toBe(4)
        expect(forest.activePath.has('msg:A:4')).toBe(false)
    })

    it('follows a branch of a branch through the copied comment', () => {
        const a = linear(4)
        const b = branchOf(1, 'B', 'A', a, 1, {}, [user('b3'), char('b4')])
        const bSource: SourceMessage[] = [...a.slice(0, 2), branchComment('A', 'A', 'm1'), user('b3'), char('b4')]
        const c = branchOf(2, 'C', 'B', bSource, 3, {}, [char('c5')])
        const forest = buildBranchForest([chat(0, 'A', a), b, c], 2)
        expect(forest.nodes.get('branch:C')!.parent).toBe('msg:B:3')
        expect(pathPreviews(forest, 2)).toEqual(['[root]', 'm0', 'm1', '[branch]', 'b3', '[branch]', 'c5'])
        expect(forest.issues).toEqual([])
    })

    it('gives the branch its own copy of a message it rerolled', () => {
        const a = linear(4)
        const rerolled = { ...a[3], swipes: ['m3', 'm3 again'], swipeId: 1, data: 'm3 again' }
        const b = chat(1, 'B', [...a.slice(0, 3).map((m, k) => ({ ...m, chatId: `b${k}` })), { ...rerolled, chatId: 'b3' }, branchComment('A', 'A', 'm3')])
        const forest = buildBranchForest([chat(0, 'A', a), b], 1)
        expect(forest.nodes.get('branch:B')!.parent).toBe('msg:A:2')
        expect(pathPreviews(forest, 1)).toEqual(['[root]', 'm0', 'm1', 'm2', '[branch]', 'm3 again'])
        expect(forest.nodes.get('msg:B:3')!.message!.swipes).toEqual(['m3', 'm3 again'])
    })

    it('draws a branch whose parent chat is gone as its own tree', () => {
        const forest = buildBranchForest([chat(0, 'B', [user('m0'), char('m1'), branchComment('deleted', 'Old', 'm1'), user('b3')])], 0)
        expect(forest.roots).toEqual(['root:B'])
        expect(forest.nodes.get('root:B')!.issue).toBe('missing-parent')
        expect(forest.issues).toEqual([{ chatIndex: 0, chatName: 'B', issue: 'missing-parent' }])
        expect(pathPreviews(forest, 0)).toEqual(['[root]', 'm0', 'm1', 'Old', 'b3'])
    })

    it('tells a parent that was not read from one that is gone', () => {
        const forest = buildBranchForest([
            branchOf(0, 'B', 'A', linear(2), 1),
            unloadedChat({ id: 'A', name: 'A', _placeholder: true }, 1),
        ], 0)
        expect(forest.nodes.get('root:B')!.issue).toBe('unloaded-parent')
        expect(forest.chatCount).toBe(1)
    })

    it('breaks parent cycles instead of looping', () => {
        const a = chat(0, 'A', [user('a0'), branchComment('B', 'B', 'b0')])
        const b = chat(1, 'B', [user('b0'), branchComment('A', 'A', 'a0')])
        const self = chat(2, 'S', [user('s0'), branchComment('S', 'S', 's0')])
        const forest = buildBranchForest([a, b, self], 0)
        expect(forest.roots).toHaveLength(2)
        expect(forest.issues.map((entry) => entry.issue).sort()).toEqual(['cycle', 'cycle'])
        expect(forest.chatCount).toBe(3)
        // Every chat still ends somewhere.
        expect([...forest.terminals.values()].flat().sort()).toEqual([0, 1, 2])
    })

    it('attaches by position when the branched message was deleted from the parent', () => {
        const a = linear(6)
        const b = branchOf(1, 'B', 'A', a, 3, {}, [char('b5')])
        const aAfterDelete = [...a.slice(0, 2), ...a.slice(4)]
        const forest = buildBranchForest([chat(0, 'A', aAfterDelete), b], 1)
        expect(forest.issues).toEqual([{ chatIndex: 1, chatName: 'B', issue: 'fork-moved' }])
        expect(forest.nodes.get('branch:B')!.issue).toBe('fork-moved')
        expect(forest.nodes.get('branch:B')!.parent).toBeTruthy()
        expect(pathPreviews(forest, 1).at(-1)).toBe('b5')
    })

    it('attaches to the root when the parent lost every message', () => {
        const b = branchOf(1, 'B', 'A', linear(4), 2, {}, [char('b4')])
        const forest = buildBranchForest([chat(0, 'A', []), b], 1)
        expect(forest.nodes.get('branch:B')!.parent).toBe('root:A')
        expect(pathPreviews(forest, 1)).toEqual(['[root]', '[branch]', 'm0', 'm1', 'm2', 'b4'])
    })

    it('handles legacy branches that kept the parent message ids', () => {
        const a = linear(4)
        const b = chat(1, 'B', [...a.slice(0, 3), branchComment('A', 'A', 'm2'), char('b4')])
        const forest = buildBranchForest([chat(0, 'A', a), b], 1)
        expect(forest.nodes.get('branch:B')!.parent).toBe('msg:A:2')
        expect(forest.issues).toEqual([])
    })

    it('survives empty slots and chats without ids', () => {
        const forest = buildBranchForest([
            compactChat({ name: 'no id', message: [user('x'), null, char('y')] }, 0, ''),
            compactChat({ name: 'no id 2', message: [] }, 1, ''),
        ], 0)
        expect(forest.roots).toEqual(['root:#0', 'root:#1'])
        expect(forest.messageCount).toBe(3)
        expect([...forest.terminals.keys()]).toEqual(['msg:#0:2', 'root:#1'])
    })

    it('copes with duplicate chat ids', () => {
        const forest = buildBranchForest([chat(0, 'A', linear(2)), chat(1, 'A', linear(3))], 1)
        expect(forest.roots).toEqual(['root:#0', 'root:#1'])
        expect(forest.activeRoot).toBe('root:#1')
    })
})

// ── Projection ──────────────────────────────────────────────────────────────

describe('projectBranchGraph', () => {
    it('folds a long straight chat into a summary between its ends', () => {
        const forest = buildBranchForest([chat(0, 'A', linear(5000))], 0)
        const started = performance.now()
        const graph = projectBranchGraph(forest)
        expect(performance.now() - started).toBeLessThan(1000)
        const summaries = graph.nodes.filter((node) => node.kind === 'summary')
        expect(summaries).toHaveLength(1)
        expect(summaries[0]).toMatchObject({ messageIndex: CONTEXT_RADIUS, endMessageIndex: 4999 - CONTEXT_RADIUS - 1, activePath: true })
        expect(graph.collapsedMessageCount).toBe(5000 - 2 * CONTEXT_RADIUS - 1)
        expect(graph.nodes.length).toBeLessThan(12)
        expect(graph.messageCount).toBe(5000)
        expect(graph.nodes.find((node) => node.activeTerminal)?.messageIndex).toBe(4999)
        expect(graph.edges.every((edge) => edge.active)).toBe(true)
    })

    it('keeps context around every fork of a long chat', () => {
        const a = linear(400)
        const forest = buildBranchForest([chat(0, 'A', a), branchOf(1, 'B', 'A', a, 200, {}, [char('b')])], 0)
        const graph = projectBranchGraph(forest)
        const shown = new Set(graph.nodes.filter((node) => node.kind === 'message' && node.chatId === 'A').map((node) => node.messageIndex))
        for (let k = 200 - CONTEXT_RADIUS; k <= 200 + CONTEXT_RADIUS; k++) expect(shown.has(k)).toBe(true)
        expect(graph.nodes.filter((node) => node.kind === 'summary')).toHaveLength(2)
        expect(graph.nodes.find((node) => node.kind === 'branch')?.chatId).toBe('B')
        expect(graph.edges.find((edge) => edge.to === 'branch:B')?.kind).toBe('branch')
    })

    it('draws every message on request without overflowing the stack', () => {
        const forest = buildBranchForest([chat(0, 'A', linear(20000))], 0)
        const graph = projectBranchGraph(forest, { density: 'all' })
        expect(graph.nodes).toHaveLength(20001)
        expect(graph.rows).toBe(20001)
        expect(graph.columns).toBe(1)
    })

    it('shows only forks, branch starts and chat ends in branches density', () => {
        const a = linear(30)
        const forest = buildBranchForest([chat(0, 'A', a), branchOf(1, 'B', 'A', a, 10, {}, linear(20, 'b'))], 0)
        const graph = projectBranchGraph(forest, { density: 'branches' })
        // root, [m0-m9], m10 (fork), [m11-m28], m29 (end of A), branch B, [b0-b18], b19 (end of B)
        expect(graph.nodes.map((node) => node.kind).sort()).toEqual(['branch', 'message', 'message', 'message', 'root', 'summary', 'summary', 'summary'])
        expect(graph.nodes.filter((node) => node.kind === 'message').map((node) => node.preview).sort()).toEqual(['b19', 'm10', 'm29'])
    })

    it('unfolds a summary the user expanded', () => {
        const forest = buildBranchForest([chat(0, 'A', linear(300))], 0)
        const folded = projectBranchGraph(forest).nodes.find((node) => node.kind === 'summary')!
        const graph = projectBranchGraph(forest, { expanded: new Set(folded.foldedIds) })
        expect(graph.nodes.some((node) => node.kind === 'summary')).toBe(false)
        expect(graph.nodes.filter((node) => node.kind === 'message')).toHaveLength(300)
    })

    it('draws rerolls as alternatives beside their message', () => {
        const messages = [user('u0'), char('c1', 'c1', { swipes: ['first', 'c1', 'third'], swipeId: 1 })]
        const forest = buildBranchForest([chat(0, 'A', messages)], 0)
        const graph = projectBranchGraph(forest)
        const swipes = graph.nodes.filter((node) => node.kind === 'swipe')
        expect(swipes.map((node) => [node.swipeIndex, node.preview])).toEqual([[0, 'first'], [2, 'third']])
        const parentEdges = graph.edges.filter((edge) => edge.from === 'msg:A:0')
        expect(parentEdges.map((edge) => [edge.to, edge.kind, edge.active])).toEqual([
            ['msg:A:1', 'message', true],
            ['swipe:msg:A:1:0', 'swipe', false],
            ['swipe:msg:A:1:2', 'swipe', false],
        ])
        expect(projectBranchGraph(forest, { density: 'branches' }).nodes.some((node) => node.kind === 'swipe')).toBe(false)
    })

    it('caps the alternatives drawn for a heavily rerolled reply', () => {
        const swipes = Array.from({ length: 40 }, (_, j) => `s${j}`)
        const forest = buildBranchForest([chat(0, 'A', [user('u'), char('s20', 's', { swipes, swipeId: 20 })])], 0)
        const graph = projectBranchGraph(forest)
        expect(graph.nodes.filter((node) => node.kind === 'swipe')).toHaveLength(MAX_SWIPE_NODES)
        expect(graph.nodes.find((node) => node.id === 'msg:A:1')?.hiddenSwipes).toBe(39 - MAX_SWIPE_NODES)
        expect(visibleSwipeIndexes(40, 20, 4)).toEqual([18, 19, 21, 22])
        expect(visibleSwipeIndexes(10, 0, 3)).toEqual([1, 2, 9])
    })

    it('counts rerolled messages inside a summary', () => {
        const messages = linear(200).map((message, k) => k === 100 ? { ...message, swipes: ['x', String(message.data)], swipeId: 1 } : message)
        const graph = projectBranchGraph(buildBranchForest([chat(0, 'A', messages)], 0))
        expect(graph.nodes.find((node) => node.kind === 'summary')?.rerolledCount).toBe(1)
    })

    it('shows the active family or every chat', () => {
        const forest = buildBranchForest([chat(0, 'A', linear(3)), chat(1, 'X', linear(2))], 0)
        expect(projectBranchGraph(forest).nodes.every((node) => node.chatId === 'A')).toBe(true)
        const all = projectBranchGraph(forest, { scope: 'all' })
        expect(new Set(all.nodes.map((node) => node.chatId))).toEqual(new Set(['A', 'X']))
        // The second tree sits beside the first instead of on top of it.
        expect(all.nodes.find((node) => node.id === 'root:X')!.x).toBeGreaterThan(0)
    })

    it('lists only the broken links of the chats drawn', () => {
        const forest = buildBranchForest([chat(0, 'A', linear(3)), chat(1, 'L', [user('l0'), branchComment('gone', 'Gone', 'x')])], 0)
        expect(projectBranchGraph(forest).issues).toEqual([])
        expect(projectBranchGraph(forest, { scope: 'all' }).issues).toEqual([{ chatIndex: 1, chatName: 'L', issue: 'missing-parent' }])
    })

    it('is empty without loaded chats', () => {
        const graph = projectBranchGraph(buildBranchForest([unloadedChat({ id: 'A' }, 0)], 0))
        expect(graph).toMatchObject({ nodes: [], edges: [], rows: 0, columns: 0 })
    })
})

describe('lane layouts', () => {
    it('keeps the active chat in lane 0 and gives branches their own lane', () => {
        const a = linear(6)
        const forest = buildBranchForest([chat(0, 'A', a), branchOf(1, 'B', 'A', a, 2, {}, [char('b4')])], 1)
        const graph = projectBranchGraph(forest)
        const lanes = buildBranchGraphLanes(graph, (node) => node.y)
        expect(lanes.laneByNodeId.get('msg:B:4')).toBe(0)
        expect(lanes.laneByNodeId.get('msg:A:5')).toBe(1)
        expect(lanes.columns).toBe(2)
        const rows = buildBranchGraphGitRows(graph)
        expect(rows.rows).toBe(graph.nodes.length)
        expect(rows.rowByNodeId.get('root:A')).toBe(0)
        for (const edge of graph.edges) {
            expect(rows.rowByNodeId.get(edge.from)!).toBeLessThan(rows.rowByNodeId.get(edge.to)!)
        }
    })

    it('handles an empty graph', () => {
        const graph = projectBranchGraph(buildBranchForest([], 0))
        expect(buildBranchGraphLanes(graph, (node) => node.y).columns).toBe(1)
        expect(buildBranchGraphGitRows(graph).rows).toBe(0)
    })
})

// ── Clicks ──────────────────────────────────────────────────────────────────

describe('branchGraphTarget', () => {
    const a = linear(6)
    const forest = buildBranchForest([chat(0, 'A', a), branchOf(1, 'B', 'A', a, 3, {}, [char('b5', 'b5', { swipes: ['b5', 'b5 alt'], swipeId: 0 })])], 1)
    const graph = projectBranchGraph(forest)
    const byId = (id: string) => graph.nodes.find((node) => node.id === id)!

    it('opens a shared message in the active chat', () => {
        expect(branchGraphTarget(forest, byId('msg:A:1'))).toEqual({ chatIndex: 1, chatId: 'B', messageIndex: 1, messageId: 'B-copy-1' })
        expect(branchGraphTarget(forest, byId('root:A'))).toMatchObject({ chatId: 'B', messageIndex: -1 })
    })

    it('opens a message only another chat has in that chat', () => {
        expect(branchGraphTarget(forest, byId('msg:A:5'))).toEqual({ chatIndex: 0, chatId: 'A', messageIndex: 5, messageId: 'm5' })
    })

    it('carries the swipe to show', () => {
        expect(branchGraphTarget(forest, byId('swipe:msg:B:5:1'))).toMatchObject({ chatId: 'B', messageIndex: 5, swipeIndex: 1, swipePreview: 'b5 alt' })
    })

    it('has no target for a summary', () => {
        const long = buildBranchForest([chat(0, 'A', linear(300))], 0)
        const summary = projectBranchGraph(long).nodes.find((node) => node.kind === 'summary')!
        expect(branchGraphTarget(long, summary)).toBeNull()
    })
})

describe('resolveSwipeIndex', () => {
    it('trusts the index while its text still matches, else finds the text', () => {
        expect(resolveSwipeIndex(['a', 'b', 'c'], 1, 'b')).toBe(1)
        expect(resolveSwipeIndex(['b', 'a', 'c'], 1, 'b')).toBe(0)
        expect(resolveSwipeIndex(['a', 'c'], 1, 'b')).toBe(-1)
        expect(resolveSwipeIndex(['a', 'b'], 1)).toBe(1)
        expect(resolveSwipeIndex(['a', 'b'], 5)).toBe(-1)
        expect(resolveSwipeIndex(undefined, 0, 'a')).toBe(-1)
    })
})

// ── Loading plan ────────────────────────────────────────────────────────────

describe('baseChatName', () => {
    it('strips the copy and branch suffixes', () => {
        expect(baseChatName('Chat 3 (Branch 2)')).toBe('Chat 3')
        expect(baseChatName('Chat 3 (Copy) (Branch)')).toBe('Chat 3')
        expect(baseChatName('Branch')).toBe('Branch')
    })
})

describe('pickChatsToLoad', () => {
    const placeholder = (index: number, id: string, name: string, lastDate = 0, folderId?: string) =>
        unloadedChat({ id, name, lastDate, folderId, _placeholder: true }, index)

    it('reads the active chat\'s parent first, then look-alikes newest first', () => {
        const active = branchOf(0, 'B', 'A', linear(3), 1, { name: 'Story (Branch)' })
        const chats = [
            active,
            placeholder(1, 'other', 'Unrelated', 50),
            placeholder(2, 'sib-old', 'Story (Branch 2)', 10),
            placeholder(3, 'A', 'Story', 1),
            placeholder(4, 'sib-new', 'Story (Branch 3)', 40),
            placeholder(5, 'folder', 'Renamed', 5, 'f1'),
        ]
        chats[0].folderId = 'f1'
        expect(pickChatsToLoad(chats, 0, { limit: 10, includeOthers: false })).toEqual(['A', 'sib-new', 'sib-old', 'folder'])
        expect(pickChatsToLoad(chats, 0, { limit: 2, includeOthers: false })).toEqual(['A', 'sib-new'])
        expect(pickChatsToLoad(chats, 0, { limit: 10, includeOthers: true })).toEqual(['A', 'sib-new', 'sib-old', 'folder', 'other'])
        expect(pickChatsToLoad(chats, 0, { limit: 10, includeOthers: true, skip: new Set(['A', 'other']) })).toEqual(['sib-new', 'sib-old', 'folder'])
    })

    it('walks up through loaded ancestors to the next unloaded one', () => {
        const b = branchOf(1, 'B', 'A', linear(3), 1)
        const c = branchOf(2, 'C', 'B', linear(3), 1)
        const chats = [placeholder(0, 'A', 'x'), b, c]
        expect(pickChatsToLoad(chats, 2, { limit: 5, includeOthers: false })).toEqual(['A'])
    })

    it('reads nothing when everything is loaded or the limit is zero', () => {
        expect(pickChatsToLoad([chat(0, 'A', linear(2))], 0, { limit: 5, includeOthers: true })).toEqual([])
        expect(pickChatsToLoad([placeholder(0, 'A', 'A'), placeholder(1, 'B', 'A (Branch)')], 0, { limit: 0, includeOthers: true })).toEqual([])
    })
})
