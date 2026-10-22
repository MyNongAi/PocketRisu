import type { BlockedRealmCard, BlockedRealmCreator } from "./storage/database.svelte"

type RealmCreatorData = {
    creator?: string
}

export function isRealmCreatorBlocked(blockedCreators: BlockedRealmCreator[], creator?: string): boolean {
    return !!creator && blockedCreators.some((blockedCreator) => blockedCreator.id === creator)
}

export function addBlockedRealmCreator(
    blockedCreators: BlockedRealmCreator[],
    creator: BlockedRealmCreator,
): BlockedRealmCreator[] {
    if (!creator.id || isRealmCreatorBlocked(blockedCreators, creator.id)) {
        return blockedCreators
    }

    return [...blockedCreators, creator]
}

export function removeBlockedRealmCreator(
    blockedCreators: BlockedRealmCreator[],
    creatorId: string,
): BlockedRealmCreator[] {
    return blockedCreators.filter((blockedCreator) => blockedCreator.id !== creatorId)
}

export function filterBlockedRealmCards<T extends RealmCreatorData>(
    cards: T[],
    blockedCreators: BlockedRealmCreator[],
): T[] {
    return cards.filter((card) => !isRealmCreatorBlocked(blockedCreators, card.creator))
}

// PocketRisu: blocking one bot rather than all of a creator's (the user's
// request, 2026-10-22). A blocked bot is only hidden from the Realm list,
// from the user's own list; nothing is asked of Realm, and a download of it
// (a link, its id) still works.
export function isRealmCardBlocked(blockedCards: BlockedRealmCard[], id?: string): boolean {
    return !!id && blockedCards.some((card) => card.id === id)
}

export function addBlockedRealmCard(blockedCards: BlockedRealmCard[], card: BlockedRealmCard): BlockedRealmCard[] {
    if (!card.id || isRealmCardBlocked(blockedCards, card.id)) {
        return blockedCards
    }

    return [...blockedCards, card]
}

export function removeBlockedRealmCard(blockedCards: BlockedRealmCard[], id: string): BlockedRealmCard[] {
    return blockedCards.filter((card) => card.id !== id)
}

export function filterBlockedRealmBots<T extends { id?: string }>(cards: T[], blockedCards: BlockedRealmCard[]): T[] {
    return cards.filter((card) => !isRealmCardBlocked(blockedCards, card.id))
}
