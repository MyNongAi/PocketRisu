// CHAT-COMPACT (2026-11-23): synthetic chats only.
import { describe, expect, it, vi } from 'vitest';
import type { Chat, character, Message } from 'src/ts/storage/database.svelte';

vi.mock('./hypav3', () => ({
    getCurrentHypaV3Preset: () => ({ settings: { maxChatsPerSummary: 3 } }),
    summarize: vi.fn(),
}));
vi.mock('src/ts/stores.svelte', () => ({ hypaV3ProgressStore: { set: vi.fn() } }));

import { compactChat, compactCommand, compactCoveredEnd, compactGuardReason, compactModelKeep } from './chatCompact';
import { withFocusNote } from './compactFocus';

function syntheticChat(count = 10): Chat {
    return { message: Array.from({ length: count }, (_, index): Message => ({
        role: index % 2 ? 'char' : 'user', data: `synthetic ${index}`, chatId: `synthetic-${index}`,
    })), hypaV3Data: { summaries: [] } } as Chat;
}

function deps(answers: string[] = []) {
    const summarize = vi.fn(async (..._args: any[]) => answers.shift() ?? 'synthetic summary');
    return { summarize: summarize as any, progress: vi.fn() };
}

const char = {} as character;

describe('manual chat compact', () => {
    it('intercepts only /compact and keeps its focus out of chat messages', () => {
        const chat = syntheticChat();
        expect(compactCommand('/compact 전투 결과 위주로')).toBe('전투 결과 위주로');
        expect(compactCommand('/compact')).toBe('');
        expect(compactCommand('hello /compact')).toBeNull();
        expect(chat.message).toHaveLength(10);
    });

    it('keeps exactly N raw, including zero, and passes the focus to each chunk', async () => {
        const chat = syntheticChat();
        const d = deps();
        expect(await compactChat(char, chat, 'count', 6, 'battle', d)).toBe('done');
        expect(chat.hypaV3Data?.summaries.at(-1)?.chatMemos.at(-1)).toBe('synthetic-3');
        expect(d.summarize.mock.calls[0][3]).toEqual({ focusNote: 'battle' });
        const zero = syntheticChat();
        await compactChat(char, zero, 'count', 0, '', deps());
        expect(zero.hypaV3Data?.summaries.at(-1)?.chatMemos.at(-1)).toBe('synthetic-9');
    });

    it('uses a valid scene boundary and falls back for invalid model output', async () => {
        expect(compactModelKeep('7', 10, 6)).toBe(4);
        expect(compactModelKeep('bad', 10, 6)).toBe(6);
        expect(compactModelKeep('10', 10, 6)).toBe(6);
        // The first number of a chatty answer counts.
        expect(compactModelKeep('7.', 10, 6)).toBe(4);
        expect(compactModelKeep('Message 7', 10, 6)).toBe(4);
        const chat = syntheticChat();
        const d = deps(['7']);
        await compactChat(char, chat, 'model', 6, '', d);
        expect(chat.hypaV3Data?.summaries.at(-1)?.chatMemos.at(-1)).toBe('synthetic-5');
        const bad = syntheticChat();
        await compactChat(char, bad, 'model', 6, '', deps(['nonsense']));
        expect(bad.hypaV3Data?.summaries.at(-1)?.chatMemos.at(-1)).toBe('synthetic-3');
    });

    it('skips messages covered by a prior summary', async () => {
        const chat = syntheticChat();
        chat.hypaV3Data!.summaries.push({ text: 'old', chatMemos: ['synthetic-0', 'synthetic-1'], isImportant: false });
        const d = deps();
        await compactChat(char, chat, 'count', 6, '', d);
        expect(compactCoveredEnd(chat.message, chat.hypaV3Data!.summaries)).toBe(4);
        expect(d.summarize.mock.calls[0][0][0].memo).toBe('synthetic-2');
    });

    it('does not summarize covered messages again when the last summary\'s last message was deleted', () => {
        const chat = syntheticChat();
        const summaries = [
            { text: 'a', chatMemos: ['synthetic-0', 'synthetic-1', 'synthetic-2'], isImportant: false },
            { text: 'b', chatMemos: ['synthetic-3', 'deleted-message'], isImportant: false },
        ];
        expect(compactCoveredEnd(chat.message, summaries)).toBe(4);
        expect(compactCoveredEnd(chat.message, [{ chatMemos: new Set(['synthetic-4']) }])).toBe(5);
    });

    it('puts the focus note in its own message before a closing prefill', () => {
        const make = (content: string) => ({ role: 'system', content });
        const prefilled = [{ role: 'system', content: 'P' }, { role: 'user', content: 'U' }, { role: 'assistant', content: 'A' }];
        expect(withFocusNote(prefilled, 'battle', make).map(c => c.role)).toEqual(['system', 'user', 'system', 'assistant']);
        expect(withFocusNote(prefilled, 'battle', make)[2].content).toBe('Focus for this summary: battle');
        expect(withFocusNote(prefilled.slice(0, 2), 'battle', make).at(-1)?.content).toBe('Focus for this summary: battle');
        // The configured prompt is never changed, and no note means no change.
        expect(prefilled[0].content).toBe('P');
        expect(withFocusNote(prefilled, '', make)).toBe(prefilled);
    });

    it('reports guards and empty work', async () => {
        expect(compactGuardReason(false, false, false)).toBe('noChat');
        expect(compactGuardReason(true, true, true)).toBe('busy');
        expect(compactGuardReason(true, false, false)).toBe('noMemory');
        const d = deps();
        expect(await compactChat(char, syntheticChat(6), 'count', 6, '', d)).toBe('empty');
        expect(d.summarize).not.toHaveBeenCalled();
    });
});
