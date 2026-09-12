// @ts-nocheck

self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url)
    const path = url.pathname.split('/')
    if(path[1] === 'sw'){
        try {
            switch (path[2]){
                case "check":{
                    let targetUrl = url
                    const headers = event.request.headers
                    const headerUrl = headers.get('x-register-url')
                    if(headerUrl){
                        targetUrl.pathname = decodeURIComponent(headerUrl)
                    }
                    event.respondWith(checkCache(targetUrl))
                    break
                }
                case "img": {
                    event.respondWith(getSource(url))
                    break
                }
                case "register": {
                    let targetUrl = url
                    const headers = event.request.headers
                    const headerUrl = headers.get('x-register-url')
                    if(headerUrl){
                        targetUrl.pathname = decodeURIComponent(headerUrl)
                    }
                    const noContentType = headers.get('x-no-content-type') === 'true'
                    event.respondWith(
                        registerCache(targetUrl, event.request.arrayBuffer(), noContentType)
                    )
                    break
                }
                case "init":{
                    event.respondWith(new Response("v2"))
                    break
                }
                case 'share':{
                    if(path[3] === 'payload'){
                        event.respondWith(readShareCache(url))
                    }
                    else if(path[3] === 'consume'){
                        event.respondWith(consumeSharePayload())
                    }
                    else if(path[3] === 'file'){
                        event.respondWith(readShareCache(url))
                    }
                    else if(event.request.method === 'POST'){
                        event.respondWith(receiveSharedPayload(event.request))
                    }
                    else{
                        event.respondWith(new Response('Share target expects POST', { status: 405 }))
                    }
                    break
                }
                default: {
                    event.respondWith(new Response(
                        path[2]
                    ))
                }
            }
        } catch (error) {
            event.respondWith(new Response(`${error}`))
        }
    }
    if(path[1] === 'tf'){{
        event.respondWith(new Response("Cannot find resource from cache", {
            status: 404
        }))
    }}
})


async function checkCache(url){
    const cache = await caches.open('risuCache')

    if(url.pathname.startsWith("/sw/check")) {
        url.pathname = "/sw/img" + url.pathname.slice(9);
        return new Response(JSON.stringify({
            "able": !!(await cache.match(url))
        }))
    }

    return new Response(JSON.stringify({
        "able": !!(await cache.match(url))
    }))
}

async function getSource(url){
    const cache = await caches.open('risuCache')
    return await cache.match(url) || new Response('Cannot find resource from cache', { status: 404 })
}

function shareCacheUrl(pathname){
    return new URL(pathname, self.location.origin)
}

async function readShareCache(url){
    const cache = await caches.open('risuShareTarget')
    return await cache.match(url) || new Response('Shared payload not found', { status: 404 })
}

async function clearPreviousSharePayload(cache){
    const payloadUrl = shareCacheUrl('/sw/share/payload')
    const previous = await cache.match(payloadUrl)
    if(previous){
        try {
            const metadata = await previous.json()
            for(const file of metadata.files || []){
                if(typeof file?.url === 'string' && file.url.startsWith('/sw/share/file/')){
                    await cache.delete(shareCacheUrl(file.url))
                }
            }
        } catch { /* malformed old payload; replacing the manifest entry is enough */ }
    }
    await cache.delete(payloadUrl)
}

function sharedFileKind(name, type){
    const lowerName = String(name || '').toLowerCase()
    const lowerType = String(type || '').toLowerCase()
    if(lowerName.endsWith('.risum') || lowerName.endsWith('.lorebook')) return 'module'
    if(lowerName.endsWith('.risup') || lowerName.endsWith('.risupreset')) return 'preset'
    if(lowerName.endsWith('.charx') || lowerName.endsWith('.png') || lowerName.endsWith('.jpg') || lowerName.endsWith('.jpeg') || lowerName.endsWith('.json')) return 'character'
    if(lowerType.startsWith('image/')) return 'character'
    return null
}

async function receiveSharedPayload(request){
    try {
        const formData = await request.formData()
        const cache = await caches.open('risuShareTarget')
        await clearPreviousSharePayload(cache)

        // `files` is the current single-field manifest. The legacy names keep
        // already installed manifests usable while their service worker updates.
        const candidates = [
            ...formData.getAll('files'),
            ...formData.getAll('character'),
            ...formData.getAll('preset'),
            ...formData.getAll('module'),
        ].filter((value) => value && typeof value.arrayBuffer === 'function')
        const nonce = `${Date.now()}-${Math.random().toString(36).slice(2)}`
        const files = []

        for(let index = 0; index < candidates.length; index++){
            const file = candidates[index]
            const kind = sharedFileKind(file.name, file.type)
            if(!kind) continue
            const fileUrl = `/sw/share/file/${nonce}/${files.length}`
            await cache.put(shareCacheUrl(fileUrl), new Response(file, {
                headers: {
                    'cache-control': 'no-store',
                    'content-type': file.type || 'application/octet-stream',
                },
            }))
            files.push({
                url: fileUrl,
                name: file.name || `shared-${files.length}`,
                type: file.type || '',
                size: Number(file.size) || 0,
                kind,
            })
        }

        const payload = {
            version: 1,
            title: String(formData.get('title') || ''),
            text: String(formData.get('text') || ''),
            url: String(formData.get('url') || ''),
            files,
        }
        await cache.put(shareCacheUrl('/sw/share/payload'), new Response(JSON.stringify(payload), {
            headers: {
                'cache-control': 'no-store',
                'content-type': 'application/json; charset=utf-8',
            },
        }))
        return Response.redirect('/#share_payload', 303)
    } catch(error){
        return new Response(`Share target failed: ${error}`, { status: 400 })
    }
}

async function consumeSharePayload(){
    const cache = await caches.open('risuShareTarget')
    await clearPreviousSharePayload(cache)
    return new Response(JSON.stringify({ done: true }), {
        headers: { 'content-type': 'application/json' },
    })
}

async function registerCache(urlr, buffer, noContentType = false){
    const cache = await caches.open('risuCache')
    const url = new URL(urlr, self.location.origin)
    if(!noContentType){
        let path = url.pathname.split('/')
        path[2] = 'img'
        url.pathname = path.join('/')
    }
    const buf = new Uint8Array(await buffer)
    let headers = {
        "cache-control": "max-age=604800",
        "content-type": "image/png"
    }
    if(noContentType){
        delete headers["content-type"]
    }
    await cache.put(url, new Response(buf, {
        headers
    }))
    return new Response(JSON.stringify({
        "done": true
    }))
}
