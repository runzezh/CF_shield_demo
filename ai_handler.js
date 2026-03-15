// ============================================================
// AI GATEWAY HANDLER — v3.1.0
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
    // AI Gateway is OPTIONAL — when configured, all provider traffic routes through
    // gateway.ai.cloudflare.com for logging, rate limiting, and cost tracking.
    // When absent, traffic routes directly to the provider (OpenAI, Anthropic, etc.).
    // Semantic cache (Vectorize + Workers AI + KV) works independently either way.
    const useGateway = !!(config.ai_gateway_id && env.ACCOUNT_ID);

    if (!env.ACCOUNT_ID) {
        console.warn("[AI Shield] ACCOUNT_ID missing — routing directly to provider");
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

    // embedding is computed once on MISS and reused for the store step — avoids double Workers AI call
    let missEmbedding = null;

    if (semanticEnabled && request.method === "POST") {
        try {
            const pipelineResult = await semanticCachePipeline(
                clonedRequest.clone(), env, config, provider, startTime
            );
            if (pipelineResult.response) return pipelineResult.response; // Cache HIT
            missEmbedding = pipelineResult.embedding; // reuse on store
        } catch (err) {
            console.error("[Semantic Cache] Pipeline error:", err.message);
            // Fall through to standard AI Gateway routing
        }
    }

    // ── STANDARD AI ROUTING ────────────────────────────────
    // Route through CF AI Gateway if configured, else direct to provider
    const normalizedPath = normalizeProviderPath(provider, path);
    const PROVIDER_ORIGINS = {
        "openai":          "https://api.openai.com",
        "anthropic":       "https://api.anthropic.com",
        "google-ai-studio":"https://generativelanguage.googleapis.com",
        "azure-openai":    `https://${request.headers.get("X-Azure-Resource") || "your-resource"}.openai.azure.com`,
        "aws-bedrock":     "https://bedrock-runtime.us-east-1.amazonaws.com",
        "workers-ai":      `https://api.cloudflare.com/client/v4/accounts/${env.ACCOUNT_ID}/ai/run`,
    };
    const directOrigin = PROVIDER_ORIGINS[provider] || `https://api.${provider}.com`;
    const gatewayOrigin = `https://gateway.ai.cloudflare.com/v1/${env.ACCOUNT_ID}/${config.ai_gateway_id}/${provider}`;
    const routingOrigin = useGateway ? gatewayOrigin : directOrigin;
    const fullUrl = routingOrigin + normalizedPath + url.search;
    console.log(`[AI Shield] Routing via ${useGateway ? "CF Gateway" : "direct"}: ${provider} → ${fullUrl}`);
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
        // CRITICAL: clone finalResponse, NOT the original response.
        // createAIResponse() passes response.body into a new Response, which transfers
        // and locks the original stream. Calling response.clone() after that throws:
        //   TypeError: Cannot clone a response that has already been used
        // finalResponse is a fresh Response object with an unlocked body — safe to clone.
        if (semanticEnabled && response.ok && request.method === "POST") {
            ctx.waitUntil(
                semanticCacheStore(request.clone(), finalResponse.clone(), env, config, missEmbedding)
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
 * Returns { response: Response, embedding: null } on HIT (embedding not needed).
 * Returns { response: null, embedding: Float32Array } on MISS (embedding reused by store).
 */
async function semanticCachePipeline(request, env, config, provider, startTime) {
    const body = await request.text();
    const promptText = extractPromptForEmbedding(body);
    if (!promptText || promptText.length < 10) return { response: null, embedding: null };

    const threshold = config.semantic_cache_threshold || 0.92;

    // 1. Generate embedding once — returned on MISS so caller can reuse for store
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
                return {
                    response: new Response(cachedResponseText, {
                        status: 200,
                        headers: {
                            "Content-Type": "application/json",
                            "X-Shield-Status": "HIT",
                            "X-Shield-AI-Provider": provider,
                            "X-Shield-AI-Cache": "SEMANTIC-HIT",
                            "X-Shield-AI-Cache-Score": best.score.toFixed(4),
                            "X-Shield-AI-Cache-Model": best.metadata?.model || "unknown",
                            "X-Shield-AI-Latency": String(Date.now() - startTime),
                            "X-Shield-Version": "3.1.0",
                        },
                    }),
                    embedding: null, // HIT — no need to store
                };
            } else {
                // Orphaned vector — KV expired but Vectorize entry remains
                // Treat as MISS; the vector will be overwritten on next similar prompt
                console.warn(`[Semantic Cache] Orphaned vector ID: ${best.id}, score: ${best.score.toFixed(4)}`);
            }
        }
    }

    return { response: null, embedding }; // MISS — return embedding for reuse
}

/**
 * Store AI response: Vector in Vectorize, Payload in KV.
 * Runs async via ctx.waitUntil (fire-and-forget).
 *
 * Write order: Vectorize FIRST, then KV.
 * Rationale: a Vectorize-only orphan → harmless MISS on next lookup.
 *            a KV-only orphan → unreachable storage waste, never cleaned up.
 *
 * @param {Request} request - Cloned original request
 * @param {Response} response - Cloned provider response
 * @param {object} env - Worker env bindings
 * @param {object} config - Shield brain config
 * @param {Array|null} precomputedEmbedding - Reused from pipeline step (avoids second Workers AI call)
 */
async function semanticCacheStore(request, response, env, config, precomputedEmbedding = null) {
    if (!env.CLOUDEDGING_CACHE) return; // KV required for payload storage

    const body = await request.text();
    const promptText = extractPromptForEmbedding(body);
    if (!promptText || promptText.length < 10) return;

    const responseText = await response.text();
    if (!responseText) return;

    // Guard: CF KV hard limit is 25MB. Skip oversized responses rather than throw.
    const MAX_KV_BYTES = 24 * 1024 * 1024; // 24MB safety margin
    if (responseText.length > MAX_KV_BYTES) {
        console.warn(`[Semantic Cache] Response too large to cache: ${(responseText.length / 1024 / 1024).toFixed(1)}MB — skipping`);
        return;
    }

    const safePrompt = promptText.substring(0, 2000);
    // Reuse embedding from pipeline step — avoids a second Workers AI / OpenAI call on every MISS
    const embedding = precomputedEmbedding || await generateEmbedding(safePrompt, env, config);
    const hash = await semanticHashString(safePrompt);
    // ID is the prompt hash only — no Date.now() suffix.
    // Vectorize upsert overwrites identical hashes, preventing vector sprawl where
    // 10,000 requests for the same prompt create 10,000 duplicate vectors.
    const id = `prompt-${hash}`;

    // Parse model name from response for metadata
    let model = "unknown";
    try {
        const parsed = JSON.parse(responseText);
        model = parsed.model || parsed.meta?.model || "unknown";
    } catch {}

    const ttl = config.ai_cache_ttl || 3600;

    // 1. Write vector to Vectorize FIRST
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

    // 2. Write payload to KV — only reached if Vectorize write succeeded
    await env.CLOUDEDGING_CACHE.put(id, responseText, { expirationTtl: ttl });
}

/**
 * Generate embedding via Workers AI (edge, ~2ms, free on paid Workers plan).
 *
 * NOTE: OpenAI embeddings are intentionally removed. The `embedding_provider`
 * config key is reserved for a future release that will wire OPENAI_API_KEY
 * as a wrangler secret during deployment. Until that plumbing exists, using
 * OpenAI here would silently fail (key never injected into Worker env) and
 * then hit a dimension mismatch against a 1536d Vectorize index. Workers AI
 * bge-base-en-v1.5 (768d) is the safe default.
 *
 * Workers AI bge-base-en-v1.5: 512 token limit (~2000 chars, enforced by caller)
 */
async function generateEmbedding(text, env, config) {
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
        // Google Gemini — extract text from contents[].parts[].text
        if (data.contents) {
            if (Array.isArray(data.contents)) {
                return data.contents
                    .flatMap(c => Array.isArray(c.parts) ? c.parts : [])
                    .filter(p => p.text)
                    .map(p => p.text)
                    .join("\n") || JSON.stringify(data.contents);
            }
            return JSON.stringify(data.contents);
        }

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
        case "google-ai-studio":
            // Gemini paths are self-contained (e.g. /v1beta/models/gemini-pro:generateContent)
            // No prefix needed — just ensure leading slash
            return originalPath.startsWith("/") ? originalPath : "/" + originalPath;
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
        // Google AI Studio / Gemini
        "x-goog-api-key", "x-goog-user-project",
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
            "X-Shield-Version": "3.1.0",
        },
    });
}

function createAIResponse(response, provider, config, env, latency) {
    const newRes = new Response(response.body, { status: response.status, headers: response.headers });
    newRes.headers.set("X-Shield-AI-Provider", provider);
    newRes.headers.set("X-Shield-AI-Gateway", config.ai_gateway_id);
    newRes.headers.set("X-Shield-AI-Latency", latency.toString());
    newRes.headers.set("X-Shield-Version", "3.1.0");
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
        // crypto.randomUUID() — not Date.now() — prevents 1ms key collision at high req rates
        const key = `ai_analytics:${data.client_id}:${crypto.randomUUID()}`;
        await env.CLOUDEDGING_ANALYTICS.put(key, JSON.stringify(data), { expirationTtl: 2592000 });
    } catch (e) {}
}
