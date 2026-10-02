/**
 * A Map that holds at most `maxEntries` entries. get() and set() mark a key as
 * the most recently used one; inserting past the cap drops the least recently
 * used key. has() and iteration leave the order alone, and iteration runs from
 * the least to the most recently used key.
 */
export class LruMap<K, V> extends Map<K, V> {
    readonly maxEntries: number

    constructor(maxEntries: number) {
        // No initial entries: Map's constructor would call set() before
        // maxEntries is assigned.
        super()
        if (!Number.isInteger(maxEntries) || maxEntries < 1) {
            throw new RangeError(`LruMap needs a positive integer cap, got ${maxEntries}`)
        }
        this.maxEntries = maxEntries
    }

    override get(key: K): V | undefined {
        if (!super.has(key)) return undefined
        const value = super.get(key) as V
        // Re-insert to move the key to the most recent end of the order
        super.delete(key)
        super.set(key, value)
        return value
    }

    override set(key: K, value: V): this {
        super.delete(key)
        super.set(key, value)
        while (this.size > this.maxEntries) {
            super.delete(super.keys().next().value as K)
        }
        return this
    }
}
