// ============================================================
// WEB TRAFFIC HANDLER
// Modes: STANDARD, SAAS, NEWS, API, REALTIME
// Smart caching with SWR, auth-aware bypass, device/language variants
// ============================================================

async function handleWebTraffic(request, env, config, ctx, url) {
    const isWrite = ["POST", "PUT", "DELETE", "PATCH"].includes(request.method);
    const isApiMode = config.mode === "API" || config.mode === "REALTIME";

    // 1. Authentication Check
    const cookies = request.headers.get("Cookie") || "";
    const authHeader = request.headers.get("Authorization") || "";
    const isAuthenticated =
        /session|cart|logged_in|auth_token|user_id|SESS/i.test(cookies) ||
        /Bearer|Basic|Token|OAuth/i.test(authHeader);

    // 2. Cache Decision
    let shouldCache = !isWrite;
    const isAggressive = ["ECOMMERCE", "STANDARD", "IOT"].includes(config.mode);

    if (isAggressive) {
        shouldCache = isAuthenticated ? false : true;
    } else {
        const bypassHeaders =
            (request.headers.get("Cache-Control") || "").includes("no-cache") ||
            (request.headers.get("Pragma") || "") === "no-cache";
        shouldCache = !isAuthenticated && !bypassHeaders;
    }

    // Hard disqualifiers
    if (isApiMode || url.pathname.includes("/api/") || url.pathname.includes("/checkout/")) {
        shouldCache = false;
    }

    // 3. Cache Match
    const cache = caches.default;
    const cacheKey = new Request(url.toString(), {
        headers: request.headers,
        method: "GET", // Method normalization
    });

    if (shouldCache) {
        let cached = await cache.match(cacheKey);
        if (cached) {
            const age = parseInt(cached.headers.get("X-Shield-Age") || "0");
            if (Date.now() - age < 3600000) return addShieldHeader(cached, "HIT");

            // Stale-while-revalidate
            const ttl = config.cache_ttl || 3600;
            ctx.waitUntil(refreshCache(request, env, cacheKey, ttl));
            return addShieldHeader(cached, "SWR");
        }
    }

    // 4. Fetch from Origin
    const canOptimize = ["pro", "business", "enterprise"].includes(
        (config.cloudflare_plan || "free").toLowerCase()
    );
    const response = await fetchFromOrigin(request, env, url, request.method, canOptimize && isAggressive);

    // 5. Origin Guard & Store
    const originForbids = (response.headers.get("Cache-Control") || "").includes("no-store");
    if (shouldCache && originForbids && !isAggressive) shouldCache = false;

    const status = shouldCache ? "MISS" : "BYPASS";
    const finalResponse = addShieldHeader(response, status);

    if (shouldCache && response.status === 200) {
        ctx.waitUntil(saveToCache(cache, cacheKey, finalResponse.clone(), config.cache_ttl || 3600));
    }

    return finalResponse;
}
