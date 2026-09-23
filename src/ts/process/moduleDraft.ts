/**
 * Module editors work on a detached draft. Keeping a live DB proxy in the
 * form makes every keystroke wake the module save tracker, runtime refresh,
 * and duplicate-lore comparison across the full catalogue.
 */
export function cloneModuleDraft<T>(source: T): T {
    return structuredClone(source)
}
