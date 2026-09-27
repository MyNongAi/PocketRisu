import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const self = path.resolve(fileURLToPath(import.meta.url))
const roots = ['README.md', 'docs', 'tools', 'scripts', 'server', 'src', 'public']
const textExtensions = new Set([
    '.c', '.cjs', '.css', '.html', '.js', '.json', '.lua', '.md', '.mjs',
    '.svelte', '.ts', '.tsx', '.txt', '.yml', '.yaml',
])
const allowedWindowsUsers = new Set([
    '(사용자이름)', '<사용자이름>', 'public', 'user', 'username', 'your-name', 'yourname',
])
const failures = []

async function visit(target) {
    const portableTarget = target.replaceAll('\\', '/')
    // Prebuilt third-party workers contain toolchain paths such as
    // /home/web_user; they are generated dependencies, not project metadata.
    if (portableTarget.startsWith('public/assets/')) return
    const resolved = path.join(root, target)
    const entries = await readdir(resolved, { withFileTypes: true }).catch(() => null)
    if (entries) {
        for (const entry of entries) {
            if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') continue
            await visit(path.join(target, entry.name))
        }
        return
    }
    if (path.resolve(resolved) === self || !textExtensions.has(path.extname(target).toLowerCase())) return

    const source = await readFile(resolved, 'utf8').catch(() => null)
    if (source === null || source.includes('\0')) return
    const lines = source.split(/\r?\n/)
    for (let index = 0; index < lines.length; index++) {
        const line = lines[index]
        for (const match of line.matchAll(/[A-Za-z]:[\\/]+Users[\\/]+([^\\/\s"'\x60]+)/gi)) {
            if (!allowedWindowsUsers.has(match[1].toLowerCase())) {
                failures.push(target + ':' + (index + 1) + ': 개인 Windows 사용자 경로 — ' + match[0])
            }
        }
        if (/[H-Z]:[\\/]+(?:Download|Downloads|Risuai-Pork|NodeJs)(?=[\\/\s"'\x60]|$)/i.test(line)) {
            failures.push(target + ':' + (index + 1) + ': 배포 문서에 사설 작업 드라이브 경로가 있답니다')
        }
        for (const match of line.matchAll(/(?:^|[\s"'\x60])\/(?:home|Users)\/([^/\s"'\x60]+)/g)) {
            if (!allowedWindowsUsers.has(match[1].toLowerCase())) {
                failures.push(target + ':' + (index + 1) + ': 개인 Unix 사용자 경로 — ' + match[0].trim())
            }
        }
    }
}

for (const target of roots) await visit(target)

if (failures.length) {
    console.error('\n공개 트리 개인정보 검문 실패 ' + failures.length + '건\n')
    for (const failure of failures) console.error('- ' + failure)
    console.error('\n실제 사용자명·홈 경로를 환경 변수 또는 범용 예제로 바꾸시와요.\n')
    process.exitCode = 1
} else {
    console.log('공개 트리 개인정보 경로 검문 통과')
}
