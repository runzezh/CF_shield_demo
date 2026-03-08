// ============================================================
// WEB TRAFFIC HANDLER
// Modes: STANDARD, SAAS, NEWS, API, REALTIME
// Smart caching with SWR, auth-aware bypass, device/language variants
// Plan-aware physics: cache TTL, SWR window, and optimisation level
// scale automatically based on customer's Cloudflare plan tier.
// ============================================================

// ── Plan Physics Profile ─────────────────────────────────────
// Each tier unlocks progressively better cache behaviour.
// These are Shield-controlled settings only — CF zone features
// like Polish and Mirage are noted but must be enabled by the
// customer in their CF dashboard (we surface them as recommendations).
const PLAN_PHYSICS = {
    free: {
        cache_ttl_multiplier: 1.0,    // Base TTL from config
        swr_window_ms: 3_600_000,     // 1h SWR window
        aggressive_cache: false,       // Conservative — honour no-cache headers
        vary_on_device: false,         // No device-based cache variants
        rate_limit_default: 100,       // 100 req/min per IP
        // CF zone features available (customer must enable in dashboard):
        // polish: false, mirage: false, waf_managed: false, bot_management: false
    },
    pro: {
        cache_ttl_multiplier: 1.5,    // 50% longer TTLs
        swr_window_ms: 7_200_000,     // 2h SWR window
        aggressive_cache: true,        // Override no-cache on static assets
        vary_on_device: true,          // Separate cache per device type
        rate_limit_default: 200,       // 200 req/min per IP
        // CF zone features available: polish, mirage, waf_managed_rules
    },
    business: {
        cache_ttl_multiplier: 2.0,    // 2x TTLs
        swr_window_ms: 14_400_000,    // 4h SWR window
        aggressive_cache: true,
        vary_on_device: true,
        rate_limit_default: 500,       // 500 req/min per IP
        // CF zone features available: polish, mirage, waf_managed, bot_management, cache_analytics
    },
    enterprise: {
        cache_ttl_multiplier: 3.0,    // 3x TTLs
        swr_window_ms: 28_800_000,    // 8h SWR window
        aggressive_cache: true,
        vary_on_device: true,
        rate_limit_default: 1000,      // 1000 req/min per IP
        // CF zone features available: all + custom SSL, dedicated IPs, SLA
    },
};

function getPlanPhysics(config) {
    const plan = (config.cloudflare_plan || "free").toLowerCase();
    return PLAN_PHYSICS[plan] || PLAN_PHYSICS["free"];
}

async function handleWebTraffic(request, env, config, ctx, url) {
    const isWrite = ["POST", "PUT", "DELETE", "PATCH"].includes(request.method);
    const isApiMode = config.mode === "API" || config.mode === "REALTIME";
    const physics = getPlanPhysics(config);

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
        // Pro+ can override no-cache on static assets for better hit rates
        const isStatic = /\.(css|js|woff2?|ttf|otf|eot|svg|ico)$/i.test(url.pathname);
        shouldCache = !isAuthenticated && (!bypassHeaders || (physics.aggressive_cache && isStatic));
    }

    // Hard disqualifiers
    if (isApiMode || url.pathname.includes("/api/") || url.pathname.includes("/checkout/")) {
        shouldCache = false;
    }

    // 3. Effective TTL — scaled by plan physics
    const baseTtl = config.cache_ttl || 3600;
    const effectiveTtl = Math.round(baseTtl * physics.cache_ttl_multiplier);

    // 4. Cache Match
    const cache = caches.default;

    // Pro+ varies cache by device type for better mobile/desktop hit rates
    const deviceType = physics.vary_on_device
        ? (/Mobile|Android|iPhone/i.test(request.headers.get("User-Agent") || "") ? "mobile" : "desktop")
        : "all";
    const cacheKey = new Request(`${url.toString()}__device=${deviceType}`, {
        method: "GET",
    });

    if (shouldCache) {
        let cached = await cache.match(cacheKey);
        if (cached) {
            const age = parseInt(cached.headers.get("X-Shield-Age") || "0");
            const hitWindow = effectiveTtl * 1000;
            if (Date.now() - age < hitWindow) return addShieldHeader(cached, "HIT");

            // Stale-while-revalidate — window scales with plan
            ctx.waitUntil(refreshCache(request, env, cacheKey, effectiveTtl));
            return addShieldHeader(cached, "SWR");
        }
    }

    // 5. Fetch from Origin
    const response = await fetchFromOrigin(
        request, env, url, request.method,
        physics.aggressive_cache && isAggressive
    );

    // 6. Origin Guard & Store
    const originForbids = (response.headers.get("Cache-Control") || "").includes("no-store");
    if (shouldCache && originForbids && !physics.aggressive_cache) shouldCache = false;

    const status = shouldCache ? "MISS" : "BYPASS";
    const finalResponse = addShieldHeader(response, status);

    if (shouldCache && response.status === 200) {
        ctx.waitUntil(saveToCache(cache, cacheKey, finalResponse.clone(), effectiveTtl));
    }

    return finalResponse;
}
