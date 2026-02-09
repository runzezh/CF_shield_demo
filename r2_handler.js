/**
 * CLOUDEDGING STORAGE MIRROR (R2 Extension)
 * Logic: Cache-Aside with Background Mirroring
 * 
 * @param {Request} request
 * @param {Object} env
 * @param {Object} config
 * @param {ExecutionContext} ctx
 * @param {URL} url
 * @returns {Promise<Response>}
 */
async function handleR2Storage(request, env, config, ctx, url) {
    const path = url.pathname;
    
    // 1. Validate file extension (Security Guard)
    // Added zip, bin, etc for IOT/Storage modes
    const staticExtensions = /\.(jpg|jpeg|png|gif|webp|svg|ico|css|js|woff2?|ttf|eot|otf|mp4|webm|mp3|pdf|txt|json|zip|bin)$/i;
    if (!staticExtensions.test(path)) {
        return handleWebTraffic(request, env, config, ctx, url);
    }
    
    // 2. Check R2 Bucket binding
    if (!env.STORAGE_BUCKET) {
        // FAIL OPEN STRATEGY: 
        // If R2 is misconfigured, we log a warning but keep the site alive 
        // by falling back to the standard web handler.
        console.warn("[R2 Shield] STORAGE_BUCKET not bound. Falling back to Origin.");
        return handleWebTraffic(request, env, config, ctx, url);
    }
    
    // 3. Generate sanitized R2 key
    const r2Key = path.startsWith('/') ? path.slice(1) : path;
    
    // Prevent path traversal
    if (r2Key.includes('..') || r2Key.includes('//')) {
        return new Response("Invalid path", { status: 400 });
    }
    
    // 4. Try R2 first (The Mirror)
    try {
        const object = await env.STORAGE_BUCKET.get(r2Key);
        
        if (object) {
            // Build response headers
            const headers = new Headers();
            object.writeHttpMetadata(headers);
            
            // Ensure essential headers
            if (!headers.has("Content-Type")) {
                headers.set("Content-Type", getContentType(r2Key));
            }
            
            // Add Shield headers
            headers.set("X-Shield-Storage", "R2-HIT");
            headers.set("X-Shield-Origin", "R2");
            headers.set("Access-Control-Allow-Origin", "*");
            // R2 assets are immutable; cache heavily in browser
            headers.set("Cache-Control", "public, max-age=31536000, immutable");
            
            // Create response
            const response = new Response(object.body, { headers });
            
            // Cache in CDN (Edge Cache)
            const cacheResponse = response.clone();
            ctx.waitUntil((async () => {
                try {
                    await saveToCache(
                        caches.default, 
                        new Request(url.toString()), 
                        cacheResponse, 
                        604800 // 7 days Edge Cache
                    );
                } catch (err) {
                    console.error(`[R2 Shield] CDN cache failed: ${path}`, err);
                }
            })());
            
            return response;
        }
    } catch (err) {
        console.error(`[R2 Shield] R2 get() error: ${path}`, err);
        // Fall through to origin fetch on error
    }
    
    // 5. R2 MISS → Fetch from Origin and Mirror
    const originRes = await fetchFromOrigin(request, env, url, "GET", true);
    
    // 6. Background mirroring (if conditions met)
    if (originRes.status === 200) {
        const toStore = originRes.clone();
        
        ctx.waitUntil((async () => {
            try {
                // Extract metadata
                const contentLength = parseInt(toStore.headers.get("Content-Length") || "0");
                const contentType = toStore.headers.get("Content-Type") || "";
                const cacheControl = toStore.headers.get("Cache-Control") || "";
                
                // Refined Mirror Criteria
                const mirrorableTypes = [
                    "image/", "video/", "audio/",
                    "javascript", "css",
                    "font", "woff",
                    "application/pdf", "application/zip", "application/octet-stream"
                ];
                
                const isMirrorableType = mirrorableTypes.some(type => contentType.includes(type));
                
                const shouldMirror = (
                    contentLength > 0 && 
                    contentLength < 100 * 1024 * 1024 &&  // <100MB limit
                    isMirrorableType &&
                    !cacheControl.includes("no-store") &&
                    !cacheControl.includes("private")
                );
                
                if (shouldMirror) {
                    // Store in R2
                    const httpMetadata = {};
                    if (contentType) httpMetadata.contentType = contentType;
                    if (toStore.headers.has("Content-Encoding")) {
                        httpMetadata.contentEncoding = toStore.headers.get("Content-Encoding");
                    }
                    
                    await env.STORAGE_BUCKET.put(r2Key, toStore.body, {
                        httpMetadata: httpMetadata,
                    });
                    
                    console.log(`[R2 Shield] Mirrored: ${path} (${(contentLength / 1024).toFixed(1)}KB)`);
                }
            } catch (err) {
                console.error(`[R2 Shield] Mirror failed: ${path}`, err.message);
            }
        })());
    }
    
    // 7. Return origin response with Shield header
    const finalResponse = addShieldHeader(originRes, "R2-MISS");
    return finalResponse;
}

/**
 * Helper: Get Content-Type from file extension
 */
function getContentType(filename) {
    const ext = filename.split('.').pop().toLowerCase();
    const types = {
        'jpg': 'image/jpeg', 'jpeg': 'image/jpeg', 'png': 'image/png',
        'gif': 'image/gif', 'webp': 'image/webp', 'svg': 'image/svg+xml',
        'ico': 'image/x-icon', 'css': 'text/css', 'js': 'application/javascript',
        'json': 'application/json', 'woff': 'font/woff', 'woff2': 'font/woff2',
        'ttf': 'font/ttf', 'eot': 'application/vnd.ms-fontobject', 'otf': 'font/otf',
        'mp4': 'video/mp4', 'webm': 'video/webm', 'mp3': 'audio/mpeg',
        'pdf': 'application/pdf', 'txt': 'text/plain', 'zip': 'application/zip',
        'bin': 'application/octet-stream'
    };
    return types[ext] || 'application/octet-stream';
}