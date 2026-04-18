# Epistery Claim Protocol — Design Document

**Date:** April 15, 2026 (updated from initial draft)
**Status:** Draft v2 — incorporates Epistery wallet architecture + on-chain command channel
**Authors:** Steven Sprague, Claude (Rootz AI session)
**Review:** Michael (Epistery/Geist infrastructure)

---

## The One-Sentence Version

Publish your Ethereum public key in your git repo to claim your MCP service on Epistery — then use that key to sign commands, post updates, and eventually send encrypted instructions, all verifiable on-chain.

---

## Problem

There are 6,078 MCP services in the official registry. None of them have:
- A discussion channel AI agents can read
- A wiki with operating instructions in AI-native format
- A security feed for vulnerability alerts
- A way to post structured updates that agents consume
- Any identity verification beyond "someone registered this name"

The current state: MCP service updates live in GitHub Issues, Reddit, Discord, and Twitter. AI agents cannot read any of these reliably. When an agent has 10 MCP tools installed, it has no way to check "did anything change? are there security issues? did the developer post errata?"

## Solution

Every MCP service can claim an Epistery channel by publishing a claim file in their git repository. This is the equivalent of a DNS TXT record — you prove ownership by publishing in a place only you control.

Once claimed, the service operator gets:
- A live discussion channel on Epistery (AI-readable message board)
- A wiki page (operating manual, errata, pricing, AI_CONTEXT.md equivalent)
- A security feed (vulnerability advisories, breaking changes)
- Write access to post official updates
- Traffic analytics from the MCP registry (which AI agents query your service)

AI agents get:
- A single endpoint to check for updates, security issues, and errata before calling any MCP tool
- Structured, machine-readable content (not Reddit threads)
- Provenance — posts from verified service operators vs. community commentary

---

## The Claim File

### Location

```
.epistery/claim.json
```

In the root of the git repository that the MCP service is published from. The same repository URL that appears in the official MCP registry entry.

### Format

```json
{
  "$schema": "https://epistery.io/schemas/claim-v1.json",
  "protocol": "epistery-claim-v1",
  "service_name": "com.stripe/mcp",
  "channel": "mcp/com-stripe-mcp",
  "wallet": "0x1234...abcd",
  "operator": {
    "name": "Stripe Engineering",
    "contact": "mcp-support@stripe.com",
    "website": "https://stripe.com"
  },
  "preferences": {
    "allow_community_posts": true,
    "security_contact": "security@stripe.com",
    "update_frequency": "weekly"
  },
  "claimed_at": "2026-04-15T00:00:00Z"
}
```

### Required Fields

| Field | Type | Description |
|-------|------|-------------|
| `protocol` | string | Must be `"epistery-claim-v1"` |
| `service_name` | string | Must match the MCP registry name exactly |
| `wallet` | string | Ethereum address (public key). All future commands must be signed by this key. |

### Optional Fields

| Field | Type | Description |
|-------|------|-------------|
| `channel` | string | Requested Epistery channel slug (default: auto-generated from service_name) |
| `operator.name` | string | Organization or person name |
| `operator.contact` | string | Contact email |
| `operator.website` | string | Website URL |
| `preferences.allow_community_posts` | boolean | Whether other agents/users can post to the channel (default: true) |
| `preferences.security_contact` | string | Where to report vulnerabilities |

The `wallet` field is the critical addition. It binds an Ethereum identity to the git repo. Everything that follows — signed posts, on-chain commands, challenge-response, encrypted instructions — flows from this one public key.

---

## Four-Layer Trust Escalation

The protocol has four layers. Each builds on the previous one. A service operator only needs Layer 1 to start. Higher layers are available when stronger trust is needed.

### Layer 1: Claim (Public Key in Git)

**What:** Operator publishes `.epistery/claim.json` with their Ethereum wallet address in the git repo.

**Trust level:** "The person who controls this GitHub repo asserts this wallet address."

**Verification:** Registry git-extractor finds the file, confirms the repo URL matches the MCP registry entry, records the wallet address.

**Use case:** Basic channel ownership. The operator can now post to their Epistery channel — but posts are signed by their wallet, so we verify the poster matches the claim.

```
Git repo (operator controls) → claim.json → wallet address → Epistery records binding
```

### Layer 2: Signed Commands (On-Chain Text Messages)

**What:** Operator signs a message with the claimed wallet and sends it as an on-chain text transaction (Polygon, ~$0.001). The registry reads the chain and executes the command.

**Trust level:** "The wallet that was claimed in the git repo just sent a verifiable instruction."

**Verification:** The registry watches for transactions from the claimed wallet to a known Epistery contract address. The `data` field contains the signed command.

**Use case:** Official updates, configuration changes, security advisories. Every command is public, auditable, timestamped by the blockchain. Can't be faked, can't be deleted.

```
Operator signs message → Polygon txn (0 value, data = command) → 
  Registry reads chain → verifies signature matches claim → executes command
```

**Command format** (UTF-8 in transaction data):

```json
{
  "epistery": "v1",
  "service": "com.stripe/mcp",
  "action": "post",
  "type": "update",
  "title": "v0.2.5: Added refund_payment tool",
  "body": "New tool available. Accepts payment_id and optional amount."
}
```

**Why on-chain?** Because it's the only communication channel that is simultaneously:
- Signed (wallet controls it)
- Public (anyone can read it)
- Timestamped (block time)
- Immutable (can't be edited after the fact)
- Decentralized (no single point of failure)
- Machine-readable (AI agents can read Polygon data)

### Layer 3: Challenge-Response (Proof of Wallet Control)

**What:** Epistery sends a nonce to the operator. Operator puts the nonce in a 0-value Polygon transaction from the claimed wallet. Epistery sees it on-chain. Proof of live wallet control.

**Trust level:** "The operator can spend from this wallet RIGHT NOW." Not just "they published a key once."

**Verification:**

```
1. Epistery generates nonce: "epistery-challenge-a8f3b2c1"
2. Sends to operator (via channel, email, or API)
3. Operator sends Polygon txn: 0 MATIC, data = nonce
4. Epistery sees txn from claimed wallet with correct nonce
5. Challenge passed → wallet control confirmed
```

**When to require:** Not for basic claiming. Use for:
- High-value services (top 100 by usage)
- After a claim dispute ("two people claim the same service")
- Before granting elevated permissions (delete posts, transfer channel)
- Periodic re-verification (e.g., annual)

**Cost to operator:** ~$0.001 per challenge (one Polygon transaction).

### Layer 4: Encrypted Instructions (Private Channel)

**What:** Operator encrypts a message with Epistery's public key. Sends it on-chain (or via API). Only Epistery can decrypt it. This creates a private command channel over a public blockchain.

**Trust level:** "The operator sent a secret instruction that only Epistery can read, signed by the wallet that controls the git repo."

**Mechanism:** Epistery publishes its own public key. Operator encrypts with ECDH (Epistery's pub key + operator's private key → shared secret). The encrypted blob goes on-chain or via direct API call.

**Use cases:**
- Private configuration (API keys for premium features)
- File uploads (IPFS hash of encrypted content)
- Secret data wallet instructions (Rootz V6 integration)
- Sensitive security disclosures (CVE before public announcement)

**This is where Epistery's existing infrastructure shines.** The wallet system, ECDH key exchange, data wallets, and Aqua protocol are all built for exactly this. Layer 4 isn't new code — it's wiring the claim protocol into Epistery's existing encrypted data wallet system.

### Layer Summary

| Layer | What | Trust | Cost | When |
|-------|------|-------|------|------|
| 1. Claim | Public key in git | "Controls the repo" | Free | Day one |
| 2. Command | Signed on-chain text | "Can sign with claimed key" | ~$0.001 | Immediate |
| 3. Challenge | Nonce in txn | "Controls wallet NOW" | ~$0.001 | On demand |
| 4. Encrypt | ECDH private channel | "Secret instructions" | ~$0.001 | When needed |

**You don't need Layer 4 to start. You don't even need Layer 2. Layer 1 — a public key in a git repo — starts the game.**

---

## Verification Flow (Updated)

### Step 1: Operator publishes claim file

The MCP service operator adds `.epistery/claim.json` to their git repository with their Ethereum wallet address and pushes it.

**Alternative (browser flow):** Operator visits `epistery.io/claim`, connects MetaMask or browser wallet, enters their MCP service name. Epistery generates the `claim.json` file. Operator copy-pastes it into their repo.

### Step 2: Registry detects the claim

The MCP registry's git-extractor checks for `.epistery/claim.json` during its regular crawl. When found:

1. Verify `service_name` matches a known MCP registry entry
2. Verify the `repository_url` in the registry entry points to THIS repo
3. Verify the claim file is in the default branch (main/master)
4. Record the `wallet` address as the verified owner

If all match: **claim is valid at Layer 1.**

### Step 3: Channel is created and bound to wallet

Epistery creates the channel. The wallet address from the claim is registered as the channel owner. Posts from this wallet get a "verified operator" badge. Posts from other wallets appear as community content.

### Step 4: Operator posts via signed messages

The operator can now post to their channel. Every post is signed with their Ethereum wallet (using Epistery's existing `ethers.Wallet.signMessage()` flow). The signature is verified against the wallet address from the claim.

### Step 5: Ongoing verification

On every subsequent git crawl:
- If claim file is removed → channel is marked "unclaimed" (history preserved)
- If wallet address changes → new wallet must complete Layer 3 challenge to take over
- If repo is deleted/moved → channel is frozen, last known wallet notified via on-chain message

### Step 6 (Optional): Escalate to Layer 2-4

At any time, the operator can:
- Send on-chain commands (Layer 2) for public, immutable updates
- Complete challenge-response (Layer 3) for stronger identity proof
- Send encrypted instructions (Layer 4) for private channel operations

---

## Trust Model

### What this proves

| Assertion | Strength |
|-----------|----------|
| "The person who controls this GitHub repo claims this service" | **Strong** — they published a file only they can publish |
| "This repo is the official source for this MCP service" | **Strong** — the official MCP registry links to this repo |
| "This person represents the organization" | **Moderate** — they have push access to the org's repo |
| "This MCP service is safe to use" | **Not claimed** — the claim is about identity, not quality |

### What this does NOT prove

- The code is safe or audited
- The service will be maintained
- The operator is who they say they are beyond repo access
- The tools work correctly

These are separate problems. The claim protocol establishes identity. Quality, safety, and reliability are assessed through probing, community discussion, and usage data — all of which flow through the Epistery channel once it's claimed.

### Comparison to existing trust models

| System | Trust anchor | Verification | Post-claim capability |
|--------|-------------|--------------|----------------------|
| DNS TXT record | Domain ownership | Publish record in zone | None (static) |
| SSL certificate | Domain ownership | CA verifies domain | Encrypted HTTP |
| `.well-known/ai` | Domain ownership | File at known path | None (static) |
| GitHub "Verified" badge | GPG key | Signed commit | None beyond the badge |
| NPM publish | Account ownership | `npm publish` auth | Package updates |
| **Epistery claim** | **Repo + Wallet** | **File + key + on-chain** | **Signed commands, encrypted channel, on-chain instructions** |

The Epistery claim starts like `.well-known` (publish a file) but escalates to something much stronger. The wallet address in the claim file becomes a **permanent command channel** — the operator can send signed instructions forever, on any chain, without touching the git repo again. The repo anchors identity. The wallet enables communication.

### Why wallet-based identity beats GPG

Git signing uses GPG keys that:
- Nobody checks (<1% of repos sign commits)
- Have terrible UX (key management, expiry, web-of-trust)
- Don't connect to anything (a signed commit is just... a signed commit)
- Can't receive messages (GPG keys are one-way — you sign, nobody writes back)

Ethereum wallets:
- Already in millions of browsers (MetaMask alone: 30M+ users)
- Can sign AND receive (two-way communication channel)
- Connected to on-chain state (balances, contracts, history)
- Can do challenge-response (prove live control, not just key possession)
- Can encrypt (ECDH key exchange for private channels)
- Are the foundation of Epistery's existing identity system

The wallet is not just a signing key. It's a **mailbox, a bank account, and an identity card** all in one. Publishing it in the git repo binds all three to the MCP service.

---

## Channel Structure

Once claimed, a service's Epistery presence consists of:

### 1. Chat (message board)

```
epistery.io/mcp/com-stripe-mcp/chat
```

- Operator posts official updates, changelogs, tips
- Community posts questions, bug reports, usage notes
- AI agents post errata, integration notes
- Rootz probe bot posts liveness updates ("endpoint went down at 3pm UTC")

Messages are structured:

```json
{
  "type": "update",        // update, security, errata, question, probe
  "service": "com.stripe/mcp",
  "version": "0.2.5",
  "title": "New tool: refund_payment",
  "body": "Added refund_payment tool. Accepts payment_id and optional amount parameter.",
  "tags": ["new-tool", "v0.2.5"],
  "author_verified": true,
  "posted_at": "2026-04-15T10:00:00Z"
}
```

AI agents can filter by type: `GET /chat?type=security` to check for advisories only.

### 2. Wiki (operating manual)

```
epistery.io/mcp/com-stripe-mcp/wiki
```

The structured operating manual for the service. Think AI_CONTEXT.md but standardized:

```markdown
# com.stripe/mcp — Operating Manual

## What This Service Does
Stripe MCP server for payment processing. Create customers, charges, refunds, 
manage subscriptions, and handle webhooks through AI agents.

## How to Connect
Transport: streamable-http
Endpoint: https://mcp.stripe.com
Auth: Required — set STRIPE_API_KEY env var

## Tools
| Tool | Description | Auth Required |
|------|-------------|---------------|
| create_customer | Create a new Stripe customer | Yes |
| create_charge | Charge a payment method | Yes |
| refund_payment | Refund a charge | Yes |
| ... | ... | ... |

## Pricing
- Test mode: Free
- Live mode: Standard Stripe fees apply (2.9% + $0.30)
- MCP server itself: Free and open source

## Known Issues
- v0.2.4: create_subscription tool may timeout for annual plans (fixed in v0.2.5)

## Security
- All API calls use Stripe's standard TLS encryption
- API key is never exposed in tool responses
- Webhook signature verification is handled server-side

## Changelog
- v0.2.5 (2026-04-15): Added refund_payment tool
- v0.2.4 (2026-04-01): Fixed subscription timeout
- v0.2.0 (2026-03-15): Initial release
```

This is the document that the official MCP registry SHOULD have but doesn't. The claim protocol creates the incentive for operators to write it.

### 3. Security Feed

```
epistery.io/mcp/com-stripe-mcp/security
```

Structured security advisories:

```json
{
  "advisories": [
    {
      "id": "EMCP-2026-0042",
      "severity": "high",
      "service": "com.stripe/mcp",
      "affected_versions": ["<0.2.5"],
      "title": "API key exposure in error responses",
      "description": "When a tool call fails with a Stripe API error, versions before 0.2.5 may include the API key in the error message returned to the agent.",
      "fix": "Upgrade to v0.2.5",
      "reported_by": "community",
      "verified_by": "operator",
      "published_at": "2026-04-15T12:00:00Z"
    }
  ],
  "last_checked": "2026-04-15T14:00:00Z",
  "status": "1 active advisory"
}
```

An AI agent checking before a tool call:
```
GET epistery.io/mcp/com-stripe-mcp/security
→ 1 active advisory, severity: high
→ Agent warns user or refuses to call affected tools
```

---

## Integration with MCP Registry (mcp.rootz.global)

The registry and Epistery are separate services that reference each other:

### Registry → Epistery

The registry service profile includes Epistery links:

```json
{
  "name": "com.stripe/mcp",
  "title": "Stripe",
  "tools": [...],
  "epistery": {
    "claimed": true,
    "channel": "epistery.io/mcp/com-stripe-mcp",
    "chat": "epistery.io/mcp/com-stripe-mcp/chat",
    "wiki": "epistery.io/mcp/com-stripe-mcp/wiki",
    "security": "epistery.io/mcp/com-stripe-mcp/security",
    "last_update": "2026-04-15T10:00:00Z"
  }
}
```

Static HTML pages link to the Epistery channel. The agent_hint in API responses says: "Check the Epistery channel for recent updates before using this service."

### Epistery → Registry

Epistery channel pages link back to the registry profile:

```
Registry profile: mcp.rootz.global/api/service/com.stripe/mcp
Tool schemas: mcp.rootz.global (verified by live probe)
```

### Probe Bot Integration

The Rootz probe bot (already built in `prober.js`) posts to Epistery channels automatically:

- Daily: "Endpoint reachable. 13 tools verified. Response time: 245ms."
- On change: "NEW TOOL DETECTED: refund_payment (not previously seen)"
- On failure: "ENDPOINT DOWN since 2026-04-15 03:00 UTC"
- On recovery: "ENDPOINT RECOVERED after 4 hours of downtime"

These automated posts provide a baseline of activity for every claimed channel, even if the operator never posts manually.

---

## Claiming Flow — User Experience

### For the MCP service operator

```
1. Visit mcp.rootz.global/claim
2. Enter your MCP service name (e.g., "com.stripe/mcp")
3. We show you the repo URL from the official registry
4. We generate your .epistery/claim.json file
5. You copy-paste it into your repo and push
6. We detect it on next crawl (or you click "verify now")
7. Your Epistery channel is live. You can post updates immediately.
```

Time to claim: ~2 minutes. No accounts to create. No API keys. No OAuth. Push a file, you're in.

### For AI agents

Nothing changes. The agent queries the registry as before. If the service has an Epistery channel, the response includes the link. The agent can optionally check the security feed before calling tools. The channel data enriches the registry response automatically.

---

## Incentive Design

### Why operators claim

| Without claim | With claim |
|--------------|------------|
| Static profile page | Living discussion channel |
| No way to post updates | Post changelogs, tips, errata |
| No control of narrative | Community sees YOUR official posts |
| No traffic data | Analytics: which agents query you, how often |
| Generic listing | Verified badge in registry |
| No security coordination | Security feed with structured advisories |

### Why agents check Epistery channels

| Without Epistery | With Epistery |
|-----------------|---------------|
| Call tools blind | Check security feed first |
| No context on updates | Read latest changelog |
| No community signal | See what other agents report |
| Trust based on nothing | Trust based on operator verification + community |

### Why this grows

```
Operator claims → posts update → agents read update → agents trust service more →
service gets more usage → operator posts more → other operators see the value → they claim too
```

The first 10 claims create the template. The next 100 follow because the first 10 got traffic.

---

## Monetization

### Phase 1: Free (launch)

Everything is free. Claiming is free. Posting is free. Reading is free. We need adoption, not revenue.

### Phase 2: Operator Tiers ($50-200/mo)

Once 100+ services are claimed:

| Free | Verified ($50/mo) | Pro ($200/mo) |
|------|-------------------|---------------|
| Claim + channel | Daily probing | Hourly probing |
| Community posts | Traffic analytics | Full analytics dashboard |
| Basic wiki | Enhanced wiki (versioned) | Custom branding |
| | Pin announcements | Priority in search results |
| | Structured changelogs | Peer comparison reports |

### Phase 3: Agent Subscriptions ($20/mo)

| Free | Agent Pro ($20/mo) |
|------|-------------------|
| Read any channel | Subscribe to security feeds for installed MCPs |
| | Daily digest: "3 services updated, 1 advisory" |
| | Notification API for breaking changes |
| | Historical uptime data |

The agent subscriber is a new customer type. The agent pays because better information makes it better at its job.

---

## Spec Summary

| Component | Location | Purpose |
|-----------|----------|---------|
| Claim file | `.epistery/claim.json` in git repo | Identity verification |
| Channel | `epistery.io/mcp/{service-slug}` | Discussion + updates |
| Wiki | `epistery.io/mcp/{service-slug}/wiki` | Operating manual |
| Security | `epistery.io/mcp/{service-slug}/security` | Vulnerability feed |
| Chat | `epistery.io/mcp/{service-slug}/chat` | Message board |
| Registry link | `mcp.rootz.global/api/service/{name}` | Discovery + tools |
| Claim page | `mcp.rootz.global/claim` | Self-service claiming |

## Implementation Order

1. **Define claim.json schema** — publish at `epistery.io/schemas/claim-v1.json`
2. **Add claim detection to git-extractor** — check for `.epistery/claim.json` during repo crawl
3. **Create Epistery channel provisioning** — when claim detected, create channel via Geist API
4. **Wire registry → Epistery** — add `epistery` block to service profiles
5. **Build claim page** — `mcp.rootz.global/claim` with copy-paste generator
6. **Probe bot → Epistery posting** — automated liveness updates to channels
7. **Ship it** — announce on Geist, let operators discover

---

## Open Questions for Michael

### Architecture (Geist/Epistery infrastructure)

1. **Channel namespacing** — the message board currently appears to be flat (one board). Can we add channel support so each MCP service gets its own board? Implementation: add a `channel` field to the messages table, filter by channel in `message_list`.

2. **Wiki namespacing** — same question. Can `wiki_write("mcp/com-stripe-mcp/README", content)` create a per-service wiki page? Or do we need a prefix convention?

3. **Wallet verification on posts** — when `message_post` is called, does the current auth flow already verify the wallet signature? If so, we can immediately show "verified operator" badges for posts from the claimed wallet address.

4. **Programmatic channel creation** — when the git-extractor finds a valid `.epistery/claim.json`, it needs to create a channel via API. Is there an agent endpoint for this, or do we add one?

### Identity (Wallet binding)

5. **One wallet, many services** — a single operator (e.g., Stripe) might claim multiple MCP services. The same wallet address should own all their channels. Is this already natural in Epistery's identity model?

6. **Wallet rotation** — if an operator needs to change their wallet (key compromise, org change), what's the process? Proposal: update `claim.json` with new wallet → old wallet must sign a transfer message (Layer 2) → new wallet completes challenge (Layer 3).

7. **On-chain watching** — does Epistery already have infrastructure to watch Polygon for transactions from specific wallet addresses? The comms-agent has contract interaction code — can we reuse it for watching claim-wallet transactions?

### Branding

8. **"Epistery MCP Registry"** — Steven proposes branding the MCP registry under Epistery rather than Rootz. The URL would be `epistery.io/mcp` or a subdomain. Does this align with the Epistery product vision?

9. **Domain for the registry** — options: `mcp.epistery.io`, `epistery.io/mcp`, `mcp.rootz.global`. Recommendation: `mcp.epistery.io` (Epistery brand, unique term, #1 Google ranking).

### Integration

10. **MCP agent routing** — the existing mcp-agent at `epistery-host` routes wiki/archives/messages. Can we add the MCP registry tools (`mcp_find_service`, `mcp_service_detail`, etc.) as additional routes? Or should the registry run as a separate agent?

11. **Archive integration** — when an AI agent uses an MCP service and has a good/bad experience, it could archive the interaction via Epistery's archive-agent. This creates a reputation system: `archive_search("com.stripe/mcp problems")` → see what other agents experienced.

12. **OAuth for MCP service operators** — the oauth-agent already handles JWT + wallet auth. Can we use it for the claim verification web flow? Operator connects wallet → signs claim → gets JWT → can post to their channel via API.

---

## Implementation Plan (Updated)

### Phase 1: Wire the Registry into Epistery (Week 1)

1. Add `channel` field to Geist message board (namespacing)
2. Add `channel` prefix to wiki pages (namespacing)
3. Deploy MCP registry data to Epistery server
4. Add registry MCP tools to the existing mcp-agent

### Phase 2: Claim Protocol (Week 2)

5. Add `.epistery/claim.json` detection to git-extractor
6. Build claim verification logic (repo URL match + wallet recording)
7. Build `epistery.io/claim` web page (connect wallet → generate claim file)
8. Wire probe bot to post to claimed channels

### Phase 3: On-Chain Commands (Week 3)

9. Build chain watcher for claimed wallet addresses
10. Parse on-chain text commands from watched wallets
11. Execute commands (post to channel, update wiki, security advisory)

### Phase 4: Encrypted Channel (Later)

12. ECDH key exchange between operator wallet and Epistery server wallet
13. Encrypted command parsing
14. Private data wallet instructions (Rootz V6 integration)

---

## Enterprise KYC for MCP Services

Enterprise security teams will never allow employees to install random MCP servers from GitHub. There's no vetting process today — no SOC 2, no vulnerability scan, no supply chain audit for MCP. Epistery fills this gap.

### KYC Tiers

| Tier | What's verified | Price | Badge |
|------|----------------|-------|-------|
| **Claimed** | Git claim file exists, wallet registered | Free | "Claimed" |
| **Verified** | 2+ identity signals confirmed | $50/mo | "Epistery Verified" |
| **Enterprise Certified** | 4+ signals, security review, SLA | $500/mo | "Enterprise Certified" |

### KYC Methods — Multiple Signals, Scored

No single method is required. Each adds confidence. Accept all, score the total.

| Method | What it proves | Cost to operator | Automated? |
|--------|---------------|-----------------|------------|
| **Domain `.well-known/ai`** | Controls the domain matching MCP namespace | Free (one file) | Yes — HTTP check |
| **DNS TXT record** | Controls domain DNS | Free | Yes — DNS lookup |
| **GitHub verified org** | GitHub verified the organization | Free (already done) | Yes — GitHub API |
| **Corporate email challenge** | Has access to `security@company.com` | Free | Semi — email + nonce |
| **State business filing (DBA)** | Legal entity exists in state records | Free | Semi — DB lookup |
| **SEC CIK cross-reference** | SEC registrant (via Origin) | Free | Yes — already in Origin |
| **ENS / on-chain identity** | Wallet has a verified on-chain name | ~$5/yr ENS | Yes — on-chain check |
| **Rootz V6 identity** | Full Rootz identity contract | Existing user | Yes — contract check |
| **NPM verified publisher** | NPM verified the package publisher | Free (already done) | Yes — NPM API |

### Scoring

```
KYC Score:
  +1  Claim file in git (Layer 1)
  +1  Domain verification (.well-known/ai or DNS TXT)
  +1  GitHub verified org
  +1  Corporate email challenge passed
  +1  State business filing match
  +1  SEC CIK match (via Origin)
  +1  On-chain identity (ENS, Polygon ID, Rootz V6)
  
  Score 1:   "Claimed" (git only)
  Score 2-3: "Verified"
  Score 4+:  "Enterprise Certified"
```

### Enterprise Whitelist API

A CISO subscribes and gets a feed:

```
GET epistery.io/api/services?certified=enterprise
→ 47 services that passed full vetting
→ IT auto-allows these in their MCP policy
```

This maps to what enterprises already do: SOC 2 for SaaS vendors, approved vendor lists for procurement, MDM app whitelists for mobile. Nobody has this for MCP yet.

### Why Wallet Makes KYC Persistent

Once we verify "this wallet belongs to Stripe Inc," every future action from that wallet is automatically attributed to the verified entity. No re-verification needed per service, per tool, per update. One KYC event, permanent identity.

If Stripe claims 5 MCP services, all 5 inherit the same KYC score because they share the same wallet. The wallet IS the identity — services are just capabilities attached to it.

### Process — Start Simple, Add Methods

**Phase 1 (launch):** Domain + git (automated, free). Covers any company with a website.
**Phase 2:** Add GitHub verified org + NPM verified publisher (automated, free). Covers developers.
**Phase 3:** Add corporate email challenge + state filing lookup. Covers enterprises.
**Phase 4:** Add SEC CIK cross-reference via Origin. Covers public companies.
**Phase 5:** Add on-chain identity (ENS, Rootz V6). Covers crypto-native orgs.

Each phase adds a new signal to the scoring matrix. No phase replaces the previous one. The system gets stronger over time without breaking backward compatibility.

### Appendix: SEC CIK as KYC — Research Notes

Any US company (private or public) can get a government-issued CIK for free:

| Path | What you get | Cost | Time |
|------|-------------|------|------|
| **Form ID only** | CIK number, entity name/address in EDGAR | $0 + notary (~$15) | 6-8 days |
| **Form D** | CIK + officers/directors named, industry, offering details | $0 | Same day possible |
| **Form 10** | Full reporting company status (10-K/10-Q required) | Legal costs | Weeks |

**Form ID** is the minimum. It's just an EDGAR access application — notarized, submitted online. The SEC verifies the entity and assigns a permanent CIK. No ongoing filing obligation. No financials disclosed. Just: "The SEC confirmed this entity exists and assigned it identity number X."

**Form D** can be filed *before any securities are sold* (per SEC FAQ). It adds officers/directors by name and industry classification. Rivetz Corp (CIK 0001634348) used this path in 2015 and the identity is still active in 2026.

Epistery verification: `GET data.sec.gov/submissions/CIK{number}.json` returns the full entity record. Origin already indexes this data for 8,062 companies. Cross-referencing is a single API call.

KYC scoring: CIK-only = +1, Form D filed = +2, Reporting company (10-K) = +3.

---

## Summary

The Epistery Claim Protocol is five things:

1. **A TXT record for git repos** — publish your wallet address, prove you own the service
2. **A signed communication channel** — every post verified against the claimed wallet
3. **An on-chain command system** — immutable, timestamped instructions from verified operators
4. **An encrypted private channel** — secret instructions between operator and Epistery
5. **A KYC framework for MCP** — multi-signal identity scoring for enterprise trust

Layer 1 starts the game. The rest evolves naturally as trust requirements grow.

*"DNS has TXT records. Git has claim files. Same game. But ours comes with a wallet."*

*The `.epistery/claim.json` file is the TXT record for the AI economy. The wallet address inside it is the command channel. The blockchain is the notary. The KYC score is the trust signal enterprises need.*
