# MCP Service Registry

AI-readable directory of MCP (Model Context Protocol) services with tool schemas, live probes, and cryptographic provenance.

**Live at:** https://mcp.epistery.io

Built on the Origin pattern -- the same discovery stack that serves 134K+ agent queries/week for SEC company data at origin.rootz.global.

## What It Does

The official MCP registry at registry.modelcontextprotocol.io stores name, description, and URL. That's a phone book. This registry adds:

- **Tool schemas** — ground-truth tool lists from live MCP endpoint probes
- **Live probes** — reachability status, response times, auth requirements
- **Category index** — 19 categories with service counts
- **AI-native access** — flat HTML for crawlers, JSON API for scripts, MCP endpoint for agents
- **Cryptographic provenance** — every response includes an origin leaf hash

## Architecture

```
Data pipeline:
  registry.modelcontextprotocol.io (official API)
    → puller.js        Paginated fetch, ~6,000 services
    → categorizer.js   Keyword match into 19 categories
    → prober.js        Live MCP endpoint probe (initialize → tools/list)
    → server.js        Express API + MCP endpoint + flat HTML
    → static-builder.js  One HTML page per service (crawlable)

Runtime (as harness child of epistery-scan):
  epistery-scan spawns mcp-registry with UPSTREAM=1 on port 53900
    → scan proxies mcp.epistery.io traffic to the child
    → scan's Search.mjs calls /api/search via harness.query() fan-out
    → @service delegation calls /api/service/:name/tools and /call via harness.post()
```

## Database (MySQL)

Config via epistery Config: `~/.epistery/mcp.epistery.io/config.ini`

```ini
[mysql]
host=127.0.0.1
port=3307
user=admin
password=...
database=mcp_registry
```

OCI MySQL instance at 10.5.0.54:3306, accessed via SSH tunnel through epistery.host to localhost:3307.

| Table | Purpose |
|-------|---------|
| `services` | 6,000+ services with name, description, endpoint, transport, probe status, stars |
| `tools` | Tool schemas captured from probes and git extraction |
| `categories` | 19 predefined categories with service counts |
| `service_categories` | Many-to-many with primary flag and score |
| `probes` | Probe history — status, response time, tools found |
| `agent_access_log` | Every API request logged with agent type, endpoint, IP |

## API

### Discovery

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | Content-negotiated: HTML for browsers, JSON for scripts |
| `/.well-known/ai` | GET | AI Discovery manifest |
| `/api/stats` | GET | Registry statistics |
| `/api/categories` | GET | List all categories with counts |

### Search and Browse

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/search?q={query}` | GET | Full-text search across services |
| `/api/search?category={slug}` | GET | Filter by category |
| `/api/services?category={slug}&limit=&offset=` | GET | Paginated service list |
| `/api/service/{name}` | GET | Full service profile with tool schemas |
| `/api/tool/{name}` | GET | Find which services offer a specific tool |

### Live MCP Proxy

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/service/{name}/tools` | POST | Live `tools/list` call to the service's MCP endpoint |
| `/api/service/{name}/call` | POST | Proxy `tools/call` to the service — `{ tool, arguments }` |

These endpoints open a real MCP session (initialize, notifications/initialized, then tools/list or tools/call) with the target service's `mcp_endpoint`. Only works for services with `transport_type: streamable-http` and a known endpoint.

### Registration

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/register` | GET | Web UI for registering services and tools |
| `/api/services` | POST | Register or update a service (UPSERT) |
| `/api/service/{name}/register-tools` | POST | Submit tool schemas for an existing service |

#### Register a service

```json
POST /api/services
{
  "name": "sec-records.epistery.io",
  "title": "SEC Company Records",
  "description": "Public company filings from SEC EDGAR",
  "category": "finance",
  "mcp_endpoint": "https://sec-records.epistery.io/mcp",
  "transport_type": "streamable-http"
}
```

If `mcp_endpoint` and `transport_type: streamable-http` are provided, the service is auto-probed on registration and tools are extracted.

#### Submit tools manually

```json
POST /api/service/{name}/register-tools
{
  "tools": [
    {
      "name": "create_customer",
      "description": "Creates a new customer record",
      "input_schema": {
        "type": "object",
        "properties": {
          "name": { "type": "string" },
          "email": { "type": "string" }
        }
      }
    }
  ]
}
```

Tools are upserted (matched on service_id + name) with `source: 'manual'`. The service's `tools_count` is updated automatically.

#### Web UI

The `/register` page combines both flows: fill in service details, optionally provide an MCP endpoint for auto-probing, and/or add tools manually with name, description, and JSON input schema.

### Native MCP Endpoint

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/mcp` | POST | MCP JSON-RPC endpoint with 5 discovery tools |

Tools: `mcp_find_service`, `mcp_service_detail`, `mcp_find_tool`, `mcp_categories`, `mcp_stats`

Connect: `claude mcp add rootz-mcp-registry --transport http https://mcp.epistery.io/mcp`

### Other

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check with DB connectivity verification |
| `/robots.txt` | GET | Allows all crawlers |
| `/sitemap.xml` | GET | All services and categories |
| `/static/service/{slug}.html` | GET | Pre-rendered service pages |
| `/static/category/{slug}.html` | GET | Pre-rendered category pages |

## Error Handling

The server is hardened for running as a harness child:

- `process.on('uncaughtException')` — logs and continues
- `process.on('unhandledRejection')` — logs and continues
- Express error middleware — returns 500 JSON instead of crashing
- `/health` verifies DB connectivity (returns 503 if DB is down)

## Key Files

| File | Purpose |
|------|---------|
| `src/server.js` | Express API server, MCP proxy helpers, registration |
| `src/db.js` | MySQL pool, schema creation, category seeding |
| `src/mcp-handler.js` | Native MCP endpoint (5 discovery tools) |
| `src/puller.js` | Batch ingester from official registry |
| `src/categorizer.js` | Keyword-based category assignment |
| `src/prober.js` | Live MCP endpoint prober (initialize + tools/list) |
| `src/static-builder.js` | Pre-renders HTML pages for crawlers |
| `data/static/` | Generated HTML pages |

## Setup

```bash
npm install

# Ensure MySQL is accessible and config.ini is set
node src/db.js          # Test DB connection and create tables

# Ingest data
node src/puller.js      # Pull from official registry
node src/categorizer.js # Assign categories
node src/prober.js      # Probe live endpoints

# Run standalone
npm start               # Port 3500

# Run as harness child (epistery-scan manages this)
UPSTREAM=1 PORT=53900 npm start
```

## Tech Stack

- Node.js, ES modules
- Express 4
- MySQL (OCI, via mysql2/promise)
- `epistery` for config
- Vanilla HTML/CSS (no frameworks)

## Reference

- [Epistery Wiki: MCP Registry](https://geist.social/wiki/EpisteryMCPRegistry) -- design docs and status
- [Epistery Wiki: Claim Protocol](https://geist.social/wiki/EpisteryClaimProtocol) -- wallet-based service ownership
- [AI Discovery Standard](https://rootz.global/ai/standard.md)
- [Origin SEC Registry](https://origin.rootz.global) -- parallel implementation for SEC data
- [MCP Specification](https://modelcontextprotocol.io)

## License

UNLICENSED - Proprietary