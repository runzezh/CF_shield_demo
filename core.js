/**
 * CLOUDEDGING SHIELD v3.0.0 — Core Entry Point
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
            // 0. PROTOCOL HANDLERS
            const upgradeHeader = (request.headers.get("Upgrade") || "").toLowerCase().trim();
            if (upgradeHeader === "websocket") return await handleWebSocket(request, env);

            // 1. LOAD CONFIGURATION
            const config = await loadConfig(env);

            // 2. SECURITY PIPELINE (Universal)
            const securityResponse = await runSecurityPipeline(request, env, config, url, ctx);
            if (securityResponse) return securityResponse;

            // 3. EXECUTE FEATURE HANDLER
            const handler = FEATURE_HANDLERS[config.mode] || handleWebTraffic;
            let response = await handler(request, env, config, ctx, url);

            // 4. FINAL FORTIFICATION (Stealth & Security Headers)
            return fortifyResponse(response, config, env, url);

        } catch (err) {
            console.error(`[Shield Error] ${err.message}`);
            return new Response("Shield Error", { status: 500 });
        }
    }
};
