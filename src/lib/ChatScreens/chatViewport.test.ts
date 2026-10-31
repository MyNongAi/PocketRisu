import { describe, expect, it } from 'vitest'
import {
    distanceFromTail,
    isAtTail,
    lineKey,
    matchingLineIndex,
    revealScrollTop,
    shouldFollowTail,
    shouldLoadOlderPages,
    shouldRevealAddedMessage,
} from './chatViewport'

// A 600px view over 5000px of transcript; scrollTop 0 is the oldest message.
const box = (scrollTop: number, scrollHeight = 5000, clientHeight = 600) => ({ scrollTop, scrollHeight, clientHeight })

describe('chat viewport (top-origin scroller)', () => {
    it('measures the tail from the far end', () => {
        expect(distanceFromTail(box(4400))).toBe(0)
        expect(isAtTail(box(4400))).toBe(true)
        expect(isAtTail(box(4350))).toBe(true)
        expect(isAtTail(box(1000))).toBe(false)
    })

    it('does not follow streamed text unless auto-scroll is on', () => {
        const streaming = { pinnedToTail: false, readerAtTail: true, onlyTranscriptResized: true }
        expect(shouldFollowTail({ ...streaming, autoScroll: false })).toBe(false)
        expect(shouldFollowTail({ ...streaming, autoScroll: true })).toBe(true)
        expect(shouldFollowTail({ ...streaming, readerAtTail: false, autoScroll: true })).toBe(false)
    })

    it('keeps a reader at the tail there when the viewport or composer resizes', () => {
        expect(shouldFollowTail({ pinnedToTail: false, readerAtTail: true, onlyTranscriptResized: false, autoScroll: false })).toBe(true)
        expect(shouldFollowTail({ pinnedToTail: false, readerAtTail: false, onlyTranscriptResized: false, autoScroll: false })).toBe(false)
    })

    it('keeps a just-opened chat at its tail while it renders', () => {
        expect(shouldFollowTail({ pinnedToTail: true, readerAtTail: false, onlyTranscriptResized: true, autoScroll: false })).toBe(true)
    })

    it('reveals a sent message wherever the reader was, and never scrolls up to the top', () => {
        expect(shouldRevealAddedMessage({ wasAtTail: false, role: 'user', autoScroll: false, alwaysScroll: false })).toBe(true)
        // Reveal moves toward the tail, never back up.
        expect(revealScrollTop(box(1000, 5200), 4900)).toBe(4600)
        expect(revealScrollTop(box(4400, 4400 + 600 + 50), 4300)).toBe(4400)
    })

    it('leaves a reader in history alone when a reply starts', () => {
        expect(shouldRevealAddedMessage({ wasAtTail: false, role: 'char', autoScroll: false, alwaysScroll: false })).toBe(false)
        expect(shouldRevealAddedMessage({ wasAtTail: true, role: 'char', autoScroll: false, alwaysScroll: false })).toBe(true)
        expect(shouldRevealAddedMessage({ wasAtTail: false, role: 'char', autoScroll: true, alwaysScroll: true })).toBe(true)
    })

    it('shows the first line of a reply taller than the view', () => {
        // The reply starts at 4800 and the tail is at 6400: stop at its start.
        expect(revealScrollTop(box(4400, 7000), 4800)).toBe(4800)
        // A short reply fits: go to the tail.
        expect(revealScrollTop(box(4400, 5200), 4900)).toBe(4600)
    })

    it('loads older pages near the top, where the oldest message is', () => {
        expect(shouldLoadOlderPages(box(40), 20, 100)).toBe(true)
        expect(shouldLoadOlderPages(box(40), 100, 100)).toBe(false)
        expect(shouldLoadOlderPages(box(4400), 20, 100)).toBe(false)
    })

    it('finds the line being read in its redrawn message by its text, the nearest of equals', () => {
        // A rerolled reply's old page, drawn again with a taller header: every line 24px lower.
        const redrawn = [
            { text: 'header', top: 0 },
            { text: 'first paragraph', top: 64 },
            { text: 'same words', top: 224 },
            { text: 'the line being read', top: 424 },
            { text: 'same words', top: 624 },
        ]
        expect(matchingLineIndex(redrawn, 'the line being read', 400)).toBe(3)
        expect(matchingLineIndex(redrawn, 'same words', 600)).toBe(4)
        expect(matchingLineIndex(redrawn, 'same words', 210)).toBe(2)
        expect(matchingLineIndex(redrawn, 'a line no longer there', 400)).toBe(-1)
        expect(matchingLineIndex(redrawn, '', 0)).toBe(-1)
        expect(lineKey('x'.repeat(500))).toHaveLength(200)
        expect(lineKey(null)).toBe('')
    })
})
