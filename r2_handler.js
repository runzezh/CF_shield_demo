// ============================================================
// R2 STORAGE MIRROR — Cache-Aside with Background Mirroring
// Modes: ECOMMERCE, IOT, NEWS, STORAGE_MIGRATION
//
// Flow:
//   1. Check if request is a static asset
//   2. Try R2 bucket first (the mirror)
//   3. R2 HIT → serve + edge cache
//   4. R2 MISS → fetch origin → mirror to R2 async → serve
// ============================================================

async function handleR2Storage(request, env, config, ctx, url) {
    const path = url.pathname;

    // 1. Validate file extension (Security Guard)
    const staticExtensions = /\.(jpg|jpeg|png|gif|webp|svg|ico|css|js|woff2?|ttf|eot|otf|mp4|webm|mp3|pdf|txt|json|zip|bin)$/i;
    if (!staticExtensions.test(path)) {
        return handleWebTraffic(request, env, config, ctx, url);
    }

    // 2. Check R2 Bucket binding — fail open if misconfigured
    if (!env.STORAGE_BUCKET) {
        console.warn("[R2 Shield] STORAGE_BUCKET not bound. Falling back to Origin.");
        return handleWebTraffic(request, env, config, ctx, url);
    }

    // 3. Generate sanitized R2 key
    const r2Key = path.startsWith("/") ? path.slice(1) : path;
    if (r2Key.includes("..") || r2Key.includes("//")) {
        return new Response("Invalid path", { status: 400 });
    }

    // 4. Try R2 first (The Mirror)
    try {
        const object = await env.STORAGE_BUCKET.get(r2Key);

        if (object) {
            const headers = new Headers();
            object.writeHttpMetadata(headers);

            if (!headers.has("Content-Type")) {
                headers.set("Content-Type", getContentType(r2Key));
            }

            headers.set("X-Shield-Storage", "R2-HIT");
            headers.set("X-Shield-Origin", "R2");
            headers.set("Access-Control-Allow-Origin", "*");
            headers.set("Cache-Control", "public, max-age=31536000, immutable");

            const response = new Response(object.body, { headers });

            // Edge cache async
            const cacheResponse = response.clone();
            ctx.waitUntil(
                (async () => {
                    try {
                        await saveToCache(caches.default, new Request(url.toString()), cacheResponse, 604800);
                    } catch (err) {
                        console.error(`[R2 Shield] CDN cache failed: ${path}`, err);
                    }
                })()
            );

            return response;
        }
    } catch (err) {
        console.error(`[R2 Shield] R2 get() error: ${path}`, err);
    }

    // 5. R2 MISS → Fetch from Origin
    const originRes = await fetchFromOrigin(request, env, url, "GET", true);

    // 6. Background mirroring
    if (originRes.status === 200) {
        const toStore = originRes.clone();
        ctx.waitUntil(
            (async () => {
                try {
                    const contentLength = parseInt(toStore.headers.get("Content-Length") || "0");
                    const contentType = toStore.headers.get("Content-Type") || "";
                    const cacheControl = toStore.headers.get("Cache-Control") || "";

                    const mirrorableTypes = [
                        "image/", "video/", "audio/", "javascript", "css",
                        "font", "woff", "application/pdf", "application/zip", "application/octet-stream",
                    ];

                    const isMirrorableType = mirrorableTypes.some((type) => contentType.includes(type));

                    const shouldMirror =
                        contentLength > 0 &&
                        contentLength < 100 * 1024 * 1024 && // <100MB
                        isMirrorableType &&
                        !cacheControl.includes("no-store") &&
                        !cacheControl.includes("private");

                    if (shouldMirror) {
                        const httpMetadata = {};
                        if (contentType) httpMetadata.contentType = contentType;
                        if (toStore.headers.has("Content-Encoding")) {
                            httpMetadata.contentEncoding = toStore.headers.get("Content-Encoding");
                        }

                        await env.STORAGE_BUCKET.put(r2Key, toStore.body, { httpMetadata });
                        console.log(`[R2 Shield] Mirrored: ${path} (${(contentLength / 1024).toFixed(1)}KB)`);
                    }
                } catch (err) {
                    console.error(`[R2 Shield] Mirror failed: ${path}`, err.message);
                }
            })()
        );
    }

    return addShieldHeader(originRes, "R2-MISS");
}

function getContentType(filename) {
    const ext = filename.split(".").pop().toLowerCase();
    const types = {
        jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif",
        webp: "image/webp", svg: "image/svg+xml", ico: "image/x-icon",
        css: "text/css", js: "application/javascript", json: "application/json",
        woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf",
        eot: "application/vnd.ms-fontobject", otf: "font/otf",
        mp4: "video/mp4", webm: "video/webm", mp3: "audio/mpeg",
        pdf: "application/pdf", txt: "text/plain",
        zip: "application/zip", bin: "application/octet-stream",
    };
    return types[ext] || "application/octet-stream";
}
