// ============================================================
// 1. EXTENSION REGISTRY
// ============================================================
const FEATURE_HANDLERS = {
    "STANDARD": handleWebTraffic,
    "ECOMMERCE": handleR2Storage,
    "IOT": handleR2Storage,
    "SAAS": handleWebTraffic,
    "NEWS": handleR2Storage,
    "API": handleWebTraffic,
    "REALTIME": handleWebTraffic,
    "AI_INFERENCE": handleAIGateway, 
    "STORAGE_MIGRATION": handleR2Storage // Explicit mode
};

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);

        try {
            // 0. PROTOCOL HANDLERS
            const upgradeHeader = (request.headers.get("Upgrade") || "").toLowerCase().trim();
            if (upgradeHeader === "websocket") return await handleWebSocket(request, env);

            // 1. LOAD CONFIGURATION
            const config = await loadConfig(env);

            // 2. SECURITY PIPELINE (Universal)
            const securityResponse = await runSecurityPipeline(request, env, config, url);
            if (securityResponse) return securityResponse;

            // 3. EXECUTE FEATURE HANDLER
            const handler = FEATURE_HANDLERS[config.mode] || handleWebTraffic;
            let response = await handler(request, env, config, ctx, url);

            // 4. FINAL FORTIFICATION
            return fortifyResponse(response, config, env, url);

        } catch (err) {
            console.error(`[Shield Error] ${err.message}`);
            return new Response("Shield Error", { status: 500 });
        }
    }
};