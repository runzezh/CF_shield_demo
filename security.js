async function runSecurityPipeline(request, env, config, url) {
    const ip = request.headers.get("CF-Connecting-IP");
    const country = request.cf?.country || "XX";

    // A. CORS Preflight (Updated for AI)
    const isApiPath = /\/(api|v1|v2|v3|graphql|rest|models|chat|embeddings)/.test(url.pathname);
    if (request.method === "OPTIONS" && (config.mode === "API" || isApiPath)) {
        return new Response(null, { 
            status: 204, 
            headers: { 
                "Access-Control-Allow-Origin": "*", 
                "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS,PATCH",
                "Access-Control-Allow-Headers": "Content-Type,Authorization,X-API-Key",
                "Access-Control-Max-Age": "86400"
            } 
        });
    }

    // B. GEO-BORDER
    if (config.blocked_countries?.length > 0 && config.blocked_countries.includes(country)) {
        return new Response(JSON.stringify({ error: "Forbidden", country }), { status: 451 });
    }

    // C. RATE LIMITING
    if (env.CLOUDEDGING_CACHE && config.rate_limit_enabled) {
        const limitKey = `RL_${env.CLIENT_ID}_${ip}`;
        try {
            const currentValue = await env.CLOUDEDGING_CACHE.get(limitKey);
            const currentCount = parseInt(currentValue || "0");
            if (currentCount >= config.rate_limit_threshold) return new Response("Rate limit exceeded.", { status: 429 });
            ctx.waitUntil(incrementRateLimit(env, limitKey, currentCount));
        } catch (e) {}
    }

    // D. PURGE COMMAND
    if (request.headers.get("X-CloudEdging-Command") === "PURGE") {
        const purgeToken = request.headers.get("X-CloudEdging-Purge-Token");
        if (purgeToken !== (config.purge_secret || env.PURGE_SECRET)) return new Response("Forbidden", { status: 403 });
        try { await caches.default.delete(request.url); return new Response("Cache Purged", { status: 200 }); } catch (e) { return new Response("Purge Failed", { status: 500 }); }
    }

    // E. WAF (Decoded Scan)
    const searchString = decodeURIComponent(url.search);
    if (url.search || url.pathname.includes('..')) {
        const suspicious = [/<script>/i, /UNION SELECT/i, /OR 1=1/i, /\.\./];
        if (suspicious.some(p => p.test(searchString + url.pathname))) {
            return new Response("Forbidden", { status: 403 });
        }
    }

    return null;
}