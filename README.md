# Shield.js v3.0.0 — CloudEdging Edge Worker

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
