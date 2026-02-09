// ============================================================
// 6. UTILITIES (Stealth, Fetch, Logic Helpers)
// ============================================================

async function fetchFromOrigin(request, env, url, method, optimize) {
    const origin = env.ORIGIN_HOSTNAME || "__ORIGIN__";
    const target = new URL(url.toString());
    target.hostname = origin;
    
    const headers = new Headers(request.headers);
    headers.delete("Host");

    let cfOptions = {};
    if (optimize) {
        cfOptions = { minify: { javascript: true, css: true }, polish: "lossy" };
        if (/\.(jpg|png|webp|avif)$/i.test(url.pathname)) cfOptions.image = { quality: 85, fit: "scale-down" };
    }

    try {
        return await fetch(target.toString(), { 
            method, 
            headers, 
            body: (method === "GET" || method === "HEAD") ? null : request.body, 
            redirect: "follow", 
            cf: cfOptions 
        });
    } catch (e) { return new Response("Origin Error", { status: 502 }); }
}

async function saveToCache(cache, key, response, ttl) {
    // Clone headers to avoid mutation issues if response is reused
    const headers = new Headers(response.headers);
    headers.set("Cache-Control", `public, s-maxage=${ttl}, max-age=${ttl}`);
    headers.set("X-Shield-Age", Date.now().toString());
    headers.delete("Pragma");
    headers.delete("Expires");
    
    // We must clone the response body to save it
    const responseToCache = new Response(response.clone().body, {
        status: response.status,
        statusText: response.statusText,
        headers: headers
    });
    
    await cache.put(key, responseToCache);
}

async function refreshCache(req, env, key, ttl) {
    try {
        const url = new URL(req.url);
        const res = await fetchFromOrigin(req, env, url, "GET", true);
        if (res.status === 200) {
            const fortified = addShieldHeader(res, "REFRESH");
            await saveToCache(caches.default, key, fortified, ttl);
        }
    } catch (e) {
        console.error("Refresh failed", e);
    }
}

function addShieldHeader(res, status) {
    const newRes = new Response(res.body, res);
    newRes.headers.set("X-Shield-Status", status);
    return newRes;
}

function fortifyResponse(res, config, env, url) {
    const newRes = new Response(res.body, res);
    const isApi = config.mode === "API" || url.hostname.includes("api.");
    
    newRes.headers.set("X-Shield-Version", "2.7.0"); // Updated for modular build
    newRes.headers.set("X-Shield-Client-ID", env.CLIENT_ID || "unknown");
    newRes.headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains; preload");
    newRes.headers.set("X-Content-Type-Options", "nosniff");
    newRes.headers.set("X-Frame-Options", "SAMEORIGIN");
    newRes.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
    
    if (!isApi) newRes.headers.set("Content-Security-Policy", "upgrade-insecure-requests");

    const toDelete = ["server", "x-powered-by", "x-aspnet-version", "x-runtime", "x-vignette", "via", "x-origin-server"];
    toDelete.forEach(h => newRes.headers.delete(h));

    if (isApi) {
        newRes.headers.set("Access-Control-Allow-Origin", "*");
        newRes.headers.set("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS,PATCH");
        newRes.headers.set("Access-Control-Allow-Headers", "Content-Type,Authorization,X-API-Key");
    }
    
    return newRes;
}

// Config Loader (Must be defined here for modularity)
async function loadConfig(env) {
    const now = Date.now();
    if (CACHED_CONFIG && (now - LAST_CONFIG_FETCH < CONFIG_TTL_MS)) return CACHED_CONFIG;
    let config = { mode: "STANDARD", cache_ttl: 3600 };
    if (env.CLOUDEDGING_CONFIG) {
        try {
            const stored = await env.CLOUDEDGING_CONFIG.get(`CFG_${env.CLIENT_ID || 'default'}`, { type: "json" });
            if (stored) config = { ...config, ...stored };
        } catch (e) {}
    }
    CACHED_CONFIG = config; LAST_CONFIG_FETCH = now; return config;
}

async function handleWebSocket(request, env) {
    const origin = env.ORIGIN_HOSTNAME || "__ORIGIN__";
    const targetUrl = new URL(request.url);
    targetUrl.hostname = origin; targetUrl.protocol = 'https:';
    try {
        const originResponse = await fetch(targetUrl.toString(), { headers: request.headers, cf: { cacheTtl: 0 } });
        if (originResponse.status === 101 && originResponse.webSocket) {
            const pair = new WebSocketPair();
            const [client, server] = Object.values(pair);
            const originSocket = originResponse.webSocket;
            originSocket.accept(); server.accept();
            server.addEventListener('message', e => originSocket.send(e.data));
            server.addEventListener('close', () => originSocket.close());
            originSocket.addEventListener('message', e => server.send(e.data));
            originSocket.addEventListener('close', () => server.close());
            return new Response(null, { status: 101, webSocket: client });
        }
        return originResponse;
    } catch (e) { return new Response("WS Failed", { status: 502 }); }
}

async function incrementRateLimit(env, key, current) { 
    try { await env.CLOUDEDGING_CACHE.put(key, (current + 1).toString(), { expirationTtl: 60 }); } catch (e) {} 
}