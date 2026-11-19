// User request, 2026-11-20: built-in edit sends use the utility prompt by default.
export function useUtilityEditPrompt(editModeOn: boolean, fullPrompt?: boolean): boolean {
    return editModeOn && fullPrompt !== true
}
