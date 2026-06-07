import { describe, it, expect } from 'vitest'
import { randomBytes } from 'node:crypto'
import pkg from './chunkStore.cjs'

const { cdcSplit } = pkg as { cdcSplit: (buf: Buffer) => { hash: string; data: Buffer }[] }

describe('cdcSplit — content-defined chunking (pure)', () => {
    it('A1: 분할한 조각을 다시 이으면 원본과 바이트 동일', () => {
        const buf = randomBytes(200_000)
        const chunks = cdcSplit(buf)
        const reassembled = Buffer.concat(chunks.map((c) => c.data))
        expect(reassembled.equals(buf)).toBe(true)
    })

    it('A1b: 빈 버퍼는 조각 0개, 재조립은 빈 버퍼', () => {
        const chunks = cdcSplit(Buffer.alloc(0))
        expect(chunks).toHaveLength(0)
        expect(Buffer.concat(chunks.map((c) => c.data)).length).toBe(0)
    })

    it('A2: 같은 입력 → 같은 조각(경계·해시 결정적)', () => {
        const buf = randomBytes(200_000)
        const a = cdcSplit(buf).map((c) => c.hash)
        const b = cdcSplit(buf).map((c) => c.hash)
        expect(b).toEqual(a)
    })

    it('A3: 조각 크기가 min/max 경계 준수 (마지막 제외 ≥MIN, 전부 ≤MAX)', () => {
        const chunks = cdcSplit(randomBytes(500_000))
        chunks.forEach((c, i) => {
            expect(c.data.length).toBeLessThanOrEqual(65536)
            if (i < chunks.length - 1) expect(c.data.length).toBeGreaterThanOrEqual(4096)
        })
    })

    it('A4: 중간 삽입 시 대부분 조각 공유(dedup) — 재기록 <5%', () => {
        const buf = randomBytes(500_000)
        const at = 250_000
        const mutated = Buffer.concat([buf.subarray(0, at), randomBytes(120), buf.subarray(at)])
        const base = cdcSplit(buf)
        const next = cdcSplit(mutated)
        const baseHashes = new Set(base.map((c) => c.hash))
        const shared = next.filter((c) => baseHashes.has(c.hash))
        // CDC가 삽입 지점 뒤에서 재동기화 → 변경 조각은 극소수
        expect(shared.length).toBeGreaterThanOrEqual(next.length - 3)
        const rewriteBytes = next
            .filter((c) => !baseHashes.has(c.hash))
            .reduce((s, c) => s + c.data.length, 0)
        expect(rewriteBytes).toBeLessThan(buf.length * 0.05)
    })
})
