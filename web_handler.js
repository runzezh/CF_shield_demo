async function handleWebTraffic(request, env, config, ctx, url) {
    const isWrite = ["POST", "PUT", "DELETE", "PATCH"].includes(request.method);
    const isApiMode = config.mode === "API" || config.mode === "REALTIME";
    
    // 1. Auth Check
    const cookies = request.headers.get("Cookie") || "";
    const authHeader = request.headers.get("Authorization") || "";
    const isAuthenticated = /session|cart|logged_in|auth_token|user_id|SESS/i.test(cookies) || /Bearer|Basic|Token|OAuth/i.test(authHeader);

    // 2. Cache Decision
    let shouldCache = !isWrite;
    const isAggressive = ["ECOMMERCE", "STANDARD", "IOT"].includes(config.mode);
    
    if (isAggressive) {
        shouldCache = isAuthenticated ? false : true;
    } else {
        const bypassHeaders = (request.headers.get("Cache-Control") || "").includes("no-cache") || (request.headers.get("Pragma") || "") === "no-cache";
        shouldCache = !isAuthenticated && !bypassHeaders;
    }

    if (isApiMode || url.pathname.includes("/api/") || url.pathname.includes("/checkout/")) shouldCache = false;

    // 3. Cache Match
    const cache = caches.default;
    const deviceType = request.cf?.deviceType || "desktop";
    const language = (request.headers.get("Accept-Language") || "en").split(",")[0].split("-")[0].toLowerCase().substring(0, 2);
    
    const cacheKey = new Request(url.toString(), {
        headers: request.headers,
        method: "GET" 
    });

    if (shouldCache) {
        let cached = await cache.match(cacheKey);
        if (cached) {
            const age = parseInt(cached.headers.get("X-Shield-Age") || "0");
            if ((Date.now() - age) < 3600000) return addShieldHeader(cached, "HIT");
            const ttl = config.cache_ttl || 3600;
            ctx.waitUntil(refreshCache(request, env, cacheKey, ttl));
            return addShieldHeader(cached, "SWR");
        }
    }

    // 4. Fetch
    const canOptimize = ["pro", "business", "enterprise"].includes(config.cloudflare_plan.toLowerCase());
    const response = await fetchFromOrigin(request, env, url, request.method, canOptimize && isAggressive);

    // 5. Store
    const originForbids = (response.headers.get("Cache-Control") || "").includes("no-store");
    if (shouldCache && originForbids && !isAggressive) shouldCache = false;

    const status = shouldCache ? "MISS" : "BYPASS";
    const finalResponse = addShieldHeader(response, status);

    if (shouldCache && response.status === 200) {
        ctx.waitUntil(saveToCache(cache, cacheKey, finalResponse.clone(), config.cache_ttl || 3600));
    }

    return finalResponse;
}