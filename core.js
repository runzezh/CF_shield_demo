/**
 * CLOUDEDGING SHIELD v3.1.0 — Core Entry Point
 * Architecture: Middleware Pipeline with Feature Registry
 *
 * Each mode maps to a handler. Config is loaded from KV (CLOUDEDGING_CONFIG).
 * The Python deploy stitcher concatenates all modules into a single worker file.
 */

// --- GLOBAL STATE ---
let CACHED_CONFIG = null;
let LAST_CONFIG_FETCH = 0;
const CONFIG_TTL_MS = 60000;

// ============================================================
// EXTENSION REGISTRY — add new features here
// ============================================================
const FEATURE_HANDLERS = {
    "STANDARD":          handleWebTraffic,
    "ECOMMERCE":         handleR2Storage,
    "IOT":               handleR2Storage,
    "SAAS":              handleWebTraffic,
    "NEWS":              handleR2Storage,
    "API":               handleWebTraffic,
    "REALTIME":          handleWebTraffic,
    "AI_INFERENCE":      handleAIGateway,
    "STORAGE_MIGRATION": handleR2Storage,
};

export default {
    async fetch(request, env, ctx) {
        const startTime = Date.now();
        const url = new URL(request.url);

        try {
            // 0. LOAD CONFIGURATION (needed by security pipeline for all paths)
            const config = await loadConfig(env);

            // 1. SECURITY PIPELINE (Universal — runs before protocol handlers)
            // Must run before WebSocket upgrade check so geo-block and rate limiting
            // apply to WebSocket connections. A sanctioned country bypassing HTTP blocks
            // via WebSocket is a compliance violation for REALTIME/crypto customers.
            const securityResponse = await runSecurityPipeline(request, env, config, url, ctx);
            if (securityResponse) return securityResponse;

            // 2. PROTOCOL HANDLERS (after security checks pass)
            const upgradeHeader = (request.headers.get("Upgrade") || "").toLowerCase().trim();
            if (upgradeHeader === "websocket") return await handleWebSocket(request, env);

            // 3. EXECUTE FEATURE HANDLER
            const handler = FEATURE_HANDLERS[config.mode] || handleWebTraffic;
            let response = await handler(request, env, config, ctx, url);

            // 5. FINAL FORTIFICATION (Security headers, CORS, fingerprint removal)
            // Pass request as 5th arg so fortifyResponse can read the Origin header
            // for CORS — Origin comes from the browser request, not the origin response.
            return fortifyResponse(response, config, env, url, request);

        } catch (err) {
            console.error(`[Shield Error] ${err.message}`);
            return new Response("Shield Error", { status: 500 });
        }
    }
};
