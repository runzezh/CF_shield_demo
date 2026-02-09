async function handleAIGateway(request, env, config, ctx, url) {
    if (!config.ai_gateway_id) {
        return new Response("AI Gateway ID missing", { status: 500 });
    }

    const path = url.pathname;
    const provider = detectProviderFromPath(path);

    // --- FALLBACK GATE ---
    if (provider === "unknown") {
        console.log(`[Shield] Non-AI traffic: ${path}`);
        return handleWebTraffic(request, env, config, ctx, url);
    }

    // --- PROCEED WITH AI ROUTING ---
    const normalizedPath = normalizeProviderPath(provider, path);
    const gatewayOrigin = `https://gateway.ai.cloudflare.com/v1/${env.ACCOUNT_ID}/${config.ai_gateway_id}/${provider}`;
    const fullUrl = gatewayOrigin + normalizedPath + url.search;

    const headers = buildAIHeaders(request, env, provider);
    
    // Check if we should send a body
    const hasBody = ['POST', 'PUT', 'PATCH'].includes(request.method);

    const newRequest = new Request(fullUrl, {
        method: request.method,
        headers: headers,
        body: hasBody ? request.clone().body : null
    });

    try {
        const response = await fetch(newRequest);
        return createAIResponse(response, provider, config, env);
    } catch (e) {
        return handleAIError(e, provider);
    }
}

// ============================================================
// AI SUPPORT FUNCTIONS (The missing pieces)
// ============================================================

function detectProviderFromPath(path) {
    if (path.includes('/messages')) return 'anthropic';
    if (path.includes('/projects/') && path.includes('/locations/')) return 'google-vertex-ai';
    if (path.includes('/models/gemini')) return 'google-ai-studio';
    if (path.includes('/chat/completions') || path.includes('/embeddings')) return 'openai';
    return 'unknown';
}

function normalizeProviderPath(provider, originalPath) {
    if (provider === 'anthropic' || provider === 'openai') {
        return originalPath.startsWith('/v1/') ? originalPath : '/v1' + originalPath;
    }
    return originalPath;
}

function buildAIHeaders(request, env, provider) {
    const headers = new Headers();
    const allowed = [
        'authorization', 'content-type', 'accept', 'user-agent',
        'x-api-key', 'anthropic-version', 'openai-organization'
    ];
    
    allowed.forEach(key => {
        const value = request.headers.get(key);
        if (value) headers.set(key, value);
    });

    headers.set('x-shield-client', env.CLIENT_ID || 'unknown');
    return headers;
}

function createAIResponse(response, provider, config, env) {
    const newRes = new Response(response.body, response);
    newRes.headers.set('X-Shield-AI-Provider', provider);
    newRes.headers.set('X-Shield-AI-Gateway', config.ai_gateway_id);
    
    const cfCache = response.headers.get('cf-cache-status');
    if (cfCache) newRes.headers.set('X-Shield-AI-Cache', cfCache);
    
    return newRes;
}

function handleAIError(error, provider) {
    return new Response(JSON.stringify({
        error: "AI_GATEWAY_ERROR",
        provider: provider,
        message: error.message
    }), { 
        status: 502, 
        headers: { "Content-Type": "application/json" } 
    });
}