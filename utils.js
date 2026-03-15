// ============================================================
// UTILITIES — Fetch, Cache, Fortify, Config, WebSocket
// Shared across all handlers
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
        if (/\.(jpg|png|webp|avif)$/i.test(url.pathname)) {
            cfOptions.image = { quality: 85, fit: "scale-down" };
        }
    }

    try {
        return await fetch(target.toString(), {
            method,
            headers,
            body: method === "GET" || method === "HEAD" ? null : request.body,
            // redirect: "manual" — proxy redirects transparently to the browser.
            // "follow" would silently resolve 301/302 inside the Worker, breaking:
            //   - Login redirect flows (/account → 302 /login)
            //   - Payment callbacks (/checkout/complete → 302 /thank-you)
            //   - SEO redirects (www → non-www)
            //   - Any flow where the browser must handle the redirect itself
            // A transparent proxy must never decide redirects on the client's behalf.
            redirect: "manual",
            cf: cfOptions,
        });
    } catch (e) {
        return new Response("Origin Error", { status: 502 });
    }
}

async function saveToCache(cache, key, response, ttl) {
    const headers = new Headers(response.headers);
    headers.set("Cache-Control", `public, s-maxage=${ttl}, max-age=${ttl}`);
    headers.set("X-Shield-Age", Date.now().toString());
    headers.delete("Pragma");
    headers.delete("Expires");

    const responseToCache = new Response(response.clone().body, {
        status: response.status,
        statusText: response.statusText,
        headers: headers,
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

function fortifyResponse(res, config, env, url, req) {
    const newRes = new Response(res.body, res);
    const isApi = config.mode === "API" || config.mode === "AI_INFERENCE" || url.hostname.includes("api.");

    newRes.headers.set("X-Shield-Version", "3.1.0");
    newRes.headers.set("X-Shield-Client-ID", env.CLIENT_ID || "unknown");
    newRes.headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains; preload");
    newRes.headers.set("X-Content-Type-Options", "nosniff");
    newRes.headers.set("X-Frame-Options", "SAMEORIGIN");
    newRes.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");

    if (!isApi) newRes.headers.set("Content-Security-Policy", "upgrade-insecure-requests");

    // Server fingerprint removal
    const toDelete = ["server", "x-powered-by", "x-aspnet-version", "x-runtime", "x-vignette", "via", "x-origin-server"];
    toDelete.forEach((h) => newRes.headers.delete(h));

    if (isApi) {
        // CORS for API/AI_INFERENCE modes.
        // Origin MUST be read from the incoming request (req), not the response (res).
        // Origin servers never send an "Origin" header — browsers send it in requests.
        // res.headers.get("Origin") is always null, causing silent fallback to wildcard.
        // req is passed from core.js fetch() handler as the 5th argument.
        const requestOrigin = req?.headers.get("Origin") || "";
        const allowedOrigins = config.cors_origins || [];

        if (allowedOrigins.length > 0 && requestOrigin) {
            // Specific origins configured — required for credentialed cross-origin calls.
            // Browsers reject Access-Control-Allow-Credentials: true with wildcard origin.
            if (allowedOrigins.includes(requestOrigin) || allowedOrigins.includes("*")) {
                newRes.headers.set("Access-Control-Allow-Origin", requestOrigin);
                newRes.headers.set("Access-Control-Allow-Credentials", "true");
                newRes.headers.set("Vary", "Origin");
            }
        } else {
            // No specific origins configured — wildcard default (public APIs only).
            // Set config.cors_origins in brain_config to enable credentialed cross-origin calls.
            newRes.headers.set("Access-Control-Allow-Origin", "*");
        }
        newRes.headers.set("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS,PATCH");
        newRes.headers.set("Access-Control-Allow-Headers", "Content-Type,Authorization,X-API-Key,anthropic-version");
    }

    return newRes;
}

async function loadConfig(env) {
    const now = Date.now();
    if (CACHED_CONFIG && now - LAST_CONFIG_FETCH < CONFIG_TTL_MS) return CACHED_CONFIG;

    let config = { mode: "STANDARD", cache_ttl: 3600 };
    if (env.CLOUDEDGING_CONFIG) {
        try {
            const stored = await env.CLOUDEDGING_CONFIG.get(`CFG_${env.CLIENT_ID || "default"}`, { type: "json" });
            if (stored) config = { ...config, ...stored };
        } catch (e) {}
    }
    CACHED_CONFIG = config;
    LAST_CONFIG_FETCH = now;
    return config;
}

async function handleWebSocket(request, env) {
    const origin = env.ORIGIN_HOSTNAME || "__ORIGIN__";
    const targetUrl = new URL(request.url);
    targetUrl.hostname = origin;
    targetUrl.protocol = "https:";

    try {
        const originResponse = await fetch(targetUrl.toString(), {
            headers: request.headers,
            cf: { cacheTtl: 0 },
        });

        if (originResponse.status === 101 && originResponse.webSocket) {
            const pair = new WebSocketPair();
            const [client, server] = Object.values(pair);
            const originSocket = originResponse.webSocket;
            originSocket.accept();
            server.accept();
            server.addEventListener("message", (e) => originSocket.send(e.data));
            server.addEventListener("close", () => originSocket.close());
            server.addEventListener("error", () => originSocket.close());
            originSocket.addEventListener("message", (e) => server.send(e.data));
            originSocket.addEventListener("close", () => server.close());
            originSocket.addEventListener("error", () => server.close());
            return new Response(null, { status: 101, webSocket: client });
        }
        return originResponse;
    } catch (e) {
        return new Response("WS Failed", { status: 502 });
    }
}

async function hashString(str) {
    const encoder = new TextEncoder();
    const data = encoder.encode(str);
    const hashBuffer = await crypto.subtle.digest("SHA-256", data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("").substring(0, 16);
}
