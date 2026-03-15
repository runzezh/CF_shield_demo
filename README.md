# Shield.js v3.1.0 — CloudEdging Edge Worker

## Architecture

```
apps/shield/
├── modules/                    # Modular JS source (never deployed directly)
│   ├── utils.js                # Shared: fetch, cache, fortify, config, WebSocket, hash
│   ├── security.js             # WAF-lite, rate limiting, geo-block, CORS, purge
│   ├── web_handler.js          # Standard web traffic (STANDARD, SAAS, API, REALTIME)
│   ├── r2_handler.js           # R2 storage mirror (ECOMMERCE, IOT, STORAGE_MIGRATION)
│   ├── ai_handler.js           # AI Gateway + Vectorize semantic cache (AI_INFERENCE)
│   └── core.js                 # Entry point — feature registry + fetch handler
├── stitch.py                   # Python stitcher — builds per-client worker
├── wrangler.toml.template      # Wrangler config template
└── build/                      # Generated per-client builds (gitignored)
    └── {client-slug}/
        ├── shield.js           # Stitched single-file worker
        └── wrangler.toml       # Client-specific config
```

## Feature Registry

Config `mode` determines which handler runs:

| Mode | Handler | Features |
|------|---------|----------|
| `STANDARD` | web_handler | Smart cache, SWR, auth-bypass |
| `ECOMMERCE` | r2_handler | R2 mirror, aggressive cache, image optimization |
| `IOT` | r2_handler | R2 storage, binary asset support |
| `SAAS` | web_handler | Session-aware cache |
| `NEWS` | r2_handler | R2 mirror for static assets |
| `API` | web_handler | No-cache, CORS headers |
| `REALTIME` | web_handler | WebSocket support, no-cache |
| `AI_INFERENCE` | ai_handler | **Semantic cache**, provider routing, streaming |
| `STORAGE_MIGRATION` | r2_handler | Full R2 migration with background mirroring |

## Security Pipeline (all modes)

Runs before every handler:
- **CORS** preflight for API/AI paths
- **Geo-blocking** by country
- **Rate limiting** via KV counter (60s window)
- **Cache purge** via `X-CloudEdging-Command: PURGE`
- **WAF-lite**: XSS, SQL injection, path traversal detection

## AI Semantic Cache (v3.0 upgrade)

**Replaces exact-match KV cache with Vectorize semantic similarity search.**

```
POST /v1/chat/completions
         │
    ┌────▼────────────────────────┐
    │  ai_handler.js              │
    │                             │
    │  1. Extract user prompt     │
    │  2. Embed via Workers AI    │──▶ @cf/baai/bge-base-en-v1.5 (768d, free)
    │     or OpenAI               │    text-embedding-3-small (1536d, paid)
    │  3. Vectorize query         │──▶ cosine similarity search
    │  4. Score >= threshold?     │
    │     ├── YES: Return cached  │    0 tokens consumed!
    │     └── NO:  Route via      │
    │             AI Gateway      │──▶ CF AI Gateway → provider
    │             + cache async   │
    └─────────────────────────────┘
```

### Response Headers
```
X-Shield-AI-Cache: SEMANTIC-HIT     # or MISS
X-Shield-AI-Cache-Score: 0.9547     # cosine similarity
X-Shield-AI-Provider: openai        # detected provider
X-Shield-AI-Latency: 3              # ms (HIT) vs 800+ (MISS)
```

## Build & Deploy

```bash
# Build for a specific client
python stitch.py \
  --client acme-corp \
  --origin origin.acme.com \
  --domain acme.com \
  --zone-id abc123 \
  --kv-id def456 \
  --account-id ghi789

# Deploy
cd build/acme-corp
wrangler deploy
```

## Bindings

| Binding | Type | Purpose |
|---------|------|---------|
| `CLOUDEDGING_CONFIG` | KV | Config store (loadConfig → `CFG_{CLIENT_ID}`) |
| `CLOUDEDGING_CACHE` | KV | Rate limiting counters + temp cache |
| `STORAGE_BUCKET` | R2 | Asset mirror for ECOMMERCE/IOT/STORAGE modes |
| `SEMANTIC_DB` | Vectorize | Semantic cache vectors |
| `AI` | Workers AI | Edge embeddings (free) |
| `CLIENT_ID` | env var | Client identifier |
| `ORIGIN_HOSTNAME` | env var | Origin server |
| `ACCOUNT_ID` | env var | CF account (for AI Gateway URL) |


------------------


# Shield.js v3.0.0 — CloudEdging Edge Worker

1.  What Is Shield?
CloudEdging Shield is a modular Cloudflare Worker deployed directly onto each customer's own Cloudflare account using their own API credentials. It sits between Cloudflare's edge and the customer's origin server, acting as an intelligent middleware layer that adds smart caching, R2 mirroring, security enforcement, and AI inference caching — all without requiring the customer to write any code.

Shield is not a separate proxy that bypasses Cloudflare. It runs inside the customer's own CF zone using native CF bindings. Every feature it adds either uses a CF product the customer already pays for, or activates new CF products (R2, Vectorize, Workers AI) that generate incremental CF revenue.

KEY POINT	The customer keeps full ownership. Shield deploys a Worker onto their account, not ours. Customers can see it in their CF dashboard, modify it, or delete it at any time. CloudEdging configures and maintains it via the CF API — we never hold credentials beyond deploy time.


2.  Architecture
2.1  Module Structure
Shield is assembled from six independent modules by a Python stitch pipeline at deploy time. The stitcher concatenates them in dependency order and produces a single self-contained Worker file, deployed via wrangler with a generated wrangler.toml tailored to the customer's chosen mode.

Module	Lines	Responsibility
core.js	58	Entry point. Config loader with 60 s in-memory TTL (reads KV at most once per minute per isolate). Mode-to-handler registry. Four-stage pipeline orchestration. WebSocket passthrough detection.
security.js	84	Universal security pipeline: CORS preflight, geo-blocking, plan-aware KV rate limiting, cache purge command, WAF-lite (XSS / SQLi / path traversal). Runs on every request before any feature handler.
web_handler.js	133	Caching layer for STANDARD, SAAS, API, REALTIME modes. Embeds a Plan Physics Profile that drives cache TTL multiplier, SWR window, device-variant cache keys, and aggressive no-cache override per CF plan tier.
r2_handler.js	139	Cache-aside R2 mirroring for ECOMMERCE, IOT, NEWS, STORAGE_MIGRATION modes. 30+ file extensions. Background mirror via ctx.waitUntil(). Mirror gate checks real body size via arrayBuffer().byteLength rather than Content-Length header (which may be absent on chunked responses).
ai_handler.js	466	AI inference proxy for AI_INFERENCE mode. Semantic cache pipeline using Vectorize (vector search) + Workers AI (embeddings) + KV (full response storage). Routes via CF AI Gateway when configured, else directly to provider. Supports OpenAI, Anthropic, Gemini, Vertex AI, Azure OpenAI, AWS Bedrock, Workers AI.
utils.js	148	Shared utilities: fetchFromOrigin() with CF optimisation flags, cache read/write/SWR refresh, addShieldHeader(), fortifyResponse() (security headers + server fingerprint removal), KV config loader, WebSocket bridge.

2.2  Request Pipeline (All Modes)
#	Stage	What Happens
1	Protocol Check	Inspect Upgrade header. If "websocket" → bypass entire pipeline and proxy directly to origin via WebSocket bridge (client ↔ Worker ↔ origin socket pair). All other requests proceed to Stage 2.
2	Config Load	Read CFG_{CLIENT_ID} key from CLOUDEDGING_CONFIG KV namespace. In-memory cache with 60 s TTL prevents KV reads on every request. Config struct drives all downstream behaviour: mode, CF plan, TTLs, rate limits, feature flags, gateway slug.
3	Security Pipeline	Run security.js checks in order: CORS preflight → geo-block → rate limit → purge command → WAF-lite. Any check can return early (204, 451, 429, 403). Returning null means all checks passed — continue to Stage 4.
4	Feature Handler	Dispatch to mode-specific handler from FEATURE_HANDLERS registry. Handler returns a Response. All responses pass through fortifyResponse() which injects HSTS, X-Content-Type-Options, X-Frame-Options, CSP, and strips Server / X-Powered-By / Via / X-Runtime and related fingerprint headers.


3.  Deployment Modes & CF Bindings
Customers choose a mode at onboarding. The stitch pipeline provisions only the bindings that mode requires — no unnecessary CF resources are created.

Mode	CF Bindings	Intended Workload
STANDARD	KV ×2	General websites, blogs, marketing sites. Smart caching with SWR.
ECOMMERCE	KV ×2 + R2	Online stores. Auth-aware cache bypass (cart/session cookies). R2 mirroring for product images, CSS, JS.
SAAS	KV ×2	SaaS dashboards. Conservative caching. API-path bypass. Auth-aware bypass on session cookies.
API	KV ×2	REST / GraphQL APIs. Cache bypass on write methods. CORS headers enforced. Rate limiting active.
REALTIME	KV ×2	WebSocket-heavy apps. WS passthrough via bridge. Minimal cache interference on HTTP paths.
IOT	KV ×2 + R2	IoT dashboards and telemetry. R2 for firmware and static assets. Aggressive static caching.
NEWS	KV ×2 + R2	High-read media sites. R2 for images and video. Long TTL on static assets.
AI_INFERENCE	KV ×2 + Vectorize + Workers AI	AI API proxy with semantic caching. Eliminates duplicate AI provider calls for similar prompts.
STORAGE_MIGRATION	KV ×2 + R2	Gradual hot-asset migration from S3/GCS to R2 via organic cache-aside. Zero bulk transfer.

NOTE	All modes include KV ×2: CLOUDEDGING_CONFIG (brain config, read on each request with 60 s in-memory TTL) and CLOUDEDGING_CACHE (rate limit counters, AI response payloads). KV is the only binding guaranteed present on every deployment.


4.  Plan-Aware Physics (New in v3)
Shield reads the customer's Cloudflare plan from the KV brain config (cloudflare_plan field) and automatically adjusts its own runtime behaviour. Higher plan tiers unlock better cache performance, wider SWR windows, smarter cache key generation, and higher rate limit ceilings — with no manual tuning required from the customer.

4.1  Cache & Rate Limit Profile (web_handler.js + security.js)
CF Plan	Cache TTL	SWR Window	Rate Limit Default	Override no-cache	Device Cache Keys
Free	1× base	1 hour	100 req/min	No	No
Pro	1.5× base	2 hours	200 req/min	Yes (static ext only)	Yes
Business	2× base	4 hours	500 req/min	Yes	Yes
Enterprise	3× base	8 hours	1000 req/min	Yes	Yes

Cache TTL multiplier applies to the customer's configured base_ttl. A Pro customer with base_ttl = 3600 gets an effective TTL of 5400 s. The multiplier is applied at cache write time — no config change needed when a customer upgrades their CF plan.

Override no-cache: on Pro and above, Shield will cache static file extensions (.css, .js, .woff2, etc.) even if the origin sends Cache-Control: no-cache, since many origins send this incorrectly on assets. On Free plan this override is disabled to stay conservative.

Device cache keys: on Pro and above, Shield appends __device=mobile or __device=desktop to the cache key based on User-Agent. Prevents a desktop-rendered cached asset from being served to mobile users.

4.2  Plan Recommendations (deployments.py verify pipeline)
After every deployment, the verify pipeline inspects the customer's plan and mode and returns a plan_recommendations array in the API response. Each item includes a specific action the customer can take in their CF dashboard, the measurable benefit, and the upgrade tier required (if any).

Triggered When	Recommendation	Why Shield Surfaces It
Free plan, any mode	Upgrade to Pro → enable Polish	15–35% automatic image size reduction. A zone-level toggle Shield cannot set — customer must enable in CF Dashboard → Speed → Optimization.
Free plan, any mode	Upgrade to Pro → enable WAF Managed Rules	Shield WAF-lite covers 4 patterns. CF WAF Managed Rules cover OWASP Top 10 + thousands of CVEs maintained by Cloudflare.
Free / Pro, ECOMMERCE mode	Enable Mirage (Pro)	Lazy-loads and resizes images for slow mobile connections. High ecommerce conversion impact.
Free / Pro, ECOMMERCE or API	Upgrade to Business → enable Bot Management	Shield rate limiting is IP-based. CF Bot Management adds ML-based scoring for credential stuffing and scraper detection.
Any plan, REALTIME mode	Enable Argo Smart Routing ($5/mo add-on)	Routes via Cloudflare's fastest real-time backbone. Most impactful for latency-sensitive WebSocket workloads with global users.
Free, AI_INFERENCE mode	Upgrade Workers to Paid ($5/mo)	Vectorize requires Workers Paid plan. Without it AI_INFERENCE has no semantic cache — every prompt hits the AI provider.
Pro plan (any mode)	Polish and Mirage available — confirm enabled	Many Pro customers activate plan tier but never switch on Polish/Mirage. Shield surfaces these as zero-cost quick wins.

CF ALIGNMENT	Plan recommendations are returned after every deploy, not as a one-time upsell. Each recommendation maps to a specific CF product, a measurable customer outcome, and an upgrade revenue line. Shield acts as a continuous advisor driving organic CF plan upgrades.


5.  Security Pipeline (security.js)
Runs universally before any feature handler. Checks are ordered cheapest-to-most-expensive to minimise CPU time per request. Any check can short-circuit and return a Response; returning null means all checks passed.

A.  CORS Preflight
OPTIONS requests to API-style paths (/api/, /v1-v3/, /graphql/, /rest/, /models/, /chat/, /embeddings/, /messages/) receive an immediate 204 with permissive CORS headers. Covers both API mode and AI_INFERENCE mode without duplicate logic. Allows browser-based AI clients to work without additional CF Page Rules or Transform Rules.

B.  Geo-Blocking
Blocked countries list read from KV brain config (blocked_countries string array, ISO 3166-1 alpha-2). Country resolved from request.cf.country — CF provides this natively, no additional GeoIP lookup. Returns HTTP 451 Unavailable for Legal Reasons on match.

C.  Rate Limiting
KV-backed per-IP counter in CLOUDEDGING_CACHE namespace. Key: RL_{CLIENT_ID}_{CF-Connecting-IP}. Counter stored with 60 s expirationTtl for automatic expiry. Increment dispatched via ctx.waitUntil() so it does not block the response path.

Default threshold is plan-aware (Free: 100, Pro: 200, Business: 500, Enterprise: 1000 req/min per IP). Customer can override via rate_limit_threshold in KV config. Returns HTTP 429 with Retry-After: 60. Fails open on KV read error.

SCOPE	Shield rate limiting is blunt IP-level counting with a fixed 60 s window. It complements but does not replace CF Advanced Rate Limiting (Pro+) which supports per-endpoint rules, sliding windows, and request body matching. The plan recommendations engine surfaces CF Advanced Rate Limiting for API mode customers on Free plan.

D.  Cache Purge Command
Request with X-CloudEdging-Command: PURGE and matching X-CloudEdging-Purge-Token triggers caches.default.delete(request.url) for the specific URL. Token validated against purge_secret in KV brain config. Returns 200 on success, 403 on bad token.

E.  WAF-Lite
URL-decoded query string + pathname tested against four patterns: /<script>/i (XSS), /UNION SELECT/i (SQLi), /OR 1=1/i (SQLi), /\.\.\// (path traversal). Returns HTTP 403 on match. Catches automated scanner noise. CF WAF Managed Rules (Pro+) handle the full threat surface.


6.  Web Handler & Caching (web_handler.js)
Used by STANDARD, SAAS, API, REALTIME, and NEWS modes. Implements plan-physics-aware caching on top of CF edge (caches.default) with stale-while-revalidate support.

6.1  Cache Decision Logic
•	Write methods (POST, PUT, DELETE, PATCH) → never cached
•	API and REALTIME modes → never cached
•	/api/ and /checkout/ path segments → never cached regardless of mode
•	Authenticated requests (session/cart/auth cookies or Bearer/Basic Authorization header) → bypass in ECOMMERCE/STANDARD/IOT modes
•	SAAS/NEWS modes: Cache-Control: no-cache from client → bypass (unless Pro+ plan and static file extension)

6.2  Cache Keys
Free plan: cache key = URL string, method normalised to GET.
Pro and above: cache key = URL + __device=mobile|desktop, derived from User-Agent regex. Prevents mobile-optimised cached assets from being served to desktop users.

6.3  Stale-While-Revalidate
On cache hit, Shield reads X-Shield-Age (timestamp set at cache write time). If the delta exceeds the plan-scaled effective TTL window, it dispatches a background refresh via ctx.waitUntil() and immediately serves the stale response. X-Shield-Status: SWR indicates a stale-but-valid hit. The SWR window itself also scales with plan (Free: 1h, Pro: 2h, Business: 4h, Enterprise: 8h).

6.4  CF Fetch Optimisation Flags
On Pro+ plans when aggressive_cache is active, Shield passes CF fetch options to the origin request:
•	minify: { javascript: true, css: true } — CF minifies JS and CSS in transit
•	polish: "lossy" — CF recompresses images (hint only; zone Polish toggle must be enabled by customer)
•	image: { quality: 85, fit: "scale-down" } — CF image resize for .jpg/.png/.webp/.avif paths


7.  R2 Cache-Aside Mirroring (r2_handler.js)
Used by ECOMMERCE, IOT, NEWS, and STORAGE_MIGRATION modes. Shield mirrors static assets from the customer's origin into their own R2 bucket on first request. Subsequent requests are served from R2 with no origin contact.

7.1  Request Flow
•	Request path tested against 30+ static file extension regex (Gate 1). Non-matching paths fall through to handleWebTraffic().
•	STORAGE_BUCKET binding checked — if missing, fail open to handleWebTraffic() with a console.warn.
•	R2 key = path with leading slash stripped. Reject any key containing .. or // (path traversal guard).
•	env.STORAGE_BUCKET.get(r2Key) called. On R2 HIT: serve directly, headers X-Shield-Storage: R2-HIT + Cache-Control: public, max-age=31536000, immutable. Origin not contacted. An async edge-cache write also fires via ctx.waitUntil() for CDN layer caching.
•	On R2 MISS: fetch from origin, return to user with X-Shield-Status: R2-MISS.
•	Background mirror fires via ctx.waitUntil(): read body as arrayBuffer(), apply Gate 2 checks (size, MIME type, Cache-Control flags), write to R2 with httpMetadata if all pass.

7.2  Gate 1 — Supported Extensions
Images: jpg, jpeg, png, gif, webp, avif, heic, heif, svg, ico
Video: mp4, webm, mov, m4v, avi, mkv
Audio: mp3, flac, wav, ogg, m4a
Web assets: css, js, json, woff, woff2, ttf, eot, otf
Documents / binary: pdf, txt, zip, bin

7.3  Gate 2 — Mirror Eligibility Checks
•	bodySize > 0 (actual body present, not an empty 200)
•	bodySize < 100 MB (prevents runaway R2 writes for large video files not intended for edge caching)
•	MIME type in mirrorable set: image/, video/, audio/, javascript, css, font, woff, pdf, zip, octet-stream
•	Origin did not send Cache-Control: no-store or Cache-Control: private

7.4  Storage Migration Use Case
STORAGE_MIGRATION mode uses the identical R2 handler to migrate hot assets from AWS S3 or GCS origins to R2 with zero upfront cost. The customer keeps S3/GCS as origin. Assets migrate themselves through real traffic over 30–90 days. Cold assets that are never requested remain on S3/GCS and incur no egress or migration cost.

R2 ACTIVATION	Customers deploying ECOMMERCE, IOT, NEWS, or STORAGE_MIGRATION modes who were not previously using R2 become active R2 users through Shield alone. R2 storage and Class B operation counts grow organically with real traffic — no manual data upload required from the customer.


8.  AI Inference Mode (ai_handler.js)
AI_INFERENCE mode proxies AI API calls through Shield and adds a semantic cache layer that eliminates redundant provider calls for similar prompts. Cache lookup uses cosine similarity on prompt embeddings — not exact string matching — so rephrased but equivalent questions return cached responses.

8.1  Semantic Cache Pipeline
•	POST arrives. Provider detected from URL path or X-Provider header.
•	Non-AI paths on an AI_INFERENCE zone fall through to handleWebTraffic().
•	Prompt text extracted from body. Handles: messages[].content (OpenAI/Anthropic format), prompt (legacy completions), input (embeddings API), contents[].parts[].text (Google Gemini format).
•	Prompt truncated to 2000 chars before embedding (stays within 512-token limit of Workers AI model).
•	Embedding generated via Workers AI (@cf/baai/bge-base-en-v1.5 default) or OpenAI text-embedding-3-small (configurable). Workers AI embedding: free, runs at edge, ~2 ms.
•	SEMANTIC_DB.query(embedding, { topK: 1 }). If top match score >= threshold (default 0.92): cache HIT.
•	Cache HIT: fetch full response from CLOUDEDGING_CACHE KV using vector ID as key. Return with X-Shield-AI-Cache: SEMANTIC-HIT and X-Shield-AI-Cache-Score header.
•	Cache MISS: route to provider (via CF AI Gateway if ai_gateway_id configured, else direct to provider origin). Store response in KV + vector in Vectorize via ctx.waitUntil().

8.2  Why KV for Payloads, Vectorize for Vectors
Vectorize metadata limit is 10 KB per vector. AI responses routinely exceed this. Shield stores heavy payloads in KV (no per-value size limit) and stores only the vector + a reference ID in Vectorize. The vector ID is the KV key. When a KV entry expires (configurable TTL via ai_cache_ttl, default 3600 s), the orphaned Vectorize vector safely produces a MISS and gets overwritten on the next similar prompt — no manual cleanup needed.

8.3  Provider Support
Provider	Path Detection	Auth Headers Forwarded
OpenAI	/chat/completions, /embeddings, /v1/models, /images/generations	Authorization: Bearer sk-...
Anthropic	/v1/messages, /v1/complete	x-api-key, anthropic-version
Google Gemini	/models/gemini*, /generativelanguage/*	x-goog-api-key, x-goog-user-project  or  ?key= query param
Vertex AI	/projects/.../locations/.../publishers/...	Authorization: Bearer (GCP token, passthrough)
Azure OpenAI	/openai/deployments/...	api-key header; ?api-version=2024-02-01 appended if absent
AWS Bedrock	/model/anthropic.*, /model/amazon.*	AWS SigV4 headers (passthrough, not re-signed)
Workers AI	X-Provider: workers-ai header	CF account credentials from env bindings

8.4  CF AI Gateway — Optional Layer
When ai_gateway_id is set in KV brain config, all provider traffic routes via gateway.ai.cloudflare.com for CF-level logging, cost tracking, and gateway-side rate limiting. When absent, traffic routes directly to the provider origin. The semantic cache pipeline operates identically either way — AI Gateway is a routing and observability layer, not a requirement for semantic caching to function.

8.5  CF Bindings Used by AI_INFERENCE
Binding Name	CF Product	Used For
SEMANTIC_DB	Vectorize	Stores prompt vectors. Queried on every POST for cosine similarity match. Lightweight — vectors + minimal metadata only (model name, cached_at, prompt_hash). No response payloads.
CLOUDEDGING_CACHE	Workers KV	Stores full AI response payloads keyed by vector ID. Also stores rate limit counters (shared with all modes) and per-request AI analytics events.
AI	Workers AI	Generates prompt embeddings at edge. Default: @cf/baai/bge-base-en-v1.5. Free on Workers Paid plan. ~2 ms latency. Configurable to OpenAI text-embedding-3-small for higher accuracy.


9.  Response Headers Reference
Shield adds diagnostic and security headers to every response. Use these to verify Shield is active in Postman or browser DevTools.

Header	Example Value	Meaning
X-Shield-Status	HIT	Web handler cache result: HIT, MISS, BYPASS, SWR, REFRESH
X-Shield-Version	3.0.0	Shield version string on this customer zone
X-Shield-Client-ID	abc123	CloudEdging client identifier for this deployment
X-Shield-Storage	R2-HIT	R2 handler status: R2-HIT or R2-MISS. Absent on non-static paths (BYPASS).
X-Shield-AI-Cache	SEMANTIC-HIT	AI cache result: SEMANTIC-HIT (served from Vectorize+KV) or MISS (forwarded to provider)
X-Shield-AI-Cache-Score	0.9947	Cosine similarity score (0–1) for SEMANTIC-HIT responses. Useful for threshold tuning.
X-Shield-AI-Provider	openai	AI provider detected for this request
X-Shield-AI-Gateway	my-gw	CF AI Gateway slug used. Absent if Gateway not configured.
X-Shield-AI-Latency	843	Total AI request latency in ms (includes cache lookup + optional provider round-trip)
X-Shield-AI-Stream	true	Present on streaming (SSE) responses. Semantic cache pipeline is skipped for streams.
Strict-Transport-Security	max-age=31536000	HSTS with includeSubDomains and preload. Injected on every response.
X-Content-Type-Options	nosniff	MIME sniffing prevention. All responses.
X-Frame-Options	SAMEORIGIN	Clickjacking prevention. Applied to non-API responses.

Fingerprint headers stripped from every response: Server, X-Powered-By, X-AspNet-Version, X-Runtime, X-Vignette, Via, X-Origin-Server.


10.  Cloudflare Product Impact Summary
Shield is designed to increase CF product adoption, not route around it. Every mode activates CF infrastructure the customer was not previously using.

Scope	CF Products Activated / Revenue Generated
All modes	Workers (1 script, new or increased invocations per customer), KV ×2 (CLOUDEDGING_CONFIG + CLOUDEDGING_CACHE, read/write on every request). Customers on CF Free with zero Workers/KV usage become active Workers + KV users.
R2 modes	R2 (ECOMMERCE, IOT, NEWS, STORAGE_MIGRATION): new R2 bucket per customer. R2 storage and Class B operations grow organically as assets mirror over 30–90 days. Customers not previously using R2 become active R2 users from day one.
AI_INFERENCE	Vectorize (new index, growing vector storage), Workers AI (embedding calls per cache-miss prompt), KV (AI response payload storage). Optional: CF AI Gateway usage for logging and cost tracking.
Plan recommendations	Every deploy returns tailored CF upgrade recommendations (Polish, Mirage, WAF, Bot Management, Argo, Workers Paid). Shield drives organic plan upgrades mapped to measurable customer outcomes and specific CF product revenue lines.
What Shield does NOT do	Replace CF WAF, CF Bot Management, CF Advanced Rate Limiting, or CF DDoS. Shield supplements these products with lightweight edge logic and actively tells customers when to switch on native CF features it cannot replicate.

SUMMARY	CloudEdging Shield converts minimally-active CF accounts into multi-product CF users. A customer on CF Free with no Workers, KV, R2, or Vectorize usage becomes an active consumer of 2–5 CF products within 24 hours of Shield deployment. The plan recommendation engine drives organic CF plan upgrades by surfacing specific, costed actions after every deploy. Shield does not bypass or undermine CF products — it accelerates adoption of them.

