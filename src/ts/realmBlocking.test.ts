import { describe, expect, it } from "vitest"
import {
    addBlockedRealmCard,
    addBlockedRealmCreator,
    filterBlockedRealmBots,
    isRealmCardBlocked,
    removeBlockedRealmCard,
    filterBlockedRealmCards,
    isRealmCreatorBlocked,
    removeBlockedRealmCreator,
} from "./realmBlocking"

describe("RisuRealm creator blocking", () => {
    const blockedCreators = [{ id: "creator-1", name: "Creator One" }]

    it("matches creators by ID", () => {
        expect(isRealmCreatorBlocked(blockedCreators, "creator-1")).toBe(true)
        expect(isRealmCreatorBlocked(blockedCreators, "creator-2")).toBe(false)
        expect(isRealmCreatorBlocked(blockedCreators)).toBe(false)
    })

    it("adds a creator without creating duplicate entries", () => {
        const added = addBlockedRealmCreator(blockedCreators, { id: "creator-2", name: "Creator Two" })
        const duplicate = addBlockedRealmCreator(added, { id: "creator-2", name: "Renamed Creator" })

        expect(added).toEqual([
            ...blockedCreators,
            { id: "creator-2", name: "Creator Two" },
        ])
        expect(duplicate).toBe(added)
    })

    it("ignores a creator without an ID", () => {
        expect(addBlockedRealmCreator(blockedCreators, { id: "", name: "Unknown" })).toBe(blockedCreators)
    })

    it("removes a creator by ID", () => {
        expect(removeBlockedRealmCreator(blockedCreators, "creator-1")).toEqual([])
    })

    it("filters all cards from blocked creators and preserves cards without creator metadata", () => {
        const cards = [
            { id: "card-1", creator: "creator-1" },
            { id: "card-2", creator: "creator-2" },
            { id: "legacy-card" },
        ]

        expect(filterBlockedRealmCards(cards, blockedCreators)).toEqual([
            { id: "card-2", creator: "creator-2" },
            { id: "legacy-card" },
        ])
    })
})

// PocketRisu: one bot, not all of its creator's (the user's request, 2026-10-22).
describe("RisuRealm single-bot blocking", () => {
    const blocked = [{ id: "card-1", name: "Bot One" }]

    it("blocks that bot only, whoever made it", () => {
        const cards = [
            { id: "card-1", creator: "creator-1" },
            { id: "card-2", creator: "creator-1" },
            { id: "card-3", creator: "creator-2" },
        ]
        expect(filterBlockedRealmBots(cards, blocked).map((card) => card.id)).toEqual(["card-2", "card-3"])
        expect(isRealmCardBlocked(blocked, "card-1")).toBe(true)
        expect(isRealmCardBlocked(blocked, "card-2")).toBe(false)
        expect(isRealmCardBlocked(blocked)).toBe(false)
    })

    it("adds without duplicates and removes by id", () => {
        const added = addBlockedRealmCard(blocked, { id: "card-2", name: "Bot Two" })
        expect(addBlockedRealmCard(added, { id: "card-2", name: "Renamed" })).toBe(added)
        expect(added).toHaveLength(2)
        expect(removeBlockedRealmCard(added, "card-1")).toEqual([{ id: "card-2", name: "Bot Two" }])
    })
})
