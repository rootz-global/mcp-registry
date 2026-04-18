/**
 * Awesome MCP Servers Ingester
 *
 * Reads a list of GitHub repos (from awesome-mcp-servers lists)
 * and adds them to the registry by fetching repo metadata from GitHub API.
 *
 * Usage:
 *   node src/awesome-ingester.js /tmp/new_repos.txt
 *   node src/awesome-ingester.js /tmp/new_repos.txt --dry-run
 */
import db from './db.js';
import { readFileSync } from 'fs';

const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const RATE_LIMIT_MS = GITHUB_TOKEN ? 100 : 1200; // 5000/hr with token, 60/hr without
let lastRequest = 0;

function slugify(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').substring(0, 120);
}

async function fetchGitHub(path) {
  const now = Date.now();
  if (now - lastRequest < RATE_LIMIT_MS) {
    await new Promise(r => setTimeout(r, RATE_LIMIT_MS - (now - lastRequest)));
  }
  lastRequest = Date.now();

  const headers = { 'Accept': 'application/vnd.github+json', 'User-Agent': 'rootz-mcp-registry' };
  if (GITHUB_TOKEN) headers['Authorization'] = `Bearer ${GITHUB_TOKEN}`;

  const resp = await fetch(`https://api.github.com${path}`, { headers });
  if (resp.status === 403 || resp.status === 429) {
    console.log('  Rate limited — waiting 60s');
    await new Promise(r => setTimeout(r, 60000));
    return fetchGitHub(path);
  }
  if (!resp.ok) return null;
  return resp.json();
}

const UPSERT_SQL = `
  INSERT INTO services (name, slug, title, description, version, website_url, repository_url, repository_source, stars, license, last_pulled, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
  ON DUPLICATE KEY UPDATE
    description = COALESCE(VALUES(description), description),
    stars = COALESCE(VALUES(stars), stars),
    license = COALESCE(VALUES(license), license),
    website_url = COALESCE(VALUES(website_url), website_url),
    last_pulled = NOW(),
    updated_at = NOW()
`;

async function ingestRepo(ownerRepo) {
  const [owner, repo] = ownerRepo.split('/');
  if (!owner || !repo) return null;

  const data = await fetchGitHub(`/repos/${owner}/${repo}`);
  if (!data || !data.name) return null;

  // Generate a name in registry format: io.github.{owner}/{repo}
  const name = `io.github.${owner}/${repo}`;

  // Check for package.json to find npm package name
  let packageName = null;
  const pkgJson = await fetchGitHub(`/repos/${owner}/${repo}/contents/package.json`);
  if (pkgJson && pkgJson.content) {
    try {
      const pkg = JSON.parse(Buffer.from(pkgJson.content, 'base64').toString());
      packageName = pkg.name || null;
    } catch {}
  }

  return {
    name,
    slug: slugify(name),
    title: data.name,
    description: data.description || '',
    version: null,
    website_url: data.homepage || null,
    repository_url: data.html_url,
    repository_source: 'github',
    stars: data.stargazers_count || 0,
    license: data.license?.spdx_id || null,
  };
}

async function main() {
  await db.init();
  const file = process.argv[2];
  const dryRun = process.argv.includes('--dry-run');

  if (!file) {
    console.log('Usage: node src/awesome-ingester.js <repos-file> [--dry-run]');
    process.exit(0);
  }

  const repos = readFileSync(file, 'utf-8').split('\n').filter(l => l.trim());
  console.log(`Ingesting ${repos.length} repos from awesome lists`);
  if (GITHUB_TOKEN) console.log('GitHub token: set (5000 req/hr)');
  else console.log('WARNING: No GITHUB_TOKEN — rate limited to 60 req/hr');
  if (dryRun) console.log('DRY RUN — no database writes');

  let added = 0, skipped = 0, failed = 0;

  for (let i = 0; i < repos.length; i++) {
    const repo = repos[i].trim();
    if (!repo) continue;

    const existing = await db.get('SELECT id FROM services WHERE repository_url LIKE ?', [`%${repo}%`]);
    if (existing) { skipped++; continue; }

    try {
      const data = await ingestRepo(repo);
      if (!data) { failed++; continue; }

      if (!dryRun) {
        await db.run(UPSERT_SQL, [
          data.name, data.slug, data.title, data.description, data.version,
          data.website_url, data.repository_url, data.repository_source,
          data.stars, data.license,
        ]);
        added++;
      } else {
        console.log(`  Would add: ${data.name} (${data.stars}★) — ${(data.description || '').substring(0, 80)}`);
        added++;
      }

      if ((added + skipped + failed) % 25 === 0) {
        console.log(`  Progress: ${added} added, ${skipped} skipped, ${failed} failed (${i+1}/${repos.length})`);
      }
    } catch (e) {
      console.log(`  Error on ${repo}: ${e.message}`);
      failed++;
    }
  }

  console.log(`\n=== Ingestion Complete ===`);
  console.log(`Added:   ${added}`);
  console.log(`Skipped: ${skipped} (already in DB)`);
  console.log(`Failed:  ${failed}`);

  if (!dryRun) {
    const total = await db.get('SELECT COUNT(*) as n FROM services');
    console.log(`Total services now: ${total.n}`);
  }
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
