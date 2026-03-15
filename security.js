// ============================================================
// SECURITY PIPELINE — Universal Rules
// WAF-lite, rate limiting, geo-blocking, CORS, purge
// ============================================================

async function runSecurityPipeline(request, env, config, url, ctx) {
    const ip = request.headers.get("CF-Connecting-IP");
    const country = request.cf?.country || "XX";

    // ── HEALTH CHECK ENDPOINT ─────────────────────────────────────────────────
    // Protected by HEALTH_SECRET Worker secret (injected via wrangler secret put).
    // Returns current Worker state for pre-production verification and monitoring.
    // Use: curl -H "X-CloudEdging-Health: {secret}" https://domain.com/__shield/health
    //
    // This endpoint is the primary tool for verifying a deployment before routing
    // real customer traffic through it. Always check this after deploy:
    //   - origin_reachable: false → wrong ORIGIN_HOSTNAME, all requests will 502
    //   - mode: "STANDARD" when expecting "ECOMMERCE" → brain config not pushed
    //   - config_age_ms > 120000 → KV read is failing, Worker running on stale config
    if (url.pathname === "/__shield/health") {
        const providedSecret = request.headers.get("X-CloudEdging-Health");
        if (!env.HEALTH_SECRET || providedSecret !== env.HEALTH_SECRET) {
            // Return 404 not 403 — don't reveal the endpoint exists to scanners
            return new Response("Not Found", { status: 404 });
        }

        // Probe origin reachability
        let originReachable = false;
        let originResponseMs = null;
        try {
            const origin = env.ORIGIN_HOSTNAME || "__ORIGIN__";
            const probeStart = Date.now();
            const probe = await fetch(`https://${origin}/`, {
                method: "HEAD",
                redirect: "manual",
                cf: { cacheTtl: 0 },
                signal: AbortSignal.timeout(10000), // 10s — 3s too short for cold-starting origins (Heroku, Render)
            });
            originResponseMs = Date.now() - probeStart;
            // Any response (including 3xx, 4xx) means origin is reachable
            originReachable = probe.status < 600;
        } catch (e) {
            originReachable = false;
        }

        const configAgeMs = LAST_CONFIG_FETCH > 0 ? Date.now() - LAST_CONFIG_FETCH : null;

        return new Response(JSON.stringify({
            status: "ok",
            version: "3.1.0",
            client_id: env.CLIENT_ID || "unknown",
            mode: config.mode || "STANDARD",
            origin: env.ORIGIN_HOSTNAME || "not_set",
            origin_reachable: originReachable,
            origin_response_ms: originResponseMs,
            cache_enabled: !!(config.cache_ttl),
            rate_limit_enabled: config.rate_limit_enabled || false,
            geo_block_countries: (config.blocked_countries || []).length,
            config_age_ms: configAgeMs,
            config_loaded: !!CACHED_CONFIG,
            kv_bound: !!env.CLOUDEDGING_CONFIG,
            r2_bound: !!env.STORAGE_BUCKET,
            vectorize_bound: !!env.SEMANTIC_DB,
            ai_bound: !!env.AI,
            timestamp: new Date().toISOString(),
        }, null, 2), {
            status: 200,
            headers: {
                "Content-Type": "application/json",
                "Cache-Control": "no-store",
                "X-Shield-Health": "true",
            },
        });
    }

    // A. CORS Preflight (covers AI endpoints too)
    // Must also respect config.cors_origins — a credentialed preflight that gets
    // Access-Control-Allow-Origin: * will cause the browser to block the actual request.
    const isApiPath = /\/(api|v1|v2|v3|graphql|rest|models|chat|embeddings|messages)/.test(url.pathname);
    if (request.method === "OPTIONS" && (config.mode === "API" || config.mode === "AI_INFERENCE" || isApiPath)) {
        const preflightOrigin = request.headers.get("Origin") || "";
        const allowedOrigins = config.cors_origins || [];
        // Default null — only set if origin is explicitly valid.
        // Defaulting to "*" leaks that the API is public to unauthorised origins.
        let corsOriginHeader = null;
        let credentialsHeader = null;

        if (allowedOrigins.length > 0 && preflightOrigin) {
            if (allowedOrigins.includes(preflightOrigin) || allowedOrigins.includes("*")) {
                corsOriginHeader = preflightOrigin;
                credentialsHeader = "true";
            }
            // else: unauthorised origin — corsOriginHeader stays null, no CORS header returned
        } else if (allowedOrigins.length === 0) {
            // No restrictions configured — public API, wildcard is correct
            corsOriginHeader = "*";
        }

        const preflightHeaders = {
            "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS,PATCH",
            "Access-Control-Allow-Headers": "Content-Type,Authorization,X-API-Key,anthropic-version",
            "Access-Control-Max-Age": "86400",
        };
        if (corsOriginHeader) {
            preflightHeaders["Access-Control-Allow-Origin"] = corsOriginHeader;
        }
        if (credentialsHeader) {
            preflightHeaders["Access-Control-Allow-Credentials"] = credentialsHeader;
            preflightHeaders["Vary"] = "Origin";
        }

        return new Response(null, { status: 204, headers: preflightHeaders });
    }

    // B. GEO-BORDER
    if (config.blocked_countries?.length > 0 && config.blocked_countries.includes(country)) {
        return new Response(JSON.stringify({ error: "Forbidden", country }), { status: 451 });
    }

    // C. RATE LIMITING (KV-backed counter, 60s sliding window)
    // ⚠️  APPROXIMATE — not atomic. CF Workers has no atomic KV increment.
    // Concurrent requests from the same IP may all read the same counter value
    // before any write completes, allowing short bursts above the threshold.
    // This is intentional: the overhead of Durable Objects for rate limiting
    // exceeds the value for most Shield use cases. For strict enforcement,
    // customers should enable CF Advanced Rate Limiting (Pro+) which operates
    // at the network layer before the Worker executes.
    // Default threshold scales with CF plan — Pro/Business/Enterprise customers
    // have higher legitimate traffic volumes so we raise the default ceiling.
    if (env.CLOUDEDGING_CACHE && config.rate_limit_enabled) {
        const limitKey = `RL_${env.CLIENT_ID}_${ip}`;
        const planDefaults = { free: 100, pro: 200, business: 500, enterprise: 1000 };
        const plan = (config.cloudflare_plan || "free").toLowerCase();
        const planDefault = planDefaults[plan] || 100;
        const threshold = config.rate_limit_threshold || planDefault;
        try {
            const currentValue = await env.CLOUDEDGING_CACHE.get(limitKey);
            const currentCount = parseInt(currentValue || "0");
            if (currentCount >= threshold) {
                return new Response(
                    JSON.stringify({ error: "Rate limit exceeded", retry_after: 60 }),
                    {
                        status: 429,
                        headers: {
                            "Content-Type": "application/json",
                            "Retry-After": "60",
                            "X-Shield-RateLimit-Approximate": "true", // signals approximate enforcement
                        },
                    }
                );
            }
            ctx.waitUntil(incrementRateLimit(env, limitKey, currentCount));
        } catch (e) {
            // Rate limit check failed — fail open (availability > strict enforcement)
        }
    }

    // D. PURGE COMMAND
    // PURGE_SECRET is a Worker secret (injected via wrangler secret put) — never stored in KV.
    if (request.headers.get("X-CloudEdging-Command") === "PURGE") {
        const purgeToken = request.headers.get("X-CloudEdging-Purge-Token");
        if (!env.PURGE_SECRET || purgeToken !== env.PURGE_SECRET) {
            return new Response("Forbidden", { status: 403 });
        }
        try {
            await caches.default.delete(request.url);
            return new Response("Cache Purged", { status: 200 });
        } catch (e) {
            return new Response("Purge Failed", { status: 500 });
        }
    }

    // E. WAF-LITE (Decoded URL scan — path + query string always checked)
    // Previously gated on `url.search || pathname.includes('..')` which meant
    // path-only injections (e.g. GET /search/<script>alert(1)</script>/x) were
    // never scanned. Now always decode and scan the full URL surface.
    const wafTarget = decodeURIComponent(url.pathname + url.search);
    const suspicious = [/<script>/i, /UNION[\s+]SELECT/i, /OR[\s]+1[\s]*=[\s]*1/i, /\.\.\//];
    if (suspicious.some((p) => p.test(wafTarget))) {
        return new Response("Forbidden", { status: 403 });
    }

    return null; // All checks passed
}

async function incrementRateLimit(env, key, current) {
    try {
        await env.CLOUDEDGING_CACHE.put(key, (current + 1).toString(), { expirationTtl: 60 });
    } catch (e) {}
}
