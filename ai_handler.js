// ============================================================
// AI GATEWAY HANDLER — v3.0.0
//
// UPGRADED: Exact-match KV cache → Vectorize semantic cache
// Original provider routing, validation, streaming all preserved.
//
// Flow (semantic cache enabled):
//   1. Validate request
//   2. Extract prompt → embed via Workers AI or OpenAI
//   3. Search Vectorize for semantic match (cosine >= threshold)
//   4. HIT  → return cached response (0 tokens!)
//   5. MISS → route through CF AI Gateway → cache response async
//
// Flow (semantic cache disabled / non-AI path):
//   Falls back to CF AI Gateway exact-match + standard routing
// ============================================================

async function handleAIGateway(request, env, config, ctx, url) {
    const startTime = Date.now();

    // 0. Configuration validation
    if (!config.ai_gateway_id) {
        return new Response(
            JSON.stringify({
                error: "AI Gateway not configured",
                message: "Run: cloudedging setup-ai <client-name> --gateway-id <slug>",
            }),
            { status: 500, headers: { "Content-Type": "application/json" } }
        );
    }

    if (!env.ACCOUNT_ID) {
        return new Response(
            JSON.stringify({ error: "ACCOUNT_ID environment variable missing" }),
            { status: 500, headers: { "Content-Type": "application/json" } }
        );
    }

    const path = url.pathname;
    const providerHeader = request.headers.get("X-Provider");
    const provider = providerHeader || detectProviderFromPath(path);

    // Fallback gate: non-AI traffic → standard handler
    if (provider === "unknown") {
        console.log(`[Shield] Non-AI traffic on AI mode: ${path}`);
        return handleWebTraffic(request, env, config, ctx, url);
    }

    // 1. Request validation
    const validationError = validateAIRequest(request, config);
    if (validationError) return validationError;

    // 2. Clone request early (body can only be read once)
    const clonedRequest = request.clone();

    // ── SEMANTIC CACHE PIPELINE ────────────────────────────
    // Only if Vectorize + Workers AI are bound and semantic cache is enabled
    const semanticEnabled =
        config.semantic_cache_enabled !== false &&
        env.SEMANTIC_DB &&
        env.AI;

    if (semanticEnabled && request.method === "POST") {
        try {
            const semanticResult = await semanticCachePipeline(
                clonedRequest.clone(), env, config, provider, startTime
            );
            if (semanticResult) return semanticResult; // Cache HIT
        } catch (err) {
            console.error("[Semantic Cache] Pipeline error:", err.message);
            // Fall through to standard AI Gateway routing
        }
    }

    // ── STANDARD AI GATEWAY ROUTING ────────────────────────
    const normalizedPath = normalizeProviderPath(provider, path);
    const gatewayOrigin = `https://gateway.ai.cloudflare.com/v1/${env.ACCOUNT_ID}/${config.ai_gateway_id}/${provider}`;
    const fullUrl = gatewayOrigin + normalizedPath + url.search;
    const headers = buildAIHeaders(request, env, provider);

    const hasBody = ["POST", "PUT", "PATCH"].includes(request.method);
    const newRequest = new Request(fullUrl, {
        method: request.method,
        headers: headers,
        body: hasBody ? clonedRequest.body : null,
    });

    try {
        const response = await fetch(newRequest);
        const latency = Date.now() - startTime;

        // Streaming responses
        const contentType = response.headers.get("content-type") || "";
        if (contentType.includes("text/event-stream") || contentType.includes("stream")) {
            return createStreamingResponse(response, provider, config);
        }

        const finalResponse = createAIResponse(response, provider, config, env, latency);

        // ── ASYNC: Store in semantic cache on MISS ─────────
        if (semanticEnabled && response.ok && request.method === "POST") {
            ctx.waitUntil(
                semanticCacheStore(request.clone(), response.clone(), env, config)
                    .catch((err) => console.error("[Semantic Cache] Store error:", err.message))
            );
        }

        // Log analytics
        ctx.waitUntil(
            logAIAnalytics(env, {
                timestamp: new Date().toISOString(),
                provider,
                client_id: env.CLIENT_ID,
                status: response.status,
                latency_ms: latency,
                cache_status: "MISS",
                path: url.pathname,
            })
        );

        return finalResponse;
    } catch (e) {
        return handleAIError(e, provider, env);
    }
}

// ============================================================
// SEMANTIC CACHE — Vectorize (Search) + KV (Storage) + Workers AI
//
// Architecture:
//   Vectorize stores lightweight vectors (search/similarity)
//   KV stores heavy payloads (full AI responses, no size limit)
//   Vector ID is the key linking both stores
//
// Why not store response in Vectorize metadata?
//   Cloudflare Vectorize has a 10KB metadata limit per vector.
//   AI responses routinely exceed this. Storing in KV is safe.
// ============================================================

/**
 * Attempt semantic cache lookup.
 * Returns Response on HIT, null on MISS.
 */
async function semanticCachePipeline(request, env, config, provider, startTime) {
    const body = await request.text();
    const promptText = extractPromptForEmbedding(body);
    if (!promptText || promptText.length < 10) return null;

    const threshold = config.semantic_cache_threshold || 0.92;

    // 1. Generate embedding (truncate to ~2000 chars to stay within 512 token model limit)
    const safePrompt = promptText.substring(0, 2000);
    const embedding = await generateEmbedding(safePrompt, env, config);

    // 2. Search Vectorize for similar cached prompts
    const results = await env.SEMANTIC_DB.query(embedding, {
        topK: 1,
        returnMetadata: "all",
    });

    if (results.matches && results.matches.length > 0) {
        const best = results.matches[0];
        if (best.score >= threshold) {

            // 3. CACHE HIT: Fetch the actual payload from KV using the Vector ID
            const cachedResponseText = await env.CLOUDEDGING_CACHE.get(best.id);

            if (cachedResponseText) {
                return new Response(cachedResponseText, {
                    status: 200,
                    headers: {
                        "Content-Type": "application/json",
                        "X-Shield-Status": "HIT",
                        "X-Shield-AI-Provider": provider,
                        "X-Shield-AI-Cache": "SEMANTIC-HIT",
                        "X-Shield-AI-Cache-Score": best.score.toFixed(4),
                        "X-Shield-AI-Cache-Model": best.metadata?.model || "unknown",
                        "X-Shield-AI-Latency": String(Date.now() - startTime),
                        "X-Shield-Version": "3.0.0",
                    },
                });
            } else {
                // Orphaned vector — KV expired but Vectorize entry remains
                // Treat as MISS; the vector will be overwritten on next similar prompt
                console.warn(`[Semantic Cache] Orphaned vector ID: ${best.id}, score: ${best.score.toFixed(4)}`);
            }
        }
    }

    return null; // MISS
}

/**
 * Store AI response: Vector in Vectorize, Payload in KV.
 * Runs async via ctx.waitUntil (fire-and-forget).
 *
 * KV TTL controls cache lifetime — when KV expires, the orphaned
 * vector in Vectorize safely results in a MISS on next lookup.
 */
async function semanticCacheStore(request, response, env, config) {
    if (!env.CLOUDEDGING_CACHE) return; // KV required for payload storage

    const body = await request.text();
    const promptText = extractPromptForEmbedding(body);
    if (!promptText || promptText.length < 10) return;

    const responseText = await response.text();
    if (!responseText) return;

    // Truncate prompt for embedding model safety
    const safePrompt = promptText.substring(0, 2000);
    const embedding = await generateEmbedding(safePrompt, env, config);
    const hash = await semanticHashString(safePrompt);
    const id = `prompt-${hash}-${Date.now()}`;

    // Parse model name from response for metadata
    let model = "unknown";
    try {
        const parsed = JSON.parse(responseText);
        model = parsed.model || parsed.meta?.model || "unknown";
    } catch {}

    // 1. Store heavy payload in KV (configurable TTL, default 1h)
    const ttl = config.ai_cache_ttl || 3600;
    await env.CLOUDEDGING_CACHE.put(id, responseText, { expirationTtl: ttl });

    // 2. Store lightweight vector in Vectorize (metadata stays under 10KB)
    await env.SEMANTIC_DB.upsert([
        {
            id: id,
            values: embedding,
            metadata: {
                model,
                cached_at: new Date().toISOString(),
                prompt_hash: hash,
            },
        },
    ]);
}

/**
 * Generate embedding safely — truncated input prevents model overflow.
 * Workers AI bge-base-en-v1.5: 512 token limit (~2000 chars)
 * OpenAI text-embedding-3-small: 8191 token limit (generous)
 */
async function generateEmbedding(text, env, config) {
    const provider = config.embedding_provider || "workers_ai";

    if (provider === "openai" && env.OPENAI_API_KEY) {
        const resp = await fetch("https://api.openai.com/v1/embeddings", {
            method: "POST",
            headers: {
                Authorization: `Bearer ${env.OPENAI_API_KEY}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({ model: "text-embedding-3-small", input: text }),
        });
        const data = await resp.json();
        if (!resp.ok) throw new Error(`OpenAI embed error: ${data.error?.message}`);
        return data.data[0].embedding;
    }

    // Default: Workers AI (free, runs at edge, ~2ms)
    const model = config.embedding_model || "@cf/baai/bge-base-en-v1.5";
    const result = await env.AI.run(model, { text: [text] });
    return result.data[0];
}

/**
 * Extract user prompt text from AI API request body.
 * Handles OpenAI, Anthropic, Google Gemini, legacy formats.
 */
function extractPromptForEmbedding(body) {
    try {
        const data = JSON.parse(body);

        // OpenAI / Anthropic messages format
        if (data.messages && Array.isArray(data.messages)) {
            return data.messages
                .filter((m) => m.role === "user")
                .map((m) => {
                    if (typeof m.content === "string") return m.content;
                    if (Array.isArray(m.content))
                        return m.content
                            .filter((p) => p.type === "text")
                            .map((p) => p.text)
                            .join("\n");
                    return JSON.stringify(m.content);
                })
                .join("\n");
        }

        // Legacy completions
        if (data.prompt) return typeof data.prompt === "string" ? data.prompt : JSON.stringify(data.prompt);
        // Embedding input
        if (data.input) return typeof data.input === "string" ? data.input : JSON.stringify(data.input);
        // Google Gemini
        if (data.contents) return JSON.stringify(data.contents);

        return JSON.stringify(data);
    } catch {
        return body;
    }
}

/**
 * SHA-256 hash for cache key generation.
 * Self-contained in this module to avoid cross-module dependency issues.
 */
async function semanticHashString(str) {
    const encoder = new TextEncoder();
    const data = encoder.encode(str);
    const hashBuffer = await crypto.subtle.digest("SHA-256", data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("").substring(0, 16);
}

// ============================================================
// AI SUPPORT FUNCTIONS (from original v2.6.0)
// ============================================================

function validateAIRequest(request, config) {
    if (!["POST", "GET", "PUT", "PATCH"].includes(request.method)) {
        return new Response("Method not allowed", {
            status: 405,
            headers: { Allow: "POST, GET, PUT, PATCH", "Content-Type": "application/json" },
        });
    }

    if (["POST", "PUT", "PATCH"].includes(request.method)) {
        const contentType = request.headers.get("content-type") || "";
        if (!contentType.includes("application/json")) {
            return new Response(
                JSON.stringify({ error: "Invalid Content-Type", message: "Must be application/json" }),
                { status: 400, headers: { "Content-Type": "application/json" } }
            );
        }
    }

    const contentLength = parseInt(request.headers.get("content-length") || "0");
    const maxSize = config.ai_max_request_size || 10485760;
    if (contentLength > maxSize) {
        return new Response(
            JSON.stringify({ error: "Request too large", max_size_bytes: maxSize }),
            { status: 413, headers: { "Content-Type": "application/json" } }
        );
    }

    return null;
}

function detectProviderFromPath(path) {
    if (path.includes("/v1/messages") || path.includes("/v1/complete")) return "anthropic";
    if (path.includes("/projects/") && (path.includes("/locations/") || path.includes("/publishers/"))) return "vertex-ai";
    if (path.includes("/openai/deployments/")) return "azure-openai";
    if (path.includes("/model/") && (path.includes("anthropic.") || path.includes("amazon."))) return "aws-bedrock";
    if (path.includes("/models/gemini") || path.includes("/generativelanguage")) return "google-ai-studio";
    if (path.includes("/chat/completions") || path.includes("/embeddings") || path.includes("/v1/models") || path.includes("/images/generations")) return "openai";
    return "unknown";
}

function normalizeProviderPath(provider, originalPath) {
    switch (provider) {
        case "anthropic":
        case "openai":
            return originalPath.startsWith("/v1/") ? originalPath : "/v1" + originalPath;
        case "azure-openai":
            if (!originalPath.includes("api-version")) {
                const sep = originalPath.includes("?") ? "&" : "?";
                return originalPath + sep + "api-version=2024-02-01";
            }
            return originalPath;
        default:
            return originalPath;
    }
}

function buildAIHeaders(request, env, provider) {
    const headers = new Headers();
    const allowed = [
        "authorization", "content-type", "accept", "user-agent",
        "x-api-key", "anthropic-version", "anthropic-dangerous-direct-browser-access",
        "openai-organization", "openai-project", "x-api-version", "api-key",
    ];
    allowed.forEach((key) => {
        const value = request.headers.get(key);
        if (value) headers.set(key, value);
    });
    headers.set("x-shield-client", env.CLIENT_ID || "unknown");
    headers.set("x-shield-provider", provider);
    const clientIp = request.headers.get("cf-connecting-ip");
    if (clientIp) headers.set("x-forwarded-for", clientIp);
    return headers;
}

function createStreamingResponse(response, provider, config) {
    return new Response(response.body, {
        status: response.status,
        headers: {
            "Content-Type": response.headers.get("content-type"),
            "Cache-Control": "no-cache",
            "X-Shield-AI-Provider": provider,
            "X-Shield-AI-Gateway": config.ai_gateway_id,
            "X-Shield-AI-Stream": "true",
            "X-Shield-Version": "3.0.0",
        },
    });
}

function createAIResponse(response, provider, config, env, latency) {
    const newRes = new Response(response.body, { status: response.status, headers: response.headers });
    newRes.headers.set("X-Shield-AI-Provider", provider);
    newRes.headers.set("X-Shield-AI-Gateway", config.ai_gateway_id);
    newRes.headers.set("X-Shield-AI-Latency", latency.toString());
    newRes.headers.set("X-Shield-Version", "3.0.0");
    const cfCache = response.headers.get("cf-cache-status");
    if (cfCache) newRes.headers.set("X-Shield-AI-Cache", cfCache);
    return newRes;
}

function handleAIError(error, provider, env) {
    console.error("[AI Gateway Error]", { provider, error: error.message, client_id: env.CLIENT_ID });
    const isRateLimit = error.message?.includes("429") || error.message?.includes("rate limit");
    return new Response(
        JSON.stringify({
            error: { type: "gateway_error", provider, message: error.message, retry_after: isRateLimit ? 60 : null },
        }),
        {
            status: isRateLimit ? 429 : 502,
            headers: {
                "Content-Type": "application/json",
                "X-Shield-AI-Error": "true",
                "X-Shield-AI-Provider": provider,
                ...(isRateLimit ? { "Retry-After": "60" } : {}),
            },
        }
    );
}

async function logAIAnalytics(env, data) {
    if (!env.CLOUDEDGING_ANALYTICS) return;
    try {
        const key = `ai_analytics:${data.client_id}:${Date.now()}`;
        await env.CLOUDEDGING_ANALYTICS.put(key, JSON.stringify(data), { expirationTtl: 2592000 });
    } catch (e) {}
}
