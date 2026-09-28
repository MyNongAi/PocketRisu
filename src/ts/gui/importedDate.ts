// yy.mm.dd of the time a card was imported: compact enough to end a line of
// catalog metrics. Cards imported before the field existed have no date ('').
export function formatImportedDate(ms: number | null | undefined): string {
    if (!ms) return ''
    const d = new Date(ms)
    if (Number.isNaN(d.getTime())) return ''
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${pad(d.getFullYear() % 100)}.${pad(d.getMonth() + 1)}.${pad(d.getDate())}`
}
