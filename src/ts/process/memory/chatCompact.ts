// CHAT-COMPACT (2026-11-23): manual HypaV3 compaction keeps the conversation intact.
import { getDatabase, type Chat, type Message, type character } from 'src/ts/storage/database.svelte';
import type { OpenAIChat } from '../index.svelte';
import { getCurrentHypaV3Preset, summarize } from './hypav3';
import { hypaV3ProgressStore } from 'src/ts/stores.svelte';
import { TaskRateLimiter } from './taskRateLimiter';

export type CompactMode = 'count' | 'model';

export function compactCommand(input: string): string | null {
    const match = /^\/compact(?:\s+([\s\S]*))?$/i.exec(input.trim());
    return match ? (match[1] ?? '').trim() : null;
}

export function compactGuardReason(open: boolean, busy: boolean, active: boolean): 'noChat' | 'busy' | 'noMemory' | null {
    if (!open) return 'noChat';
    if (busy) return 'busy';
    if (!active) return 'noMemory';
    return null;
}

export function compactKeepCount(value: unknown): number {
    return typeof value === 'number' && Number.isInteger(value) && value >= 0
        ? value : 6;
}

// After the last message any summary covers. HypaV3 itself starts after the
// last summary's last message; when that message was deleted it would start
// from the top, and a compact from there would summarize covered messages again.
export function compactCoveredEnd(messages: Message[], summaries: { chatMemos: Iterable<string> }[]): number {
    const covered = new Set(summaries.flatMap(summary => [...summary.chatMemos]));
    let end = 0;
    messages.forEach((message, index) => { if (message.chatId && covered.has(message.chatId)) end = index + 1 });
    return end;
}

export function compactModelKeep(answer: string, windowSize: number, fallback: number): number {
    // The first number in the answer ("12", "12.", "Message 12").
    const found = /\d+/.exec(answer);
    if (!found) return fallback;
    const start = Number(found[0]);
    const kept = windowSize - start + 1;
    return start >= 1 && start <= windowSize && kept >= 2 && kept <= 30 ? kept : fallback;
}

export interface CompactDependencies {
    summarize: typeof summarize;
    progress: typeof hypaV3ProgressStore.set;
    liveChat?: () => Chat | null | undefined;
}

const liveDependencies: CompactDependencies = {
    summarize,
    progress: value => hypaV3ProgressStore.set(value),
};

export async function compactChat(
    char: character,
    chat: Chat,
    mode: CompactMode,
    configuredKeep: number,
    focusNote = '',
    dependencies: CompactDependencies = liveDependencies,
): Promise<'done' | 'empty'> {
    const settings = getCurrentHypaV3Preset(char, chat).settings;
    const messages = chat.message;
    const liveChat = dependencies.liveChat ?? (() => {
        if (!char.chaId || !chat.id) return chat;
        const owner = getDatabase().characters.find(candidate => candidate?.chaId === char.chaId);
        return owner?.chats.find(candidate => candidate?.id === chat.id);
    });
    const currentChat = () => {
        const current = liveChat();
        if (!current) throw new Error('The chat changed while compacting; nothing more was saved.');
        return current;
    };
    let keep = compactKeepCount(configuredKeep);
    if (messages.length <= keep) return 'empty';
    const covered = compactCoveredEnd(messages, chat.hypaV3Data?.summaries ?? []);
    if (covered >= messages.length) return 'empty';
    if (mode === 'model' && messages.length >= 2) {
        const window = messages.slice(-30);
        const excerpts = window.map((message, index) =>
            `${index + 1}. ${message.role}: ${message.data.replace(/\s+/g, ' ').slice(0, 150)}`
        );
        try {
            const answer = await dependencies.summarize(
                [{ role: 'user', content: excerpts.join('\n') }], false,
                { currentChar: char, currentChat: chat },
                { instructionOverride: 'Choose where the current scene begins. Answer with only the numbered message at which it begins. Keep at least two messages.' },
            );
            keep = compactModelKeep(answer, window.length, keep);
        } catch {
            // The configured count is the fallback for a failed scene decision.
        }
        currentChat();
    }
    const end = Math.max(covered, messages.length - keep);
    if (end <= covered) return 'empty';

    const chunkSize = Math.max(1, Math.floor(settings.maxChatsPerSummary));
    const limiter = new TaskRateLimiter({
        tasksPerMinute: settings.summarizationModel === 'subModel'
            ? Math.max(1, settings.summarizationRequestsPerMinute) : 1000,
        maxConcurrentTasks: 1,
    });
    for (let start = covered; start < end; start += chunkSize) {
        const chunk = messages.slice(start, Math.min(start + chunkSize, end));
        if (chunk.some(message => !message.chatId)) throw new Error('A message has no ID; compaction cannot safely track its coverage.');
        const input: OpenAIChat[] = chunk
            .filter(message => message.data.trim() !== '')
            .map(message => ({ role: message.role === 'char' ? 'assistant' : 'user', content: message.data, memo: message.chatId }));
        if (input.length === 0) continue;
        dependencies.progress({ open: true, msg: '[HypaV3] Summarizing...', subMsg: `${Math.min(start + chunkSize, end)}/${end}`, miniMsg: '' });
        try {
            const result = await limiter.executeTask(() => dependencies.summarize(input, false,
                { currentChar: char, currentChat: chat }, { focusNote }));
            const live = currentChat();
            if (!result.success) throw result.error;
            const ids = new Set(live.message.map(message => message.chatId));
            if (chunk.some(message => !ids.has(message.chatId))) throw new Error('The chat changed while compacting; nothing more was saved.');
            const text = result.data!;
            const summaries = [...(live.hypaV3Data?.summaries ?? []),
                { text, chatMemos: chunk.map(message => message.chatId!), isImportant: false, tags: [] }];
            live.hypaV3Data = { ...live.hypaV3Data, summaries };
        } finally {
            dependencies.progress({ open: false, msg: '', subMsg: '', miniMsg: '' });
        }
    }
    return 'done';
}
