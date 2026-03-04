const express = require('express');
const path = require('path');
const cors = require('cors');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const DEFAULT_REPO = 'apache/flink';

// =============================================================
// Tiered TTL Cache
// =============================================================
// Different data types have different change frequencies:
//   stats (PR counts)       -> 1 hour
//   PR list (basic info)    -> 10 min
//   PR detail (mergeable)   -> 10 min
//   CI checks (completed)   -> 30 min
//   CI checks (in-progress) -> 5 min (need more frequent updates)
//   Reviews                 -> 10 min
// =============================================================

const TTL = {
  STATS:        60 * 60 * 1000,   // 1 hour
  PR_LIST:      10 * 60 * 1000,   // 10 min
  PR_DETAIL:    10 * 60 * 1000,   // 10 min
  CI_COMPLETED: 30 * 60 * 1000,   // 30 min
  CI_PENDING:    5 * 60 * 1000,   // 5 min
  REVIEWS:      10 * 60 * 1000,   // 10 min
  RATE_LIMIT:        60 * 1000,   // 1 min
};

class TieredCache {
  constructor() {
    this.store = new Map();
    this.hits = 0;
    this.misses = 0;
    setInterval(() => this.cleanup(), 10 * 60 * 1000);
  }

  _entry(key) {
    return this.store.get(key);
  }

  get(key, ttl) {
    const entry = this._entry(key);
    if (!entry) { this.misses++; return null; }
    if (Date.now() - entry.ts > ttl) { this.misses++; return null; }
    this.hits++;
    return entry;
  }

  set(key, data, meta = {}) {
    this.store.set(key, { data, ts: Date.now(), ...meta });
  }

  invalidate(keyPrefix) {
    for (const key of this.store.keys()) {
      if (key.startsWith(keyPrefix)) this.store.delete(key);
    }
  }

  // Search all cached entries matching a key prefix, returning their data
  findAll(keyPrefix) {
    const results = [];
    for (const [key, entry] of this.store) {
      if (key.startsWith(keyPrefix)) {
        results.push({ key, data: entry.data, ts: entry.ts });
      }
    }
    return results;
  }

  cleanup() {
    const maxAge = Math.max(...Object.values(TTL)) * 2;
    const now = Date.now();
    for (const [key, entry] of this.store) {
      if (now - entry.ts > maxAge) this.store.delete(key);
    }
  }

  getStats() {
    const total = this.hits + this.misses;
    return {
      entries: this.store.size,
      hits: this.hits,
      misses: this.misses,
      hitRate: total > 0 ? ((this.hits / total) * 100).toFixed(1) + '%' : 'N/A',
    };
  }
}

const cache = new TieredCache();

// Track gh CLI calls for monitoring
let ghCallCount = 0;
let ghCallsSaved = 0;

// =============================================================
// gh CLI helpers
// =============================================================

/**
 * Execute a gh CLI command and return parsed JSON output.
 * Uses `gh api` for REST API calls.
 *
 * Note: `--paginate` concatenates JSON arrays across pages (e.g. `[...][...]`),
 * so we need to handle that by merging them. For non-array responses or when
 * pagination is not needed, we skip `--paginate`.
 */
async function ghApi(endpoint, options = {}) {
  ghCallCount++;
  const args = ['api', endpoint];

  // Only paginate when explicitly requested
  if (options.paginate) {
    args.push('--paginate');
  }

  if (options.method) {
    args.push('--method', options.method);
  }

  if (options.params) {
    for (const [key, value] of Object.entries(options.params)) {
      args.push('-f', `${key}=${value}`);
    }
  }

  if (options.rawParams) {
    for (const [key, value] of Object.entries(options.rawParams)) {
      args.push('-F', `${key}=${value}`);
    }
  }

  if (options.jq) {
    args.push('--jq', options.jq);
  }

  try {
    const { stdout } = await execFileAsync('gh', args, {
      maxBuffer: 10 * 1024 * 1024,
      timeout: 30000,
    });

    // gh --paginate concatenates JSON arrays: [1,2][3,4] -> need to merge
    // Try normal parse first; if it fails, handle concatenated arrays
    try {
      return JSON.parse(stdout);
    } catch (parseErr) {
      // Handle concatenated JSON arrays from --paginate
      // Convert `[...][...]` to a single merged array
      const trimmed = stdout.trim();
      if (trimmed.startsWith('[')) {
        // Split on `][` boundaries and merge arrays
        const merged = [];
        let depth = 0;
        let start = 0;
        for (let i = 0; i < trimmed.length; i++) {
          if (trimmed[i] === '[') depth++;
          else if (trimmed[i] === ']') {
            depth--;
            if (depth === 0) {
              const chunk = trimmed.slice(start, i + 1);
              merged.push(...JSON.parse(chunk));
              start = i + 1;
            }
          }
        }
        if (merged.length > 0) return merged;
      }
      // Handle concatenated JSON objects from --paginate (e.g. search results)
      // `{...}{...}` -> take first object only (search results include total_count)
      if (trimmed.startsWith('{')) {
        let depth = 0;
        for (let i = 0; i < trimmed.length; i++) {
          if (trimmed[i] === '{') depth++;
          else if (trimmed[i] === '}') {
            depth--;
            if (depth === 0) {
              return JSON.parse(trimmed.slice(0, i + 1));
            }
          }
        }
      }
      throw parseErr;
    }
  } catch (err) {
    if (err.message.startsWith('gh CLI error:')) throw err;
    const stderr = err.stderr || '';
    const msg = stderr || err.message;
    throw new Error(`gh CLI error: ${msg}`);
  }
}

/**
 * Execute a gh CLI command (non-api subcommands like `gh pr list`).
 * Returns parsed JSON.
 */
async function ghCommand(args) {
  ghCallCount++;
  try {
    const { stdout } = await execFileAsync('gh', args, {
      maxBuffer: 10 * 1024 * 1024,
      timeout: 30000,
    });
    return JSON.parse(stdout);
  } catch (err) {
    const stderr = err.stderr || '';
    const msg = stderr || err.message;
    throw new Error(`gh CLI error: ${msg}`);
  }
}

/**
 * Fetch with cache: returns cached data if within TTL, otherwise fetches fresh via gh CLI.
 * Returns { data, fromCache, cacheAge }
 */
async function cachedGhApi(cacheKey, endpoint, ttl, options = {}) {
  const cached = cache.get(cacheKey, ttl);
  if (cached) {
    ghCallsSaved++;
    return { data: cached.data, fromCache: true, cacheAge: Date.now() - cached.ts };
  }
  const data = await ghApi(endpoint, options);
  cache.set(cacheKey, data);
  return { data, fromCache: false, cacheAge: 0 };
}

/**
 * Fetch with cache using gh subcommand.
 */
async function cachedGhCommand(cacheKey, args, ttl) {
  const cached = cache.get(cacheKey, ttl);
  if (cached) {
    ghCallsSaved++;
    return { data: cached.data, fromCache: true, cacheAge: Date.now() - cached.ts };
  }
  const data = await ghCommand(args);
  cache.set(cacheKey, data);
  return { data, fromCache: false, cacheAge: 0 };
}

// =============================================================
// API Routes
// =============================================================

// Get PRs with details
app.get('/api/prs', async (req, res) => {
  try {
    const repo = req.query.repo || DEFAULT_REPO;
    const author = req.query.author || '';
    const state = req.query.state || 'open';
    const keyword = req.query.keyword || '';
    const page = req.query.page || 1;
    const perPage = req.query.per_page || 20;
    const forceRefresh = req.query.force === 'true';

    if (forceRefresh) {
      cache.invalidate(`pr-list:${repo}`);
    }

    let items, totalCount;
    const listCacheKey = `pr-list:${repo}:${author}:${state}:${keyword}:${page}:${perPage}`;

    if (author || keyword) {
      let searchQuery = `is:pr is:${state} repo:${repo}`;
      if (author) searchQuery += ` author:${author}`;
      if (keyword) searchQuery += ` ${keyword} in:title`;
      const endpoint = `search/issues?q=${encodeURIComponent(searchQuery)}&per_page=${perPage}&page=${page}&sort=updated&order=desc`;
      const { data } = await cachedGhApi(listCacheKey, endpoint, TTL.PR_LIST);
      items = data.items || [];
      totalCount = data.total_count || 0;
    } else {
      // Fetch PR list
      const endpoint = `repos/${repo}/pulls?state=${state}&per_page=${perPage}&page=${page}&sort=updated&direction=desc`;
      const { data } = await cachedGhApi(listCacheKey, endpoint, TTL.PR_LIST);
      items = data;

      // Get total count via search API (cached separately)
      const countCacheKey = `pr-count:${repo}:${state}`;
      const countCached = cache.get(countCacheKey, TTL.PR_LIST);
      if (countCached) {
        ghCallsSaved++;
        totalCount = countCached.data;
      } else {
        try {
          const countData = await ghApi(`search/issues?q=${encodeURIComponent(`is:pr is:${state} repo:${repo}`)}&per_page=1`);
          totalCount = countData.total_count || 0;
          cache.set(countCacheKey, totalCount);
        } catch (_) {
          // Fallback: can't determine exact total
          totalCount = items.length;
        }
      }
    }

    // Enrich PRs (each sub-request is individually cached)
    const enrichedItems = await Promise.all(
      items.map(item => enrichPRData(repo, item, forceRefresh))
    );

    const totalPages = Math.ceil(totalCount / perPage);
    res.json({
      total_count: totalCount,
      page: parseInt(page),
      per_page: parseInt(perPage),
      total_pages: totalPages,
      items: enrichedItems,
      _cache: cache.getStats(),
      _gh_calls: { total: ghCallCount, saved: ghCallsSaved },
    });
  } catch (err) {
    console.error('Error fetching PRs:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Enrich a PR with check status, review status, merge conflicts
async function enrichPRData(repo, pr, forceRefresh = false) {
  const prNumber = pr.number;
  const result = {
    number: prNumber,
    title: pr.title,
    state: pr.state,
    html_url: pr.html_url || pr.pull_request?.html_url,
    user: pr.user,
    created_at: pr.created_at,
    updated_at: pr.updated_at,
    labels: pr.labels || [],
    draft: pr.draft || false,
    body: (pr.body || '').substring(0, 500),
    ci_status: 'unknown',
    ci_checks: [],
    review_status: 'pending',
    reviews: [],
    mergeable: null,
    mergeable_state: 'unknown',
    has_conflicts: false,
    commits: 0,
    comments: pr.comments || 0,
    review_comments: pr.review_comments || 0,
    additions: 0,
    deletions: 0,
    changed_files: 0,
    todos: [],
    azure_ci_url: null,
  };

  try {
    const sha = pr.head?.sha || pr.pull_request?.head?.sha || 'HEAD';

    const detailKey = `pr-detail:${repo}:${prNumber}`;
    const checksKey = `ci-checks:${repo}:${sha}`;
    const reviewsKey = `reviews:${repo}:${prNumber}`;

    if (forceRefresh) {
      cache.invalidate(detailKey);
      cache.invalidate(checksKey);
      cache.invalidate(reviewsKey);
    }

    // Determine CI cache TTL based on previous cached state
    let ciTTL = TTL.CI_COMPLETED;
    const prevChecks = cache._entry(checksKey);
    if (prevChecks && prevChecks.data) {
      const runs = prevChecks.data.check_runs || [];
      const hasPending = runs.some(c => c.status === 'in_progress' || c.status === 'queued');
      if (hasPending) {
        ciTTL = TTL.CI_PENDING;
      }
    }

    const commentsKey = `comments:${repo}:${prNumber}`;

    const [prDetailResult, checksResult, reviewsResult, commentsResult] = await Promise.all([
      cachedGhApi(
        detailKey,
        `repos/${repo}/pulls/${prNumber}`,
        TTL.PR_DETAIL
      ).catch(() => null),
      cachedGhApi(
        checksKey,
        `repos/${repo}/commits/${sha}/check-runs?per_page=100`,
        ciTTL
      ).catch(() => null),
      cachedGhApi(
        reviewsKey,
        `repos/${repo}/pulls/${prNumber}/reviews?per_page=100`,
        TTL.REVIEWS
      ).catch(() => null),
      cachedGhApi(
        commentsKey,
        `repos/${repo}/issues/${prNumber}/comments?per_page=100&direction=desc`,
        TTL.PR_DETAIL
      ).catch(() => null),
    ]);

    const prDetail = prDetailResult?.data;
    const checks = checksResult?.data;
    const reviews = reviewsResult?.data;
    const comments = commentsResult?.data;

    if (prDetail) {
      result.mergeable = prDetail.mergeable;
      result.mergeable_state = prDetail.mergeable_state || 'unknown';
      result.has_conflicts = prDetail.mergeable === false;
      result.commits = prDetail.commits || 0;
      result.additions = prDetail.additions || 0;
      result.deletions = prDetail.deletions || 0;
      result.changed_files = prDetail.changed_files || 0;
      result.comments = prDetail.comments || 0;
      result.review_comments = prDetail.review_comments || 0;
      result.draft = prDetail.draft || false;
      result.head_sha = prDetail.head?.sha;
      result.base_ref = prDetail.base?.ref;
    }

    if (checks && checks.check_runs) {
      result.ci_checks = checks.check_runs.map(c => ({
        name: c.name,
        status: c.status,
        conclusion: c.conclusion,
        html_url: c.html_url,
        started_at: c.started_at,
        completed_at: c.completed_at,
      }));

      const conclusions = checks.check_runs.map(c => c.conclusion).filter(Boolean);
      const statuses = checks.check_runs.map(c => c.status);
      if (statuses.some(s => s === 'in_progress' || s === 'queued')) {
        result.ci_status = 'pending';
      } else if (conclusions.every(c => c === 'success' || c === 'skipped' || c === 'neutral')) {
        result.ci_status = conclusions.length > 0 ? 'success' : 'unknown';
      } else if (conclusions.some(c => c === 'failure' || c === 'timed_out')) {
        result.ci_status = 'failure';
      } else {
        result.ci_status = 'unknown';
      }
    }

    if (reviews && Array.isArray(reviews)) {
      const reviewMap = new Map();
      reviews.forEach(r => {
        if (r.user && r.state !== 'COMMENTED') {
          reviewMap.set(r.user.login, {
            user: r.user.login,
            avatar: r.user.avatar_url,
            state: r.state,
            submitted_at: r.submitted_at,
          });
        }
      });
      result.reviews = Array.from(reviewMap.values());

      const hasApproval = result.reviews.some(r => r.state === 'APPROVED');
      const hasChangesRequested = result.reviews.some(r => r.state === 'CHANGES_REQUESTED');
      if (hasChangesRequested) {
        result.review_status = 'changes_requested';
      } else if (hasApproval) {
        result.review_status = 'approved';
      } else {
        result.review_status = 'pending';
      }
    }

    // Extract Azure CI link from flinkbot/flink-ci comments
    if (comments && Array.isArray(comments)) {
      // Look for comments from flinkbot or flink-ci bot that contain Azure links
      // Search from newest to oldest (API returns desc order)
      for (const comment of comments) {
        const login = (comment.user?.login || '').toLowerCase();
        if (login === 'flinkbot' || login === 'flink-ci' || login.includes('flink')) {
          const body = comment.body || '';
          // Match Azure Pipelines URLs
          const azureMatch = body.match(/https?:\/\/dev\.azure\.com\/[^\s)\]]+/i)
            || body.match(/https?:\/\/[^\s)\]]*azure[^\s)\]]*pipelines[^\s)\]]*/i)
            || body.match(/https?:\/\/[^\s)\]]*visualstudio\.com[^\s)\]]*/i);
          if (azureMatch) {
            result.azure_ci_url = azureMatch[0];
            break;
          }
        }
      }
      // Fallback: search all comments for Azure links if bot comment not found
      if (!result.azure_ci_url) {
        for (const comment of comments) {
          const body = comment.body || '';
          const azureMatch = body.match(/https?:\/\/dev\.azure\.com\/[^\s)\]]+/i);
          if (azureMatch) {
            result.azure_ci_url = azureMatch[0];
            break;
          }
        }
      }
    }

    result.todos = buildTodos(result);
  } catch (err) {
    console.error(`Error enriching PR #${prNumber}:`, err.message);
  }

  return result;
}

function buildTodos(pr) {
  const todos = [];
  if (pr.ci_status === 'failure') {
    todos.push({ type: 'ci_failure', severity: 'high', text: 'CI build failed, needs fix' });
  }
  if (pr.ci_status === 'pending') {
    todos.push({ type: 'ci_pending', severity: 'medium', text: 'CI is running' });
  }
  if (pr.has_conflicts) {
    todos.push({ type: 'conflict', severity: 'high', text: 'Merge conflict detected, needs resolution' });
  }
  if (pr.review_status === 'changes_requested') {
    todos.push({ type: 'changes_requested', severity: 'high', text: 'Reviewer requested changes' });
  }
  if (pr.review_status === 'pending' && pr.reviews.length === 0) {
    todos.push({ type: 'no_review', severity: 'medium', text: 'No reviews yet' });
  }
  if (pr.draft) {
    todos.push({ type: 'draft', severity: 'low', text: 'PR is still in draft' });
  }
  if (pr.mergeable_state === 'behind') {
    todos.push({ type: 'behind', severity: 'medium', text: 'Branch is behind base, needs rebase' });
  }
  return todos;
}

// Get repo stats (cached 1 hour)
app.get('/api/stats', async (req, res) => {
  try {
    const repo = req.query.repo || DEFAULT_REPO;
    const author = req.query.author || '';
    const forceRefresh = req.query.force === 'true';

    const statsCacheKey = `stats:${repo}:${author}`;
    if (forceRefresh) {
      cache.invalidate(statsCacheKey);
    }

    const cached = cache.get(statsCacheKey, TTL.STATS);
    if (cached) {
      ghCallsSaved++;
      return res.json({ ...cached.data, _fromCache: true, _cacheAge: Date.now() - cached.ts });
    }

    let openCount = 0;
    let closedCount = 0;
    let mergedCount = 0;

    if (author) {
      const [openData, mergedData, closedData] = await Promise.all([
        ghApi(`search/issues?q=${encodeURIComponent(`is:pr is:open repo:${repo} author:${author}`)}&per_page=1`),
        ghApi(`search/issues?q=${encodeURIComponent(`is:pr is:merged repo:${repo} author:${author}`)}&per_page=1`),
        ghApi(`search/issues?q=${encodeURIComponent(`is:pr is:closed is:unmerged repo:${repo} author:${author}`)}&per_page=1`),
      ]);
      openCount = openData.total_count || 0;
      mergedCount = mergedData.total_count || 0;
      closedCount = closedData.total_count || 0;
    } else {
      const data = await ghApi(`repos/${repo}`);
      openCount = data.open_issues_count || 0;
    }

    const result = {
      open: openCount,
      merged: mergedCount,
      closed: closedCount,
      contributions: mergedCount,
    };

    cache.set(statsCacheKey, result);
    res.json(result);
  } catch (err) {
    console.error('Error fetching stats:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Trigger CI re-run - also invalidate CI cache
app.post('/api/prs/:number/rerun-ci', async (req, res) => {
  try {
    const repo = req.query.repo || DEFAULT_REPO;
    const prNumber = req.params.number;

    const pr = await ghApi(`repos/${repo}/pulls/${prNumber}`);
    const sha = pr.head.sha;

    // Invalidate CI cache for this PR so next refresh gets fresh data
    cache.invalidate(`ci-checks:${repo}:${sha}`);

    const checks = await ghApi(`repos/${repo}/commits/${sha}/check-runs?per_page=100`);
    const failedSuites = new Set();
    checks.check_runs.forEach(c => {
      if (c.conclusion === 'failure' || c.conclusion === 'timed_out') {
        if (c.check_suite?.id) failedSuites.add(c.check_suite.id);
      }
    });

    if (failedSuites.size === 0) {
      return res.json({ message: 'No failed CI jobs to re-run', rerun_count: 0 });
    }

    let rerunCount = 0;
    for (const suiteId of failedSuites) {
      try {
        await ghApi(`repos/${repo}/check-suites/${suiteId}/rerequest`, { method: 'POST' });
        rerunCount++;
      } catch (e) {
        console.error(`Failed to rerun suite ${suiteId}:`, e.message);
      }
    }

    res.json({ message: `Triggered re-run for ${rerunCount} CI job(s)`, rerun_count: rerunCount });
  } catch (err) {
    console.error('Error triggering CI:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Get rate limit info (cached 1 min)
app.get('/api/rate-limit', async (req, res) => {
  try {
    const { data } = await cachedGhApi('rate-limit', 'rate_limit', TTL.RATE_LIMIT);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Enrich a single PR from cached data only (zero API calls)
function enrichFromCache(repo, pr, detailMap) {
  const detail = detailMap.get(pr.number);
  const sha = detail?.head?.sha || pr.head?.sha;
  const checksEntry = sha ? cache._entry(`ci-checks:${repo}:${sha}`) : null;
  const reviewsEntry = cache._entry(`reviews:${repo}:${pr.number}`);

  const result = {
    number: pr.number,
    title: pr.title,
    state: pr.state,
    html_url: pr.html_url || pr.pull_request?.html_url,
    user: pr.user,
    created_at: pr.created_at,
    updated_at: pr.updated_at,
    labels: pr.labels || [],
    draft: pr.draft || false,
    body: (pr.body || '').substring(0, 500),
    ci_status: 'unknown',
    ci_checks: [],
    review_status: 'pending',
    reviews: [],
    mergeable: null,
    mergeable_state: 'unknown',
    has_conflicts: false,
    commits: 0,
    comments: pr.comments || 0,
    review_comments: pr.review_comments || 0,
    additions: 0,
    deletions: 0,
    changed_files: 0,
    todos: [],
    azure_ci_url: null,
  };

  if (detail) {
    result.mergeable = detail.mergeable;
    result.mergeable_state = detail.mergeable_state || 'unknown';
    result.has_conflicts = detail.mergeable === false;
    result.commits = detail.commits || 0;
    result.additions = detail.additions || 0;
    result.deletions = detail.deletions || 0;
    result.changed_files = detail.changed_files || 0;
    result.comments = detail.comments || 0;
    result.review_comments = detail.review_comments || 0;
    result.draft = detail.draft || false;
    result.head_sha = detail.head?.sha;
    result.base_ref = detail.base?.ref;
  }

  if (checksEntry?.data?.check_runs) {
    const checks = checksEntry.data;
    result.ci_checks = checks.check_runs.map(c => ({
      name: c.name,
      status: c.status,
      conclusion: c.conclusion,
      html_url: c.html_url,
      started_at: c.started_at,
      completed_at: c.completed_at,
    }));
    const conclusions = checks.check_runs.map(c => c.conclusion).filter(Boolean);
    const statuses = checks.check_runs.map(c => c.status);
    if (statuses.some(s => s === 'in_progress' || s === 'queued')) {
      result.ci_status = 'pending';
    } else if (conclusions.every(c => c === 'success' || c === 'skipped' || c === 'neutral')) {
      result.ci_status = conclusions.length > 0 ? 'success' : 'unknown';
    } else if (conclusions.some(c => c === 'failure' || c === 'timed_out')) {
      result.ci_status = 'failure';
    }
  }

  if (reviewsEntry?.data && Array.isArray(reviewsEntry.data)) {
    const reviewMap = new Map();
    reviewsEntry.data.forEach(r => {
      if (r.user && r.state !== 'COMMENTED') {
        reviewMap.set(r.user.login, {
          user: r.user.login,
          avatar: r.user.avatar_url,
          state: r.state,
          submitted_at: r.submitted_at,
        });
      }
    });
    result.reviews = Array.from(reviewMap.values());
    const hasApproval = result.reviews.some(r => r.state === 'APPROVED');
    const hasChangesRequested = result.reviews.some(r => r.state === 'CHANGES_REQUESTED');
    if (hasChangesRequested) result.review_status = 'changes_requested';
    else if (hasApproval) result.review_status = 'approved';
  }

  result.todos = buildTodos(result);
  return result;
}

// Search PRs from cache only (no remote API calls)
app.get('/api/prs/search-cache', (req, res) => {
  try {
    const repo = req.query.repo || DEFAULT_REPO;
    const keyword = (req.query.keyword || '').toLowerCase().trim();
    const author = (req.query.author || '').toLowerCase().trim();
    const state = req.query.state || 'open';
    const ciFilter = (req.query.ci_status || '').toLowerCase().trim();
    const reviewFilter = (req.query.review_status || '').toLowerCase().trim();
    const page = parseInt(req.query.page) || 1;
    const perPage = parseInt(req.query.per_page) || 20;

    const hasFilter = keyword || ciFilter || reviewFilter;
    if (!hasFilter) {
      return res.json({ items: [], total_count: 0, from_cache: true, cache_hit: false });
    }

    // Collect all cached PR list entries for this repo
    const cachedEntries = cache.findAll(`pr-list:${repo}`);
    if (cachedEntries.length === 0) {
      return res.json({ items: [], total_count: 0, from_cache: true, cache_hit: false });
    }

    // Gather all unique PRs from cached list data
    const prMap = new Map();
    for (const entry of cachedEntries) {
      const prs = Array.isArray(entry.data) ? entry.data : (entry.data?.items || []);
      for (const pr of prs) {
        if (pr.number && !prMap.has(pr.number)) {
          prMap.set(pr.number, pr);
        }
      }
    }

    // Cached detail/checks/reviews data for enrichment
    const detailEntries = cache.findAll(`pr-detail:${repo}`);
    const detailMap = new Map();
    for (const entry of detailEntries) {
      if (entry.data?.number) {
        detailMap.set(entry.data.number, entry.data);
      }
    }

    // Pre-filter by state, author, keyword (basic fields)
    let allPRs = Array.from(prMap.values());

    if (state !== 'all') {
      allPRs = allPRs.filter(pr => pr.state === state);
    }
    if (author) {
      allPRs = allPRs.filter(pr => (pr.user?.login || '').toLowerCase() === author);
    }
    if (keyword) {
      allPRs = allPRs.filter(pr => {
        const title = (pr.title || '').toLowerCase();
        const number = String(pr.number);
        const body = (pr.body || '').toLowerCase();
        const labels = (pr.labels || []).map(l => l.name.toLowerCase()).join(' ');
        const login = (pr.user?.login || '').toLowerCase();
        return title.includes(keyword) || number.includes(keyword) || body.includes(keyword) || labels.includes(keyword) || login.includes(keyword);
      });
    }

    // Sort by updated_at desc
    allPRs.sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));

    // Enrich ALL matched PRs from cache (no API calls), then filter by CI/Review
    let enrichedAll = allPRs.map(pr => enrichFromCache(repo, pr, detailMap));

    // Post-enrich filters: CI status and Review status
    if (ciFilter) {
      enrichedAll = enrichedAll.filter(item => item.ci_status === ciFilter);
    }
    if (reviewFilter) {
      enrichedAll = enrichedAll.filter(item => item.review_status === reviewFilter);
    }

    const totalCount = enrichedAll.length;
    const totalPages = Math.ceil(totalCount / perPage);
    const startIdx = (page - 1) * perPage;
    const enrichedItems = enrichedAll.slice(startIdx, startIdx + perPage);

    res.json({
      items: enrichedItems,
      total_count: totalCount,
      page,
      per_page: perPage,
      total_pages: totalPages,
      from_cache: true,
      cache_hit: true,
      _cache: cache.getStats(),
      _gh_calls: { total: ghCallCount, saved: ghCallsSaved },
    });
  } catch (err) {
    console.error('Error searching cache:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Cache stats endpoint for frontend display
app.get('/api/cache-stats', (req, res) => {
  const stats = cache.getStats();
  const ttlInfo = {
    stats: `${TTL.STATS / 60000} min`,
    pr_list: `${TTL.PR_LIST / 60000} min`,
    pr_detail: `${TTL.PR_DETAIL / 60000} min`,
    ci_completed: `${TTL.CI_COMPLETED / 60000} min`,
    ci_pending: `${TTL.CI_PENDING / 60000} min`,
    reviews: `${TTL.REVIEWS / 60000} min`,
  };
  res.json({
    cache: stats,
    ttl: ttlInfo,
    gh_calls: { total: ghCallCount, saved: ghCallsSaved },
  });
});

// Force invalidate all cache
app.post('/api/cache/invalidate', (req, res) => {
  cache.store.clear();
  res.json({ message: 'Cache cleared' });
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`PRilot running at http://localhost:${PORT}`);
  console.log(`Using gh CLI for GitHub API access`);
  console.log(`Cache TTLs: stats=${TTL.STATS / 60000}min, pr_list=${TTL.PR_LIST / 60000}min, ci_completed=${TTL.CI_COMPLETED / 60000}min, ci_pending=${TTL.CI_PENDING / 60000}min`);
});
