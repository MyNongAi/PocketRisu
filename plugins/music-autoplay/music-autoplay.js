//@name music_autoplay
//@display-name 음악 자동 재생
//@api 3.0
//@version 1.0.0
//@arg platform string {{name::재생 플랫폼}}{{radio::유튜브|youtube,스포티파이|spotify,멜론 링크|melon,끄기|off}} 답변의 곡 표시를 어디서 재생할지 고릅니다.
//@arg youtube_api_key string {{name::유튜브 API 키}}{{placeholder::AIza...}} Google Cloud에서 만든 YouTube Data API v3 키. 없으면 유튜브 뮤직 검색 링크만 보입니다.
//@arg spotify_client_id string {{name::스포티파이 Client ID}} 스포티파이 개발자 사이트에서 만든 앱의 Client ID. 연결은 설정의 "음악 자동 재생" 메뉴에서 합니다.
//@arg add_instruction string {{name::곡 표시 지시문}}{{radio::넣기|on,안 넣기|off}} 봇에게 곡 표시(<music>아티스트 - 제목</music>)를 쓰라고 알려 줄지 고릅니다.

// Plays the song a reply names.
//
// A reply marks a song as <music>Artist - Title</music> (the plugin can ask
// the model for it, add_instruction). The mark is drawn as a card in the
// message:
//   - youtube: a YouTube player in the message, the official audio first
//     (a "- Topic" channel, music category). Each request for a reply makes a
//     one-off mark that only that reply's songs carry (<music>...|mark</music>);
//     those start by themselves, and the players of earlier songs are taken
//     out so two do not play at once. Older cards, and every card after the
//     app is opened again, play when tapped.
//   - spotify: the song starts in the Spotify app open on a phone or PC
//     (Spotify Connect, Premium only) once the reply is done.
//   - melon: a Melon search link (Melon has no public API).
// Search results are kept in pluginStorage, so a song is looked up once.
// The Spotify sign-in (PKCE, no client secret) is kept on this device only
// (getLocalPluginStorage) and is never written to the save file.

(async () => {
    // <music>query</music>, or <music>query|mark</music> in a reply made since
    // the app was opened. The mark sits in the text: the app drops attributes
    // of unknown tags before the display handlers see them.
    const TAG = /<music>([\s\S]{1,200}?)(?:\|([\w-]{6,24}))?<\/music>/gi
    const CACHE_PREFIX = 'music_autoplay:'
    const SPOTIFY_REDIRECT = 'http://127.0.0.1:8888/callback'
    const SPOTIFY_SCOPES = 'user-modify-playback-state user-read-playback-state'
    const INSTRUCTION = 'When a specific real song is playing or mentioned in the scene, write it once as <music>Artist - Title</music> (an existing song, original title). Do not write the tag otherwise.'

    const arg = async (key) => String((await risuai.getArgument(key)) ?? '').trim()
    const platform = async () => (await arg('platform')) || 'youtube'
    const escapeHtml = (text) => text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
    const normalize = (query) => query.replace(/\s+/g, ' ').trim()
    const keyOf = (query) => normalize(query).toLowerCase()

    // ---------- cache ----------
    async function cached(kind, query) {
        return await risuai.pluginStorage.getItem(`${CACHE_PREFIX}${kind}:${keyOf(query)}`)
    }
    async function remember(kind, query, value) {
        await risuai.pluginStorage.setItem(`${CACHE_PREFIX}${kind}:${keyOf(query)}`, value)
    }

    // ---------- YouTube ----------
    const ytInFlight = new Map()
    // The video id for a query: the cache, else one search (official audio first).
    function youtubeVideo(query) {
        const key = keyOf(query)
        if (!ytInFlight.has(key)) {
            ytInFlight.set(key, (async () => {
                const hit = await cached('yt', query)
                if (hit) return hit
                const apiKey = await arg('youtube_api_key')
                if (!apiKey) return null
                const url = 'https://www.googleapis.com/youtube/v3/search?' + new URLSearchParams({
                    part: 'snippet', type: 'video', videoEmbeddable: 'true', videoCategoryId: '10',
                    maxResults: '5', q: normalize(query), key: apiKey,
                })
                try {
                    const res = await risuai.nativeFetch(url)
                    const data = await res.json()
                    const items = Array.isArray(data?.items) ? data.items : []
                    const pick = items.find((item) => / - Topic$/.test(item?.snippet?.channelTitle ?? '')) ?? items[0]
                    const id = pick?.id?.videoId
                    if (typeof id === 'string' && /^[\w-]{6,20}$/.test(id)) {
                        await remember('yt', query, id)
                        return id
                    }
                    if (data?.error) console.log(`[music_autoplay] YouTube: ${data.error.message ?? data.error.code}`)
                } catch (error) {
                    console.log(`[music_autoplay] YouTube search failed: ${error}`)
                }
                return null
            })().finally(() => setTimeout(() => ytInFlight.delete(key), 60000)))
        }
        return ytInFlight.get(key)
    }

    // The mark of the reply being written (in memory only: none after a reload).
    let armMark = ''
    const announced = new Set()

    // The main document, asked for once (the app asks the user the first time).
    let rootDoc
    async function stopOtherPlayers(keepMark) {
        const doc = rootDoc === undefined ? (rootDoc = await risuai.getRootDocument()) : rootDoc
        if (!doc) return
        // The app scopes a message's class names with x-risu- (RisuAI does the same).
        const cards = await doc.querySelectorAll('.pr-music-live, .x-risu-pr-music-live')
        const length = await cards.length()
        for (let i = 0; i < length; i++) {
            const card = await cards.at(i)
            if (!card) continue
            const className = await card.getClassName()
            if (!className.includes(`pr-music-n-${keepMark}`)) {
                const frame = await card.querySelector('iframe')
                if (frame) { await frame.remove(); frame.release() }
            }
            card.release()
        }
        cards.release()
    }

    function card(inner, extraClass = '') {
        return `<div class="pr-music-card ${extraClass}" style="margin:8px 0;padding:8px;border-radius:10px;border:1px solid rgba(127,127,127,.35);max-width:380px">${inner}</div>`
    }
    const title = (query) => `<div style="font-size:13px;opacity:.85;margin-top:4px">🎵 ${escapeHtml(normalize(query))}</div>`
    const link = (href, label) => `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`
    const ytMusicSearch = (query) => `https://music.youtube.com/search?q=${encodeURIComponent(normalize(query))}`

    async function youtubeCard(query, mark) {
        const live = !!mark && mark === armMark
        const id = await youtubeVideo(query)
        if (!id) return card(title(query) + `<div style="font-size:12px">${link(ytMusicSearch(query), '유튜브 뮤직에서 찾기')}</div>`)
        if (live && !announced.has(mark)) {
            announced.add(mark)
            setTimeout(() => { void stopOtherPlayers(mark) }, 300)
        }
        const autoplay = live ? '&autoplay=1' : ''
        const src = `https://www.youtube.com/embed/${id}?rel=0&playsinline=1${autoplay}`
        return card(
            `<iframe src="${src}" allow="autoplay; encrypted-media; picture-in-picture" allowfullscreen frameborder="0" style="width:100%;aspect-ratio:16/9;border-radius:8px"></iframe>` + title(query),
            `pr-music-live pr-music-n-${live ? mark : 'old'}`,
        )
    }

    // ---------- Spotify ----------
    let localStore = null
    const store = async () => (localStore ??= await risuai.getLocalPluginStorage())

    const base64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

    async function spotifyToken() {
        const s = await store()
        const auth = await s.getItem('spotify_auth')
        if (!auth?.refresh_token) return null
        if (auth.access_token && auth.expires_at > Date.now() + 30000) return auth.access_token
        const clientId = await arg('spotify_client_id')
        if (!clientId) return null
        const res = await risuai.nativeFetch('https://accounts.spotify.com/api/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: auth.refresh_token, client_id: clientId }).toString(),
        })
        const data = await res.json()
        if (!data?.access_token) {
            console.log(`[music_autoplay] Spotify refresh failed: ${data?.error_description ?? data?.error ?? res.status}`)
            return null
        }
        await s.setItem('spotify_auth', {
            access_token: data.access_token,
            refresh_token: data.refresh_token ?? auth.refresh_token,
            expires_at: Date.now() + (Number(data.expires_in) || 3600) * 1000,
        })
        return data.access_token
    }

    async function spotifyApi(path, options = {}) {
        const token = await spotifyToken()
        if (!token) throw new Error('스포티파이가 연결되어 있지 않습니다.')
        return await risuai.nativeFetch(`https://api.spotify.com/v1${path}`, {
            ...options,
            headers: { Authorization: `Bearer ${token}`, ...(options.body ? { 'Content-Type': 'application/json' } : {}) },
        })
    }

    async function spotifyTrack(query) {
        const hit = await cached('sp', query)
        if (hit) return hit
        const res = await spotifyApi(`/search?${new URLSearchParams({ q: normalize(query), type: 'track', limit: '1' })}`)
        const uri = (await res.json())?.tracks?.items?.[0]?.uri
        if (typeof uri === 'string' && uri.startsWith('spotify:track:')) {
            await remember('sp', query, uri)
            return uri
        }
        return null
    }

    async function spotifyPlay(query) {
        try {
            const uri = await spotifyTrack(query)
            if (!uri) { console.log(`[music_autoplay] Spotify: no track for "${query}"`); return }
            const body = JSON.stringify({ uris: [uri] })
            let res = await spotifyApi('/me/player/play', { method: 'PUT', body })
            if (res.status === 404) {
                // No active device: start on the first one Spotify knows.
                const devices = (await (await spotifyApi('/me/player/devices')).json())?.devices ?? []
                if (devices.length === 0) { console.log('[music_autoplay] Spotify: open the Spotify app on a device first'); return }
                res = await spotifyApi(`/me/player/play?device_id=${encodeURIComponent(devices[0].id)}`, { method: 'PUT', body })
            }
            if (res.status >= 300) console.log(`[music_autoplay] Spotify play: ${res.status}`)
        } catch (error) {
            console.log(`[music_autoplay] Spotify: ${error?.message ?? error}`)
        }
    }

    // ---------- the cards ----------
    await risuai.addRisuScriptHandler('display', async (content) => {
        if (!content || !content.includes('<music>')) return null
        const mode = await platform()
        const matches = [...content.matchAll(TAG)]
        if (matches.length === 0) return null
        const parts = await Promise.all(matches.map(async ([, query, mark]) => {
            if (!normalize(query)) return ''
            if (mode === 'off') return title(query)
            if (mode === 'youtube') return await youtubeCard(query, mark)
            if (mode === 'spotify') return card(title(query) + `<div style="font-size:12px">스포티파이에서 재생 · ${link(`https://open.spotify.com/search/${encodeURIComponent(normalize(query))}`, '열기')}</div>`)
            return card(title(query) + `<div style="font-size:12px">${link(`https://www.melon.com/search/total/index.htm?q=${encodeURIComponent(normalize(query))}`, '멜론에서 찾기')}</div>`)
        }))
        let i = 0
        return content.replace(TAG, () => parts[i++] ?? '')
    })

    // The reply being written marks its songs, for the YouTube autoplay.
    await risuai.addRisuScriptHandler('output', (content) => {
        if (!armMark || !content || !content.includes('<music>')) return null
        return content.replace(TAG, (whole, query, mark) => mark ? whole : `<music>${query}|${armMark}</music>`)
    })

    await risuai.registerSetting('음악 자동 재생', openSettings, '🎵', 'html', 'music-autoplay-settings')

    // The two below wait for the user's permission to change the chat (asked
    // once); everything above works without it.

    // A reply is being requested: a new mark, and the instruction to name songs.
    await risuai.addRisuReplacer('beforeRequest', async (messages, type) => {
        if (type !== 'model') return messages
        const mode = await platform()
        if (mode === 'off') return messages
        armMark = Math.random().toString(36).slice(2, 10)
        if ((await arg('add_instruction')) === 'off') return messages
        return [...messages, { role: 'system', content: INSTRUCTION }]
    })

    // A reply is done: Spotify plays its last song.
    await risuai.addRisuChatListener('output', async ({ chat, messageIndex }) => {
        if ((await platform()) !== 'spotify') return
        const text = chat?.message?.[messageIndex]?.data ?? ''
        const last = [...String(text).matchAll(TAG)].at(-1)?.[1]
        if (last && normalize(last)) void spotifyPlay(last)
    })

    // ---------- settings: Spotify sign-in, YouTube check ----------
    async function openSettings() {
        const s = await store()
        const connected = !!(await s.getItem('spotify_auth'))?.refresh_token
        document.body.innerHTML = `
<style>
  body { margin:0; font-family:system-ui,sans-serif; background:#1e1f24; color:#e8e8ea; }
  .wrap { max-width:560px; margin:0 auto; padding:16px; box-sizing:border-box; }
  h2 { font-size:18px; margin:8px 0 12px; } h3 { font-size:15px; margin:20px 0 8px; }
  p, li { font-size:13px; line-height:1.5; color:#b9bac2; }
  textarea, input { width:100%; box-sizing:border-box; background:#2a2b31; color:#e8e8ea; border:1px solid #44464f; border-radius:6px; padding:8px; font-size:13px; }
  button { background:#3b3d46; color:#e8e8ea; border:1px solid #55575f; border-radius:6px; padding:8px 12px; font-size:13px; margin:6px 6px 0 0; }
  .ok { color:#6ee7a0; } .bad { color:#f87171; } code { color:#e8e8ea; }
</style>
<div class="wrap">
  <h2>음악 자동 재생</h2>
  <p>재생 플랫폼, 유튜브 API 키, 스포티파이 Client ID는 설정 → 플러그인에서 고칩니다.</p>

  <h3>스포티파이 연결 <span id="sp-state" class="${connected ? 'ok' : 'bad'}">${connected ? '연결됨' : '연결 안 됨'}</span></h3>
  <ol>
    <li>스포티파이 개발자 사이트(developer.spotify.com)에서 앱을 만들고, Redirect URI에 <code>${SPOTIFY_REDIRECT}</code>를 넣습니다. 받은 Client ID를 플러그인 설정에 넣습니다.</li>
    <li>아래 "로그인 주소 만들기"를 누르고, 나온 주소를 새 탭에서 엽니다.</li>
    <li>로그인 후 넘어간 페이지는 열리지 않아도 됩니다. 그 페이지의 주소 전체를 복사해 아래 칸에 붙여 넣고 "연결"을 누릅니다.</li>
  </ol>
  <button id="sp-make">로그인 주소 만들기</button>
  <textarea id="sp-url" rows="3" readonly placeholder="여기에 로그인 주소가 나옵니다"></textarea>
  <input id="sp-back" placeholder="${SPOTIFY_REDIRECT}?code=... 주소를 붙여 넣기">
  <button id="sp-connect">연결</button> <button id="sp-test">시험 재생</button> <button id="sp-forget">연결 끊기</button>
  <p id="sp-msg"></p>

  <h3>유튜브 검색 시험</h3>
  <input id="yt-q" placeholder="아티스트 - 제목">
  <button id="yt-test">검색</button>
  <p id="yt-msg"></p>

  <button id="close">닫기</button>
</div>`
        const $ = (id) => document.getElementById(id)
        const say = (id, text, ok) => { $(id).textContent = text; $(id).className = ok ? 'ok' : 'bad' }

        $('sp-make').onclick = async () => {
            const clientId = await arg('spotify_client_id')
            if (!clientId) { say('sp-msg', '플러그인 설정에 스포티파이 Client ID를 먼저 넣어 주세요.', false); return }
            const verifier = base64url(await risuai.getSecureRandomBytes(64))
            const challenge = base64url(await risuai.getCryptoDigest('SHA-256', new TextEncoder().encode(verifier)))
            const state = base64url(await risuai.getSecureRandomBytes(16))
            await s.setItem('spotify_pkce', { verifier, state })
            $('sp-url').value = 'https://accounts.spotify.com/authorize?' + new URLSearchParams({
                client_id: clientId, response_type: 'code', redirect_uri: SPOTIFY_REDIRECT,
                code_challenge_method: 'S256', code_challenge: challenge, scope: SPOTIFY_SCOPES, state,
            })
            $('sp-url').select()
            say('sp-msg', '주소를 복사해 새 탭에서 여세요.', true)
        }
        $('sp-connect').onclick = async () => {
            try {
                const back = new URL($('sp-back').value.trim())
                const pkce = await s.getItem('spotify_pkce')
                if (!pkce || back.searchParams.get('state') !== pkce.state) throw new Error('로그인 주소를 다시 만들어 주세요.')
                const code = back.searchParams.get('code')
                if (!code) throw new Error(back.searchParams.get('error') ?? '주소에 code가 없습니다.')
                const res = await risuai.nativeFetch('https://accounts.spotify.com/api/token', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: new URLSearchParams({
                        grant_type: 'authorization_code', code, redirect_uri: SPOTIFY_REDIRECT,
                        client_id: await arg('spotify_client_id'), code_verifier: pkce.verifier,
                    }).toString(),
                })
                const data = await res.json()
                if (!data?.refresh_token) throw new Error(data?.error_description ?? data?.error ?? `HTTP ${res.status}`)
                await s.setItem('spotify_auth', {
                    access_token: data.access_token, refresh_token: data.refresh_token,
                    expires_at: Date.now() + (Number(data.expires_in) || 3600) * 1000,
                })
                await s.removeItem('spotify_pkce')
                say('sp-state', '연결됨', true)
                say('sp-msg', '연결했습니다.', true)
            } catch (error) {
                say('sp-msg', `연결하지 못했습니다: ${error?.message ?? error}`, false)
            }
        }
        $('sp-test').onclick = async () => {
            say('sp-msg', '재생을 요청했습니다. 스포티파이 앱을 확인해 보세요.', true)
            await spotifyPlay('Queen - Bohemian Rhapsody')
        }
        $('sp-forget').onclick = async () => {
            await s.removeItem('spotify_auth')
            say('sp-state', '연결 안 됨', false)
            say('sp-msg', '이 기기의 스포티파이 연결을 지웠습니다.', true)
        }
        $('yt-test').onclick = async () => {
            const q = $('yt-q').value.trim()
            if (!q) return
            if (!(await arg('youtube_api_key'))) { say('yt-msg', '플러그인 설정에 유튜브 API 키를 먼저 넣어 주세요.', false); return }
            const id = await youtubeVideo(q)
            say('yt-msg', id ? `찾았습니다: https://www.youtube.com/watch?v=${id}` : '찾지 못했습니다. API 키와 할당량을 확인해 주세요.', !!id)
        }
        $('close').onclick = () => risuai.hideContainer()
        await risuai.showContainer('fullscreen')
    }

})()
