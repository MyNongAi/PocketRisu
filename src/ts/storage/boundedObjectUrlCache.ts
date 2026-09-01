/**
 * Small LRU used by image presentation code. Blob URLs are revoked only after
 * their final cache reference disappears; ordinary HTTP/data URLs are left to
 * their owning storage/provider.
 */
export class BoundedObjectUrlCache {
    private readonly values = new Map<string, { value: string, fullResolution: boolean }>()

    constructor(
        private readonly maxEntries: number,
        private readonly maxFullResolutionEntries: number,
    ) {}

    get size(): number {
        return this.values.size
    }

    get(key: string): string | undefined {
        const entry = this.values.get(key)
        if(!entry) return undefined
        this.values.delete(key)
        this.values.set(key, entry)
        return entry.value
    }

    set(key: string, value: string, fullResolution = false): void {
        const previous = this.values.get(key)
        if(previous) this.values.delete(key)
        this.values.set(key, { value, fullResolution })
        if(previous && previous.value !== value) this.revokeIfUnused(previous.value)
        this.trim()
    }

    delete(key: string): boolean {
        const entry = this.values.get(key)
        if(!entry) return false
        const deleted = this.values.delete(key)
        if(deleted) this.revokeIfUnused(entry.value)
        return deleted
    }

    clear(): void {
        const blobUrls = new Set(
            [...this.values.values()]
                .map((entry) => entry.value)
                .filter((value) => value.startsWith('blob:')),
        )
        this.values.clear()
        if(typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
            for(const url of blobUrls) URL.revokeObjectURL(url)
        }
    }

    keys(): IterableIterator<string> {
        return this.values.keys()
    }

    private trim(): void {
        let fullResolutionCount = 0
        for(const entry of this.values.values()) {
            if(entry.fullResolution) fullResolutionCount++
        }

        if(fullResolutionCount > this.maxFullResolutionEntries) {
            for(const [key, entry] of [...this.values]) {
                if(!entry.fullResolution) continue
                this.delete(key)
                fullResolutionCount--
                if(fullResolutionCount <= this.maxFullResolutionEntries) break
            }
        }

        while(this.values.size > this.maxEntries) {
            const oldest = this.values.keys().next().value as string | undefined
            if(oldest === undefined) break
            this.delete(oldest)
        }
    }

    private revokeIfUnused(value: string): void {
        if(!value.startsWith('blob:')) return
        for(const entry of this.values.values()) {
            if(entry.value === value) return
        }
        if(typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
            URL.revokeObjectURL(value)
        }
    }
}

export function createDeduplicatedImageLoader(
    cache: BoundedObjectUrlCache,
): (key: string, loader: () => Promise<string>, fullResolution?: boolean) => Promise<string> {
    const pending = new Map<string, Promise<string>>()

    return async (key, loader, fullResolution = false) => {
        const cached = cache.get(key)
        if(cached !== undefined) return cached

        let request = pending.get(key)
        if(!request) {
            request = loader()
            pending.set(key, request)
            void request.then(
                () => {
                    if(pending.get(key) === request) pending.delete(key)
                },
                () => {
                    if(pending.get(key) === request) pending.delete(key)
                },
            )
        }

        const value = await request
        if(value) cache.set(key, value, fullResolution)
        return value
    }
}
