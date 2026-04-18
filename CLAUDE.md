# MCP Service Registry — Build Instructions

## What This Is

AI-native directory of MCP (Model Context Protocol) services. Built on the Origin pattern: SQLite + Express + flat HTML + `.well-known/ai`. Proves that the Origin discovery model works for any domain — not just SEC company data.

**Parent project:** `origin.rootz.global` (SEC data for public companies, 134K agent queries/week)
**This project:** `mcp.rootz.global` (MCP service directory with tool schemas)

## Quick Start

```bash
npm install

# 1. Pull all MCP servers from the official registry
node src/puller.js all

# 2. Categorize by keywords (no AI needed)
node src/categorizer.js

# 3. Probe live endpoints for tool schemas (top 200 recent)
node src/prober.js --top 200 --concurrent 8

# 4. Build flat HTML pages for crawlers
node src/static-builder.js

# 5. Run the server
node src/server.js   # http://localhost:3500/
```

## Current State (Apr 14, 2026)

| Metric | Value |
|--------|-------|
| Services indexed | **6,078** |
| With Git repo | 5,239 |
| With MCP endpoint | 2,180 |
| With streamable-http | 1,921 |
| Probed | 220 |
| Reachable | 120 |
| Tool schemas captured | 1,372 |
| Categories | 19 |
| Static HTML pages | 6,078 + 19 categories + 1 index |

## Architecture

```
Data flow:
  registry.modelcontextprotocol.io (API)
    → puller.js → services table
    → categorizer.js (keyword match) → service_categories
    → prober.js (live MCP endpoint) → tools table
    → git-extractor.js (fallback) → tools table
    → static-builder.js → /data/static/service/*.html
    → server.js → Express API + /mcp endpoint + HTML serving
```

## File Map

| File | Purpose |
|------|---------|
| `src/db.js` | SQLite schema. Seeds 19 categories on startup. |
| `src/puller.js` | Paginated fetch from registry API. ~500ms rate limit. |
| `src/categorizer.js` | Keyword matching against title + description. |
| `src/prober.js` | MCP initialize + tools/list probe. Handles SSE + JSON responses. |
| `src/server.js` | Express server, port 3500. |
| `src/mcp-handler.js` | Native MCP tools: `mcp_find_service`, `mcp_service_detail`, `mcp_find_tool`, `mcp_categories`, `mcp_stats`. |
| `src/static-builder.js` | Generates one HTML page per service + category indexes + homepage. |
| `data/registry.db` | SQLite database |
| `data/static/` | Generated HTML pages (crawlable) |

## Key Tables

- `services` — core entity, one row per MCP server
- `tools` — extracted tool schemas (name, description, input_schema, source)
- `categories` — 19 seeded categories
- `service_categories` — many-to-many
- `probes` — history of live endpoint checks
- `agent_access_log` — same pattern as Origin

## API Endpoints

| Endpoint | Purpose |
|----------|---------|
| `GET /` | Discovery doc (HTML or JSON based on Accept header) |
| `GET /.well-known/ai` | Machine-readable registry manifest |
| `GET /api/search?q=X` | Full-text search |
| `GET /api/service/:name` | Full service profile with tools |
| `GET /api/tool/:name` | Find services offering a specific tool |
| `GET /api/categories` | List categories |
| `GET /api/services?category=X` | Filter by category |
| `GET /api/stats` | Registry statistics |
| `POST /mcp` | Native MCP endpoint with 5 discovery tools |
| `GET /sitemap.xml` | Sitemap for crawlers |
| `GET /robots.txt` | Welcome all crawlers |
| `GET /static/service/:slug.html` | Flat HTML page (crawlable) |
| `GET /static/category/:slug.html` | Category listing page |

## MCP Tools (for AI agents)

1. **`mcp_find_service`** — Search by keyword and/or category. Returns ranked list.
2. **`mcp_service_detail`** — Full profile with all tool schemas.
3. **`mcp_find_tool`** — Reverse lookup: "which services have tool X?"
4. **`mcp_categories`** — List all categories with counts.
5. **`mcp_stats`** — Registry stats.

Every response includes `agent_hint` — tells the agent what to do next.

## Deployment (Planned)

- Domain: `mcp.rootz.global`
- Server: Oracle Cloud `141.148.25.214` (same as Origin)
- Port: 3500 (Origin uses 3400)
- PM2 process: `mcp-registry`
- Nginx: reverse proxy with SSL via certbot
- Cron: daily puller + categorizer + static rebuild

## Known Limitations

1. **Keyword categorization is coarse** — 1,768 services land in "other". Works for v1. Could use embeddings or LLM classification later.
2. **Probes only cover streamable-http** — stdio servers can't be probed remotely. Need git-extractor for those.
3. **No GitHub stars yet** — popularity signal is registry publish date. Git extractor will add stars.
4. **No auth** — Origin's auth/stripe are not ported. Add when there's traffic.
5. **No access log dashboard** — `/api/metrics` endpoint not built yet.

## Next Steps

1. Build `src/git-extractor.js` — for stdio servers without live endpoints
2. Add GitHub stars as popularity signal
3. Deploy to `mcp.rootz.global`
4. Register the registry itself at registry.modelcontextprotocol.io
5. Publish to Geist message board for Michael

## Origin Pattern Reuse

Files ported from Origin (adapted):
- `db.js` — SQLite + WAL mode + schema pattern
- `server.js` — middleware stack, agent detection, logAccess, content negotiation, .well-known/ai
- `static-builder.js` — HTML generation, Schema.org structured data
- `puller.js` — rate-limited fetch, paginated loop
- `mcp-handler.js` — MCP protocol handling

**Key difference from Origin:** No rate limiting yet, no Stripe integration, no authentication. This is a read-only discovery service for v1.
