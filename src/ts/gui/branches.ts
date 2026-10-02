// Branch graph: a read-only projection of what PocketRisu already stores.
//
// The graph has no storage of its own. A reroll is kept in the reply's
// `swipes`; a manual branch is a copy of the chat up to the branched message
// followed by a `{{specialcomment::branchedfrom::<chat id>::<chat name>::
// <message id>::}}` comment (Chat.svelte), with fresh message ids since
// reissueMessageIds. The graph reads both: a branched chat hangs off the
// message it was branched from, and the copied messages before that point are
// drawn once, as the parent chat's.
//
// Every step is a pure function so broken and very long chats are unit tested:
//   compactChat          chat body -> GraphChat (short previews, no bodies)
//   buildBranchForest    GraphChat[] -> one tree per original chat, active path
//   projectBranchGraph   forest -> drawn nodes: long straight runs folded into
//                        summary nodes, swipe alternatives, tree coordinates
//   buildBranchGraphLanes / buildBranchGraphGitRows  timeline and git layouts
//   pickChatsToLoad      which unloaded chats to read next, with a bound

// ── Compact input ───────────────────────────────────────────────────────────

export interface BranchLink {
    parentChatId: string
    parentChatName: string
    /** Id of the parent's message the branch was made at; '' when unknown. */
    parentMessageId: string
}

const BRANCH_COMMENT_PREFIX = '{{specialcomment::branchedfrom::'

/** The parent named by a branchedfrom comment, or null for any other text. */
export function parseBranchLink(data: unknown): BranchLink | null {
    if (typeof data !== 'string' || !data.startsWith(BRANCH_COMMENT_PREFIX)) return null
    // {{specialcomment :: branchedfrom :: <chat id> :: <chat name> :: <message id> :: }}
    // The chat name is free text and may contain '::' itself.
    const parts = data.split('::')
    if (parts.length < 6 || !parts[2]) return null
    const messageId = parts[parts.length - 2] ?? ''
    return {
        parentChatId: parts[2],
        parentChatName: parts.slice(3, parts.length - 2).join('::'),
        // A parent message without an id was written as "undefined".
        parentMessageId: messageId === 'undefined' ? '' : messageId,
    }
}

const PREVIEW_SCAN = 800
export const PREVIEW_LENGTH = 160

/** Short plain-text preview; reads only the head of a long message. */
export function previewText(text: unknown): string {
    if (typeof text !== 'string' || text.length === 0) return ''
    const head = text.length > PREVIEW_SCAN ? text.slice(0, PREVIEW_SCAN) : text
    const plain = head
        .replace(/<\/?[a-zA-Z][^>]*(>|$)/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
    return plain.length > PREVIEW_LENGTH ? `${plain.slice(0, PREVIEW_LENGTH - 1)}…` : plain
}

// Cheap identity of a message's shown text and swipe count: enough to tell a
// branch's rerolled or edited copy from the original without keeping bodies.
function messageSignature(role: string, data: string, swipeCount: number): string {
    return `${role}|${data.length}|${data.slice(0, 48)}|${data.slice(-48)}|${swipeCount}`
}

export interface GraphMessage {
    /** The message's chatId; '' when it has none. */
    id: string
    role: 'user' | 'char'
    preview: string
    sig: string
    isComment: boolean
    disabled: boolean
    /** Set on a branchedfrom comment. */
    link: BranchLink | null
    /** Shown swipe (0 without swipes). */
    swipeId: number
    /** Preview of every swipe when there are at least two, else null. */
    swipes: string[] | null
    model: string
    time: number | undefined
}

/** The fields of a stored message the graph reads. */
export interface SourceMessage {
    role?: string
    data?: unknown
    chatId?: string
    isComment?: boolean
    disabled?: unknown
    swipes?: unknown
    swipeId?: number
    time?: number
    generationInfo?: { model?: string }
}

export function compactMessage(message: SourceMessage | null | undefined): GraphMessage {
    if (!message || typeof message !== 'object') {
        // A broken slot keeps its position so later indices still line up.
        return { id: '', role: 'char', preview: '', sig: 'missing', isComment: false, disabled: false, link: null, swipeId: 0, swipes: null, model: '', time: undefined }
    }
    const role = message.role === 'user' ? 'user' : 'char'
    const data = typeof message.data === 'string' ? message.data : ''
    const rawSwipes = Array.isArray(message.swipes) ? message.swipes : null
    const swipes = rawSwipes && rawSwipes.length > 1 ? rawSwipes.map(previewText) : null
    const swipeId = swipes ? Math.min(Math.max(0, Math.trunc(message.swipeId ?? 0) || 0), swipes.length - 1) : 0
    const link = parseBranchLink(data)
    return {
        id: typeof message.chatId === 'string' ? message.chatId : '',
        role,
        preview: link ? link.parentChatName : previewText(data),
        sig: messageSignature(role, data, rawSwipes?.length ?? 0),
        isComment: !!message.isComment,
        disabled: !!message.disabled,
        link,
        swipeId,
        swipes,
        model: typeof message.generationInfo?.model === 'string' ? message.generationInfo.model : '',
        time: typeof message.time === 'number' && Number.isFinite(message.time) ? message.time : undefined,
    }
}

export interface GraphChat {
    /** Position in character.chats when the graph was built. */
    index: number
    id: string
    name: string
    /** false: a placeholder whose body has not been read. */
    loaded: boolean
    greeting: string
    lastDate: number
    folderId: string
    messages: GraphMessage[]
}

/** The fields of a stored chat (or placeholder) the graph reads. */
export interface SourceChat {
    id?: string
    name?: string
    message?: unknown
    lastDate?: number
    folderId?: string
    _placeholder?: boolean
}

export function compactChat(chat: SourceChat, index: number, greeting: string): GraphChat {
    const messages = Array.isArray(chat.message) ? chat.message as (SourceMessage | null)[] : []
    return {
        ...unloadedChat(chat, index),
        loaded: true,
        greeting: previewText(greeting),
        messages: messages.map(compactMessage),
    }
}

export function unloadedChat(chat: SourceChat, index: number): GraphChat {
    return {
        index,
        id: typeof chat.id === 'string' ? chat.id : '',
        name: typeof chat.name === 'string' ? chat.name : '',
        loaded: false,
        greeting: '',
        lastDate: typeof chat.lastDate === 'number' ? chat.lastDate : 0,
        folderId: typeof chat.folderId === 'string' ? chat.folderId : '',
        messages: [],
    }
}

// ── Forest: one tree per original chat ──────────────────────────────────────

export type BranchIssue =
    /** The branchedfrom comment names a chat that no longer exists. */
    | 'missing-parent'
    /** The parent exists but its body was not read (bound, or a failed read). */
    | 'unloaded-parent'
    /** Chats name each other as parents; one of them is drawn as a root. */
    | 'cycle'
    /** The branched message is gone from the parent; attached by position. */
    | 'fork-moved'

export interface BranchNode {
    id: string
    kind: 'root' | 'branch' | 'message'
    parent: string | null
    /** Continuation of the owning chat first, then branches in chat order. */
    children: string[]
    chatIndex: number
    chatId: string
    chatName: string
    /** Position in the owning chat; -1 for a root. A branch marker sits at its comment. */
    messageIndex: number
    depth: number
    message: GraphMessage | null
    /** Root: the greeting; branch marker: the parent chat's name. */
    preview: string
    issue: BranchIssue | null
}

export interface BranchForest {
    nodes: Map<string, BranchNode>
    roots: string[]
    /** Node -> indices of the chats whose last message it is. */
    terminals: Map<string, number[]>
    chats: Map<number, GraphChat>
    activeChatIndex: number
    activeRoot: string | null
    activePath: Set<string>
    /** Node -> its position in the active chat, for nodes the active chat shares. */
    activePositions: Map<string, number>
    issues: Array<{ chatIndex: number, chatName: string, issue: BranchIssue }>
    chatCount: number
    messageCount: number
}

// A branch's copied messages are compared with the parent's only this far back
// from the comment: a reroll or edit in the branch touches the last of them.
const DIVERGE_WINDOW = 3

interface ChatLinkInfo {
    linkPos: number
    link: BranchLink | null
    parent: GraphChat | null
    issue: BranchIssue | null
}

/**
 * Join chats into trees through their branchedfrom comments. A branch's
 * messages before its comment are the parent's (by position, anchored at the
 * branched message); from the first copied message that differs (a reroll or
 * edit made in the branch) the branch owns its messages.
 */
export function buildBranchForest(chats: readonly GraphChat[], activeChatIndex: number): BranchForest {
    const nodes = new Map<string, BranchNode>()
    const roots: string[] = []
    const terminals = new Map<string, number[]>()
    const issues: BranchForest['issues'] = []
    const loaded = chats.filter((chat) => chat.loaded)

    const idCount = new Map<string, number>()
    for (const chat of chats) if (chat.id) idCount.set(chat.id, (idCount.get(chat.id) ?? 0) + 1)
    const loadedById = new Map<string, GraphChat>()
    for (const chat of loaded) if (chat.id && !loadedById.has(chat.id)) loadedById.set(chat.id, chat)
    const chatKey = (chat: GraphChat) => chat.id && idCount.get(chat.id) === 1 ? chat.id : `#${chat.index}`

    const info = new Map<GraphChat, ChatLinkInfo>()
    for (const chat of loaded) {
        // The chat's own comment is the last one: copied comments of earlier
        // branches come before it.
        let linkPos = -1
        let link: BranchLink | null = null
        for (let k = chat.messages.length - 1; k >= 0; k--) {
            if (chat.messages[k].link) {
                linkPos = k
                link = chat.messages[k].link
                break
            }
        }
        let parent: GraphChat | null = null
        let issue: BranchIssue | null = null
        if (link) {
            const candidate = loadedById.get(link.parentChatId)
            if (candidate === chat) issue = 'cycle'
            else if (candidate) parent = candidate
            else issue = idCount.has(link.parentChatId) ? 'unloaded-parent' : 'missing-parent'
        }
        info.set(chat, { linkPos, link, parent, issue })
    }

    // Break parent cycles: the chat where a walk first comes back becomes a root.
    const settled = new Set<GraphChat>()
    for (const chat of loaded) {
        const onWalk = new Set<GraphChat>()
        let current: GraphChat | null = chat
        while (current && !settled.has(current)) {
            const entry: ChatLinkInfo = info.get(current)!
            if (onWalk.has(current)) {
                entry.parent = null
                entry.issue = 'cycle'
                break
            }
            onWalk.add(current)
            current = entry.parent
        }
        for (const walked of onWalk) settled.add(walked)
    }

    const chatDepth = new Map<GraphChat, number>()
    const depthOf = (chat: GraphChat): number => {
        const chain: GraphChat[] = []
        let current: GraphChat | null = chat
        while (current && !chatDepth.has(current)) {
            chain.push(current)
            current = info.get(current)!.parent
        }
        let depth = current ? chatDepth.get(current)! : -1
        for (let i = chain.length - 1; i >= 0; i--) chatDepth.set(chain[i], ++depth)
        return chatDepth.get(chat)!
    }
    const ordered = [...loaded].sort((a, b) => depthOf(a) - depthOf(b) || a.index - b.index)

    const positions = new Map<GraphChat, string[]>()
    const heads = new Map<GraphChat, string>()
    const lastNodes = new Map<GraphChat, string>()
    const messageIndexes = new Map<GraphChat, Map<string, number>>()
    const indexOfMessage = (chat: GraphChat, id: string): number => {
        let byId = messageIndexes.get(chat)
        if (!byId) {
            byId = new Map()
            chat.messages.forEach((message, k) => {
                if (message.id && !byId!.has(message.id)) byId!.set(message.id, k)
            })
            messageIndexes.set(chat, byId)
        }
        return byId.get(id) ?? -1
    }
    const addNode = (node: BranchNode) => {
        nodes.set(node.id, node)
        if (node.parent) nodes.get(node.parent)!.children.push(node.id)
        else roots.push(node.id)
    }
    const depthOfNode = (id: string) => nodes.get(id)!.depth

    for (const chat of ordered) {
        const key = chatKey(chat)
        const { linkPos, link, parent, issue } = info.get(chat)!
        const pos: string[] = new Array(chat.messages.length)
        let previous: string
        let ownFrom: number
        if (!parent || !link) {
            const rootId = `root:${key}`
            addNode({
                id: rootId, kind: 'root', parent: null, children: [],
                chatIndex: chat.index, chatId: chat.id, chatName: chat.name,
                messageIndex: -1, depth: 0, message: null,
                preview: chat.greeting, issue,
            })
            if (issue) issues.push({ chatIndex: chat.index, chatName: chat.name, issue })
            heads.set(chat, rootId)
            previous = rootId
            ownFrom = 0
        } else {
            const parentPos = positions.get(parent)!
            const parentHead = heads.get(parent)!
            heads.set(chat, parentHead)
            let fork = link.parentMessageId ? indexOfMessage(parent, link.parentMessageId) : -1
            let forkIssue: BranchIssue | null = null
            if (fork === -1) {
                fork = Math.min(linkPos - 1, parent.messages.length - 1)
                forkIssue = 'fork-moved'
                issues.push({ chatIndex: chat.index, chatName: chat.name, issue: forkIssue })
            }
            // The copied messages end at the branched message: position k of
            // the branch is position k + offset of the parent.
            const offset = fork - (linkPos - 1)
            const parentAt = (k: number): string => {
                const q = k + offset
                if (k < 0 || q < 0 || parentPos.length === 0) return parentHead
                return parentPos[Math.min(q, parentPos.length - 1)] ?? parentHead
            }
            let ownStart = linkPos
            for (let k = linkPos - 1; k >= Math.max(0, linkPos - DIVERGE_WINDOW); k--) {
                const q = k + offset
                const original = q >= 0 && q < parent.messages.length ? parent.messages[q] : null
                if (original && original.sig === chat.messages[k].sig) break
                ownStart = k
            }
            const forkNode = parentAt(ownStart - 1)
            const markerId = `branch:${key}`
            addNode({
                id: markerId, kind: 'branch', parent: forkNode, children: [],
                chatIndex: chat.index, chatId: chat.id, chatName: chat.name,
                messageIndex: linkPos, depth: depthOfNode(forkNode) + 1,
                message: chat.messages[linkPos], preview: link.parentChatName, issue: forkIssue,
            })
            for (let k = 0; k < ownStart; k++) pos[k] = parentAt(k)
            pos[linkPos] = markerId
            previous = markerId
            ownFrom = ownStart
        }
        for (let k = ownFrom; k < chat.messages.length; k++) {
            if (parent && k === linkPos) continue
            const message = chat.messages[k]
            const id = `msg:${key}:${k}`
            addNode({
                id, kind: 'message', parent: previous, children: [],
                chatIndex: chat.index, chatId: chat.id, chatName: chat.name,
                messageIndex: k, depth: depthOfNode(previous) + 1,
                message, preview: message.preview, issue: null,
            })
            pos[k] = id
            previous = id
        }
        positions.set(chat, pos)
        lastNodes.set(chat, previous)
        const ending = terminals.get(previous)
        if (ending) ending.push(chat.index)
        else terminals.set(previous, [chat.index])
    }

    const activePath = new Set<string>()
    const activePositions = new Map<string, number>()
    const activeChat = loaded.find((chat) => chat.index === activeChatIndex) ?? null
    let activeRoot: string | null = null
    if (activeChat) {
        activeRoot = heads.get(activeChat) ?? null
        let current: string | null = lastNodes.get(activeChat) ?? null
        while (current && !activePath.has(current)) {
            activePath.add(current)
            current = nodes.get(current)?.parent ?? null
        }
        const pos = positions.get(activeChat) ?? []
        for (let k = 0; k < pos.length; k++) {
            if (pos[k] && !activePositions.has(pos[k])) activePositions.set(pos[k], k)
        }
    }

    let messageCount = 0
    for (const node of nodes.values()) if (node.kind === 'message') messageCount++

    return {
        nodes,
        roots,
        terminals,
        chats: new Map(loaded.map((chat) => [chat.index, chat])),
        activeChatIndex,
        activeRoot,
        activePath,
        activePositions,
        issues,
        chatCount: loaded.length,
        messageCount,
    }
}

// ── Projection: what is drawn ───────────────────────────────────────────────

export type BranchGraphDensity = 'smart' | 'all' | 'branches'
export type BranchGraphScope = 'family' | 'all'

export interface BranchGraphNode {
    id: string
    kind: 'root' | 'branch' | 'message' | 'swipe' | 'summary'
    /** Tree layout coordinates: x in columns (may be fractional), y in rows. */
    x: number
    y: number
    /** Forest node shown; a swipe's message; a summary's first folded message. */
    sourceId: string
    chatIndex: number
    chatId: string
    chatName: string
    messageIndex: number
    endMessageIndex: number
    messageId: string
    /** Swipe node: the swipe it shows. Message node: its shown swipe. */
    swipeIndex: number
    swipeCount: number
    role: 'user' | 'char' | null
    preview: string
    endPreview: string
    model: string
    isComment: boolean
    /** A branchedfrom comment drawn as a message (its parent is gone); preview is the parent name. */
    isLink: boolean
    time: number | undefined
    /** Summary: forest ids of the folded messages (to expand them). */
    foldedIds: string[]
    /** Summary: folded messages that have swipes. */
    rerolledCount: number
    /** Message: swipes not drawn as their own node (over the cap). */
    hiddenSwipes: number
    activePath: boolean
    activeTerminal: boolean
    /** Chats whose last message this is. */
    terminalCount: number
    /** Branches and continuations leaving this message. */
    forkCount: number
    issue: BranchIssue | null
}

export interface BranchGraphEdge {
    from: string
    to: string
    active: boolean
    kind: 'message' | 'branch' | 'swipe'
}

export interface BranchGraph {
    nodes: BranchGraphNode[]
    edges: BranchGraphEdge[]
    columns: number
    rows: number
    chatCount: number
    messageCount: number
    collapsedMessageCount: number
    /** Broken branch links of the chats drawn. */
    issues: BranchForest['issues']
}

export interface BranchGraphOptions {
    density?: BranchGraphDensity
    scope?: BranchGraphScope
    /** Forest ids the user unfolded from a summary; always drawn. */
    expanded?: ReadonlySet<string>
}

// Smart density draws everything up to this many messages, then keeps only
// CONTEXT_RADIUS messages around forks, branch starts and chat ends, folding
// straight runs of at least MIN_COLLAPSED_RUN messages into one summary node.
export const LONG_CHAT_THRESHOLD = 80
export const CONTEXT_RADIUS = 2
export const MIN_COLLAPSED_RUN = 6
// Swipe alternatives drawn per message (the nearest to the shown one).
export const MAX_SWIPE_NODES = 12

const EMPTY_SET: ReadonlySet<string> = new Set()

interface DisplayEntry {
    node: BranchGraphNode
    children: string[]
}

function blankNode(id: string, kind: BranchGraphNode['kind'], source: BranchNode): BranchGraphNode {
    const message = source.message
    return {
        id, kind, x: 0, y: 0,
        sourceId: source.id,
        chatIndex: source.chatIndex,
        chatId: source.chatId,
        chatName: source.chatName,
        messageIndex: source.messageIndex,
        endMessageIndex: source.messageIndex,
        messageId: message?.id ?? '',
        swipeIndex: message?.swipeId ?? 0,
        swipeCount: message?.swipes?.length ?? 0,
        role: message ? message.role : null,
        preview: source.preview,
        endPreview: '',
        model: message?.model ?? '',
        isComment: message?.isComment ?? false,
        isLink: source.kind === 'message' && !!message?.link,
        time: message?.time,
        foldedIds: [],
        rerolledCount: 0,
        hiddenSwipes: 0,
        activePath: false,
        activeTerminal: false,
        terminalCount: 0,
        forkCount: 0,
        issue: source.issue,
    }
}

/** Swipe indexes drawn for a message: the nearest to the shown one, in order. */
export function visibleSwipeIndexes(count: number, shown: number, cap = MAX_SWIPE_NODES): number[] {
    const others: number[] = []
    for (let j = 0; j < count; j++) if (j !== shown) others.push(j)
    if (others.length <= cap) return others
    const distance = (j: number) => {
        const d = Math.abs(j - shown)
        return Math.min(d, count - d)
    }
    return others
        .sort((a, b) => distance(a) - distance(b) || a - b)
        .slice(0, cap)
        .sort((a, b) => a - b)
}

export function projectBranchGraph(forest: BranchForest, options: BranchGraphOptions = {}): BranchGraph {
    const density = options.density ?? 'smart'
    const expanded = options.expanded ?? EMPTY_SET
    const rootIds = (options.scope ?? 'family') === 'family' && forest.activeRoot
        ? [forest.activeRoot]
        : forest.roots
    const nodes = forest.nodes

    // Nodes in scope (iterative: a long chat is a very deep tree).
    const inScope: string[] = []
    let scopeMessages = 0
    const scopeChats = new Set<number>()
    {
        const stack = [...rootIds].reverse()
        while (stack.length > 0) {
            const id = stack.pop()!
            const node = nodes.get(id)
            if (!node) continue
            inScope.push(id)
            if (node.kind === 'message') scopeMessages++
            scopeChats.add(node.chatIndex)
            for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i])
        }
    }

    const keep = new Set<string>()
    if (density === 'all' || (density === 'smart' && scopeMessages <= LONG_CHAT_THRESHOLD)) {
        for (const id of inScope) keep.add(id)
    } else {
        const radius = density === 'branches' ? 0 : CONTEXT_RADIUS
        const nearest = new Map<string, number>()
        const queue: Array<{ id: string, distance: number }> = []
        for (const id of inScope) {
            const node = nodes.get(id)!
            if (node.kind !== 'message' || node.children.length !== 1 || forest.terminals.has(id) || node.issue) {
                queue.push({ id, distance: 0 })
            }
            if (expanded.has(id)) keep.add(id)
        }
        for (let index = 0; index < queue.length; index++) {
            const { id, distance } = queue[index]
            const previous = nearest.get(id)
            if (previous !== undefined && previous <= distance) continue
            nearest.set(id, distance)
            keep.add(id)
            if (distance >= radius) continue
            const node = nodes.get(id)
            if (!node) continue
            if (node.parent) queue.push({ id: node.parent, distance: distance + 1 })
            for (const child of node.children) queue.push({ id: child, distance: distance + 1 })
        }
    }

    const display = new Map<string, DisplayEntry>()
    const edges: BranchGraphEdge[] = []
    const showSwipes = density !== 'branches'
    const collapseThreshold = density === 'branches' ? 1 : MIN_COLLAPSED_RUN

    const ensure = (id: string): DisplayEntry => {
        let entry = display.get(id)
        if (entry) return entry
        const source = nodes.get(id)!
        const node = blankNode(id, source.kind, source)
        const ending = forest.terminals.get(id)
        node.terminalCount = ending?.length ?? 0
        node.activeTerminal = !!ending?.includes(forest.activeChatIndex) && forest.activePath.has(id)
        node.activePath = forest.activePath.has(id)
        node.forkCount = source.children.length
        entry = { node, children: [] }
        display.set(id, entry)
        return entry
    }
    const addEdge = (from: string, to: string, kind: BranchGraphEdge['kind'], active: boolean) => {
        display.get(from)?.children.push(to)
        edges.push({ from, to, kind, active })
    }
    const edgeKind = (id: string): BranchGraphEdge['kind'] => nodes.get(id)?.kind === 'branch' ? 'branch' : 'message'
    // Swipe alternatives sit next to their message, under the same parent.
    const addSwipes = (parentId: string, messageId: string) => {
        if (!showSwipes) return
        const source = nodes.get(messageId)
        const swipes = source?.message?.swipes
        if (!source || !swipes) return
        const shown = source.message!.swipeId
        const drawn = visibleSwipeIndexes(swipes.length, shown)
        display.get(messageId)!.node.hiddenSwipes = swipes.length - 1 - drawn.length
        for (const j of drawn) {
            const id = `swipe:${messageId}:${j}`
            const node = blankNode(id, 'swipe', source)
            node.swipeIndex = j
            node.preview = swipes[j]
            node.role = 'char'
            display.set(id, { node, children: [] })
            addEdge(parentId, id, 'swipe', false)
        }
    }

    for (const rootId of rootIds) if (nodes.has(rootId)) ensure(rootId)
    const stack = [...rootIds].filter((id) => nodes.has(id)).reverse()
    while (stack.length > 0) {
        const id = stack.pop()!
        const source = nodes.get(id)!
        const next: string[] = []
        for (const childId of source.children) {
            const hidden: string[] = []
            let target = childId
            while (!keep.has(target)) {
                const node = nodes.get(target)!
                if (node.children.length !== 1) {
                    // Not foldable (only anchors are): draw it.
                    keep.add(target)
                    break
                }
                hidden.push(target)
                target = node.children[0]
            }
            ensure(target)
            let parentId = id
            if (hidden.length >= collapseThreshold) {
                const first = nodes.get(hidden[0])!
                const last = nodes.get(hidden[hidden.length - 1])!
                const summaryId = `summary:${hidden[0]}`
                const node = blankNode(summaryId, 'summary', first)
                node.endMessageIndex = last.messageIndex
                node.endPreview = last.preview
                node.foldedIds = hidden
                node.rerolledCount = hidden.reduce((total, hiddenId) => total + (nodes.get(hiddenId)?.message?.swipes ? 1 : 0), 0)
                node.activePath = forest.activePath.has(hidden[0])
                node.swipeCount = 0
                node.role = null
                display.set(summaryId, { node, children: [] })
                addEdge(id, summaryId, edgeKind(hidden[0]), node.activePath)
                parentId = summaryId
            } else {
                for (const hiddenId of hidden) {
                    ensure(hiddenId)
                    addEdge(parentId, hiddenId, edgeKind(hiddenId), forest.activePath.has(hiddenId))
                    addSwipes(parentId, hiddenId)
                    parentId = hiddenId
                }
            }
            addEdge(parentId, target, edgeKind(target), forest.activePath.has(target))
            addSwipes(parentId, target)
            next.push(target)
        }
        for (let i = next.length - 1; i >= 0; i--) stack.push(next[i])
    }

    const positions = layoutTree(rootIds.filter((id) => display.has(id)), display)
    const result: BranchGraphNode[] = []
    let maxX = 0
    let maxY = 0
    let collapsedMessageCount = 0
    for (const [id, entry] of display) {
        const position = positions.get(id) ?? { x: 0, y: 0 }
        entry.node.x = position.x
        entry.node.y = position.y
        if (position.x > maxX) maxX = position.x
        if (position.y > maxY) maxY = position.y
        collapsedMessageCount += entry.node.foldedIds.length
        result.push(entry.node)
    }
    result.sort((a, b) => a.y - b.y || a.x - b.x)

    return {
        nodes: result,
        edges,
        columns: result.length === 0 ? 0 : Math.ceil(maxX) + 1,
        rows: result.length === 0 ? 0 : maxY + 1,
        chatCount: forest.chatCount,
        messageCount: scopeMessages,
        issues: forest.issues.filter((entry) => scopeChats.has(entry.chatIndex)),
        collapsedMessageCount,
    }
}

// ── Tree layout ─────────────────────────────────────────────────────────────

interface NodeLayoutInfo {
    childOffsets: Map<string, number>
    leftContour: number[]
    rightContour: number[]
    /** Single-child chain: contour is all zeros down to the chain tail's. */
    chain?: { tailId: string, length: number }
}

/**
 * Compact tree layout with depth contours (a Reingold-Tilford variant, from
 * HaejeokRisu). Single-child chains keep only {tail, length} instead of a
 * contour array, so a long linear chat costs O(N) memory, not O(N^2); every
 * pass is iterative so a deep chat cannot overflow the stack.
 */
function layoutTree(rootIds: string[], display: Map<string, DisplayEntry>): Map<string, { x: number, y: number }> {
    const layoutInfo = new Map<string, NodeLayoutInfo>()
    const childrenOf = (id: string) => display.get(id)?.children ?? []

    const leftAt = (id: string, depth: number): number | undefined => {
        const layout = layoutInfo.get(id)
        if (!layout) return undefined
        const chain = layout.chain
        if (!chain) return layout.leftContour[depth]
        if (depth < chain.length) return 0
        return layoutInfo.get(chain.tailId)?.leftContour[depth - chain.length]
    }
    const rightAt = (id: string, depth: number): number | undefined => {
        const layout = layoutInfo.get(id)
        if (!layout) return undefined
        const chain = layout.chain
        if (!chain) return layout.rightContour[depth]
        if (depth < chain.length) return 0
        return layoutInfo.get(chain.tailId)?.rightContour[depth - chain.length]
    }
    const contourLength = (id: string): number => {
        const layout = layoutInfo.get(id)
        if (!layout) return 0
        const chain = layout.chain
        if (!chain) return layout.leftContour.length
        const tail = layoutInfo.get(chain.tailId)
        return chain.length + (tail ? tail.leftContour.length : 0)
    }

    // Children are always laid out before their parent (see computeLayout).
    const layoutNode = (id: string) => {
        const children = childrenOf(id)
        if (children.length === 0) {
            layoutInfo.set(id, { childOffsets: new Map(), leftContour: [0], rightContour: [0] })
            return
        }
        if (children.length === 1) {
            const childId = children[0]
            const child = layoutInfo.get(childId)
            layoutInfo.set(id, {
                childOffsets: new Map([[childId, 0]]),
                leftContour: [],
                rightContour: [],
                chain: {
                    tailId: child?.chain?.tailId ?? childId,
                    length: (child?.chain?.length ?? 0) + 1,
                },
            })
            return
        }
        const childX: number[] = [0]
        const accumLeft: number[] = []
        const accumRight: number[] = []
        const firstDepth = contourLength(children[0])
        for (let d = 0; d < firstDepth; d++) {
            accumLeft.push(leftAt(children[0], d) ?? 0)
            accumRight.push(rightAt(children[0], d) ?? 0)
        }
        for (let i = 1; i < children.length; i++) {
            const childId = children[i]
            const depth = contourLength(childId)
            let shift = 1
            const overlap = Math.min(accumRight.length, depth)
            for (let d = 0; d < overlap; d++) {
                const gap = accumRight[d] - (leftAt(childId, d) ?? 0) + 1
                if (gap > shift) shift = gap
            }
            childX.push(shift)
            for (let d = 0; d < depth; d++) {
                const l = (leftAt(childId, d) ?? 0) + shift
                const r = (rightAt(childId, d) ?? 0) + shift
                if (d < accumLeft.length) {
                    if (l < accumLeft[d]) accumLeft[d] = l
                    if (r > accumRight[d]) accumRight[d] = r
                } else {
                    accumLeft.push(l)
                    accumRight.push(r)
                }
            }
        }
        const center = (childX[0] + childX[childX.length - 1]) / 2
        const childOffsets = new Map<string, number>()
        children.forEach((childId, i) => childOffsets.set(childId, childX[i] - center))
        layoutInfo.set(id, {
            childOffsets,
            leftContour: [0, ...accumLeft.map((x) => x - center)],
            rightContour: [0, ...accumRight.map((x) => x - center)],
        })
    }

    const computeLayout = (rootId: string) => {
        const stack = [rootId]
        const order: string[] = []
        const seen = new Set<string>()
        while (stack.length > 0) {
            const id = stack.pop()!
            if (seen.has(id) || layoutInfo.has(id)) continue
            seen.add(id)
            order.push(id)
            for (const childId of childrenOf(id)) if (!layoutInfo.has(childId)) stack.push(childId)
        }
        for (let i = order.length - 1; i >= 0; i--) layoutNode(order[i])
    }
    for (const rootId of rootIds) computeLayout(rootId)

    // Several roots (all chats) pack side by side against a shared contour.
    const rootX = new Map<string, number>()
    const globalLeft: number[] = []
    const globalRight: number[] = []
    for (const rootId of rootIds) {
        let shift = 0
        if (rootX.size > 0) {
            shift = 1
            const overlap = Math.min(globalRight.length, contourLength(rootId))
            for (let d = 0; d < overlap; d++) {
                const gap = (globalRight[d] ?? 0) - (leftAt(rootId, d) ?? 0) + 1
                if (gap > shift) shift = gap
            }
        }
        rootX.set(rootId, shift)
        const depth = contourLength(rootId)
        for (let d = 0; d < depth; d++) {
            const l = (leftAt(rootId, d) ?? 0) + shift
            const r = (rightAt(rootId, d) ?? 0) + shift
            if (d < globalLeft.length) {
                if (l < globalLeft[d]) globalLeft[d] = l
                if (r > globalRight[d]) globalRight[d] = r
            } else {
                globalLeft.push(l)
                globalRight.push(r)
            }
        }
    }

    const positions = new Map<string, { x: number, y: number }>()
    for (const rootId of rootIds) {
        const stack = [{ id: rootId, x: rootX.get(rootId) ?? 0, y: 0 }]
        while (stack.length > 0) {
            const { id, x, y } = stack.pop()!
            if (positions.has(id)) continue
            positions.set(id, { x, y })
            const layout = layoutInfo.get(id)
            for (const childId of childrenOf(id)) {
                stack.push({ id: childId, x: x + (layout?.childOffsets.get(childId) ?? 0), y: y + 1 })
            }
        }
    }

    let minX = Number.POSITIVE_INFINITY
    for (const position of positions.values()) if (position.x < minX) minX = position.x
    if (Number.isFinite(minX) && minX !== 0) {
        for (const position of positions.values()) position.x -= minX
    }
    return positions
}

// ── Lane layouts (timeline / git) ───────────────────────────────────────────

export interface BranchGraphLanes {
    laneByNodeId: Map<string, number>
    columns: number
}

interface PackedChain {
    nodeIds: string[]
    start: number
    end: number
}

/**
 * Lane assignment with reuse (from HaejeokRisu): the active path keeps lane 0
 * and every other chain takes the first lane whose occupied interval along the
 * flow axis it does not overlap, so scattered branches share lanes.
 */
export function buildBranchGraphLanes(graph: BranchGraph, flowOf: (node: BranchGraphNode) => number): BranchGraphLanes {
    const laneByNodeId = new Map<string, number>()
    if (graph.nodes.length === 0) return { laneByNodeId, columns: 1 }

    const nodeById = new Map(graph.nodes.map((node) => [node.id, node]))
    const children = new Map<string, Array<{ id: string, active: boolean }>>()
    const incoming = new Set<string>()
    for (const edge of graph.edges) {
        const siblings = children.get(edge.from) ?? []
        siblings.push({ id: edge.to, active: edge.active })
        children.set(edge.from, siblings)
        incoming.add(edge.to)
    }

    const chains: PackedChain[] = []
    const chainOf = new Map<string, number>()
    const pending: string[] = []
    const buildChain = (startId: string) => {
        if (chainOf.has(startId)) return
        const chain: PackedChain = { nodeIds: [], start: Number.POSITIVE_INFINITY, end: Number.NEGATIVE_INFINITY }
        let current: string | undefined = startId
        while (current !== undefined && !chainOf.has(current)) {
            chainOf.set(current, chains.length)
            chain.nodeIds.push(current)
            const flow = flowOf(nodeById.get(current)!)
            if (flow < chain.start) chain.start = flow
            if (flow > chain.end) chain.end = flow
            const childEdges: Array<{ id: string, active: boolean }> = children.get(current) ?? []
            const primary = childEdges.find((child) => child.active) ?? childEdges[0]
            for (const child of childEdges) {
                if (child.id !== primary?.id && !chainOf.has(child.id)) pending.push(child.id)
            }
            current = primary !== undefined && !chainOf.has(primary.id) ? primary.id : undefined
        }
        chains.push(chain)
    }

    for (const node of graph.nodes) {
        if (!incoming.has(node.id)) buildChain(node.id)
        // A queue index instead of shift(): thousands of swipe leaves would
        // make shift() quadratic.
        for (let i = 0; i < pending.length; i++) buildChain(pending[i])
        pending.length = 0
    }
    for (const node of graph.nodes) if (!chainOf.has(node.id)) buildChain(node.id)

    const activeTerminal = graph.nodes.find((node) => node.activeTerminal)
    const activeChain = activeTerminal ? chainOf.get(activeTerminal.id) : undefined
    const ordered = chains
        .map((chain, index) => ({ chain, index }))
        .sort((a, b) => a.chain.start - b.chain.start || a.index - b.index)
    if (activeChain !== undefined) {
        const at = ordered.findIndex((entry) => entry.index === activeChain)
        if (at > 0) ordered.unshift(...ordered.splice(at, 1))
    }

    const laneIntervals: Array<Array<{ start: number, end: number }>> = []
    const laneOfChain = new Map<number, number>()
    for (const { chain, index } of ordered) {
        let lane = 0
        for (; lane < laneIntervals.length; lane++) {
            let overlaps = false
            for (const interval of laneIntervals[lane]) {
                if (interval.start > chain.end) break
                if (interval.end >= chain.start) {
                    overlaps = true
                    break
                }
            }
            if (!overlaps) break
        }
        const intervals = laneIntervals[lane] ?? []
        const insertAt = intervals.findIndex((interval) => interval.start > chain.start)
        if (insertAt === -1) intervals.push({ start: chain.start, end: chain.end })
        else intervals.splice(insertAt, 0, { start: chain.start, end: chain.end })
        laneIntervals[lane] = intervals
        laneOfChain.set(index, lane)
    }
    chains.forEach((chain, index) => {
        const lane = laneOfChain.get(index) ?? 0
        for (const id of chain.nodeIds) laneByNodeId.set(id, lane)
    })
    return { laneByNodeId, columns: Math.max(1, laneIntervals.length) }
}

export interface BranchGraphRows {
    rowByNodeId: Map<string, number>
    rows: number
}

interface RowCandidate {
    id: string
    time: number
    active: number
    order: number
}

/**
 * git log --graph rows (from HaejeokRisu): one node per row, ordered by
 * message time when known (else the parent's + 1), parents before children.
 */
export function buildBranchGraphGitRows(graph: BranchGraph): BranchGraphRows {
    const nodes = graph.nodes
    const rowByNodeId = new Map<string, number>()
    if (nodes.length === 0) return { rowByNodeId, rows: 0 }

    const nodeById = new Map(nodes.map((node) => [node.id, node]))
    const orderById = new Map(nodes.map((node, index) => [node.id, index]))
    const children = new Map<string, string[]>()
    const indegree = new Map<string, number>(nodes.map((node) => [node.id, 0]))
    const parentOf = new Map<string, string>()
    for (const edge of graph.edges) {
        if (!indegree.has(edge.from) || !indegree.has(edge.to)) continue
        const siblings = children.get(edge.from) ?? []
        siblings.push(edge.to)
        children.set(edge.from, siblings)
        indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1)
        if (!parentOf.has(edge.to)) parentOf.set(edge.to, edge.from)
    }

    // Nodes are sorted by depth, so a parent's time is known before its children's.
    const effectiveTime = new Map<string, number>()
    for (const node of nodes) {
        if (node.time !== undefined) {
            effectiveTime.set(node.id, node.time)
            continue
        }
        const parentId = parentOf.get(node.id)
        const parentTime = parentId === undefined ? undefined : effectiveTime.get(parentId)
        effectiveTime.set(node.id, parentTime === undefined ? 0 : parentTime + 1)
    }

    const less = (a: RowCandidate, b: RowCandidate) =>
        a.time !== b.time ? a.time < b.time
            : a.active !== b.active ? a.active < b.active
                : a.order < b.order
    const heap: RowCandidate[] = []
    const push = (id: string) => {
        heap.push({
            id,
            time: effectiveTime.get(id) ?? 0,
            active: nodeById.get(id)?.activePath ? 0 : 1,
            order: orderById.get(id) ?? 0,
        })
        let index = heap.length - 1
        while (index > 0) {
            const parent = (index - 1) >> 1
            if (less(heap[parent], heap[index])) break
            ;[heap[parent], heap[index]] = [heap[index], heap[parent]]
            index = parent
        }
    }
    const pop = () => {
        const top = heap[0]
        const last = heap.pop()!
        if (heap.length > 0) {
            heap[0] = last
            let index = 0
            for (;;) {
                const left = index * 2 + 1
                const right = left + 1
                let smallest = index
                if (left < heap.length && less(heap[left], heap[smallest])) smallest = left
                if (right < heap.length && less(heap[right], heap[smallest])) smallest = right
                if (smallest === index) break
                ;[heap[smallest], heap[index]] = [heap[index], heap[smallest]]
                index = smallest
            }
        }
        return top
    }

    for (const node of nodes) if ((indegree.get(node.id) ?? 0) === 0) push(node.id)
    let rows = 0
    while (heap.length > 0) {
        const { id } = pop()
        rowByNodeId.set(id, rows++)
        for (const childId of children.get(id) ?? []) {
            const remaining = (indegree.get(childId) ?? 0) - 1
            indegree.set(childId, remaining)
            if (remaining === 0) push(childId)
        }
    }
    for (const node of nodes) if (!rowByNodeId.has(node.id)) rowByNodeId.set(node.id, rows++)
    return { rowByNodeId, rows }
}

// ── Click targets ───────────────────────────────────────────────────────────

export interface BranchGraphTarget {
    chatIndex: number
    chatId: string
    /** -1: the chat's top (its greeting). */
    messageIndex: number
    messageId: string
    swipeIndex?: number
    swipePreview?: string
}

/**
 * Where a click on a node lands. A message the active chat shares (its copied
 * prefix, or its own) opens in the active chat; anything else opens in the
 * chat that owns it. Summaries have no target (they unfold instead).
 */
export function branchGraphTarget(forest: BranchForest, node: BranchGraphNode): BranchGraphTarget | null {
    if (node.kind === 'summary') return null
    let target: BranchGraphTarget
    const activeChat = forest.chats.get(forest.activeChatIndex)
    const activePosition = forest.activePositions.get(node.sourceId)
    if (node.kind === 'root' && forest.activePath.has(node.sourceId) && activeChat) {
        target = { chatIndex: activeChat.index, chatId: activeChat.id, messageIndex: -1, messageId: '' }
    } else if (activeChat && activePosition !== undefined) {
        target = {
            chatIndex: activeChat.index,
            chatId: activeChat.id,
            messageIndex: activePosition,
            messageId: activeChat.messages[activePosition]?.id ?? '',
        }
    } else {
        target = { chatIndex: node.chatIndex, chatId: node.chatId, messageIndex: node.messageIndex, messageId: node.messageId }
    }
    if (node.kind === 'swipe') {
        target.swipeIndex = node.swipeIndex
        target.swipePreview = node.preview
    }
    return target
}

/**
 * The swipe of `swipes` a graph node meant: `hint` when its preview still
 * matches, else the first swipe with that preview, else -1. Without a
 * preview the hint is trusted when in range.
 */
export function resolveSwipeIndex(swipes: unknown, hint: number, wantedPreview?: string): number {
    if (!Array.isArray(swipes)) return -1
    const inRange = Number.isInteger(hint) && hint >= 0 && hint < swipes.length
    if (wantedPreview === undefined) return inRange ? hint : -1
    if (inRange && previewText(swipes[hint]) === wantedPreview) return hint
    for (let j = 0; j < swipes.length; j++) {
        if (previewText(swipes[j]) === wantedPreview) return j
    }
    return -1
}

// ── Lazy loading plan ───────────────────────────────────────────────────────

/** Chat name without the " (Branch 2)" / " (Copy)" suffixes createChatCopyName adds. */
export function baseChatName(name: string): string {
    let base = (name ?? '').trim()
    for (;;) {
        const next = base.replace(/\s*\((?:Copy|Branch)(?: \d+)?\)$/, '').trim()
        if (next === base) return base
        base = next
    }
}

export interface LoadPlanOptions {
    limit: number
    /** Also pick chats with no sign of being related, newest first. */
    includeOthers: boolean
    /** Chat ids already read or tried. */
    skip?: ReadonlySet<string>
}

/**
 * Unloaded chats to read next, best first: parents that the active chat's
 * loaded family points at, then chats that look related by name ("X (Branch
 * 2)") or folder (newest first), then, only when asked, every other chat
 * (newest first). Placeholder metadata is all this needs.
 */
export function pickChatsToLoad(chats: readonly GraphChat[], activeChatIndex: number, options: LoadPlanOptions): string[] {
    const skip = options.skip ?? EMPTY_SET
    const limit = Math.max(0, options.limit)
    const loadedById = new Map<string, GraphChat>()
    const unloadedById = new Map<string, GraphChat>()
    for (const chat of chats) {
        if (!chat.id) continue
        if (chat.loaded) {
            if (!loadedById.has(chat.id)) loadedById.set(chat.id, chat)
        } else if (!skip.has(chat.id) && !unloadedById.has(chat.id)) {
            unloadedById.set(chat.id, chat)
        }
    }

    // The active chat's family among loaded chats: linked either way.
    const parentOf = new Map<GraphChat, string>()
    const childrenOf = new Map<string, GraphChat[]>()
    for (const chat of loadedById.values()) {
        let link: BranchLink | null = null
        for (let k = chat.messages.length - 1; k >= 0 && !link; k--) link = chat.messages[k].link
        if (!link) continue
        parentOf.set(chat, link.parentChatId)
        const siblings = childrenOf.get(link.parentChatId) ?? []
        siblings.push(chat)
        childrenOf.set(link.parentChatId, siblings)
    }
    const active = chats.find((chat) => chat.index === activeChatIndex)
    const family = new Set<GraphChat>()
    if (active) {
        family.add(active)
        const queue: GraphChat[] = active.loaded ? [active] : []
        for (let i = 0; i < queue.length; i++) {
            const chat = queue[i]
            const neighbours = [...(childrenOf.get(chat.id) ?? [])]
            const parent = loadedById.get(parentOf.get(chat) ?? '')
            if (parent) neighbours.push(parent)
            for (const neighbour of neighbours) {
                if (family.has(neighbour)) continue
                family.add(neighbour)
                queue.push(neighbour)
            }
        }
    }

    const picked: string[] = []
    const pick = (id: string) => {
        if (picked.length < limit && unloadedById.has(id) && !picked.includes(id)) picked.push(id)
    }
    for (const chat of family) {
        const parentId = parentOf.get(chat)
        if (parentId) pick(parentId)
    }

    const newestFirst = [...unloadedById.values()].sort((a, b) => b.lastDate - a.lastDate || a.index - b.index)
    const names = new Set<string>()
    const folders = new Set<string>()
    for (const chat of family) {
        const base = baseChatName(chat.name)
        if (base) names.add(base)
        if (chat.folderId) folders.add(chat.folderId)
    }
    for (const chat of newestFirst) {
        if (names.has(baseChatName(chat.name)) || (chat.folderId && folders.has(chat.folderId))) pick(chat.id)
    }
    if (options.includeOthers) {
        for (const chat of newestFirst) pick(chat.id)
    }
    return picked
}
