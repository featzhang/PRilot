// State
let refreshTimer = null;
let countdownTimer = null;
let countdownValue = 0;
let isLoading = false;
let currentPRs = [];
let lastSuccessTime = null;
let consecutiveFailures = 0;
let lastError = null;

// Pagination state
let currentPage = 1;
let totalPages = 1;
let totalCount = 0;
let perPage = 20; // will be recalculated on init

function calcFitPerPage() {
  const vh = window.innerHeight;
  // Estimate fixed chrome height: header~52 + config-bar~58 + stats~62 + loading~8 + pagination~46 + paddings~30
  const fixedHeight = 256;
  const cardHeight = 88; // approx height per PR card including gap
  const available = vh - fixedHeight;
  const fit = Math.max(3, Math.floor(available / cardHeight));
  return fit;
}

// DOM
const loadingBar = document.getElementById('loadingBar');
const prList = document.getElementById('prList');
const emptyState = document.getElementById('emptyState');
const toastContainer = document.getElementById('toastContainer');
// refreshCountdown is now rendered inside pagination, get it dynamically
function getRefreshCountdown() { return document.getElementById('refreshCountdown'); }
const errorBanner = document.getElementById('errorBanner');

// Init
document.addEventListener('DOMContentLoaded', () => {
  // Calculate default page size to fit one screen
  const fitCount = calcFitPerPage();
  const options = [5, 10, 15, 20, 30, 50];
  let bestSize = options[0];
  for (const opt of options) {
    if (opt <= fitCount) bestSize = opt;
  }
  perPage = bestSize;

  document.getElementById('errorBannerRetry').addEventListener('click', () => {
    hideErrorBanner();
    refreshAll();
  });
  document.getElementById('errorBannerDismiss').addEventListener('click', hideErrorBanner);
  // Load on start - renderPagination will create the refresh controls and call bindRefreshBarEvents + setupAutoRefresh
  refreshAll();
});

function onPageSizeChange() {
  const val = parseInt(document.getElementById('pageSizeSelect').value);
  if (val && val !== perPage) {
    perPage = val;
    currentPage = 1;
    refreshAll();
  }
}

// Client-side keyword filter (instant, no API call)
let keywordFilterTimer = null;
function onKeywordInput() {
  // Instant client-side filter on current loaded PRs
  applyClientFilters();

  // Debounced search: try cache-only first, fallback to remote if no cache results
  clearTimeout(keywordFilterTimer);
  keywordFilterTimer = setTimeout(() => {
    currentPage = 1;
    searchFromCacheOrRemote();
  }, 600);
}

// Called when CI/Review status filter changes
function onFilterChange() {
  // Instant client-side filter
  applyClientFilters();

  // Also try cache search for broader results
  clearTimeout(keywordFilterTimer);
  keywordFilterTimer = setTimeout(() => {
    currentPage = 1;
    searchFromCacheOrRemote();
  }, 300);
}

// Apply all client-side filters (keyword + CI + review) on current loaded PRs
function applyClientFilters() {
  if (currentPRs.length === 0) return;

  const keyword = document.getElementById('keywordInput').value.trim().toLowerCase();
  const ciFilter = document.getElementById('ciStatusFilter').value;
  const reviewFilter = document.getElementById('reviewStatusFilter').value;

  let filtered = currentPRs;

  if (keyword) {
    filtered = filtered.filter(pr =>
      (pr.title || '').toLowerCase().includes(keyword) ||
      ('#' + pr.number).includes(keyword) ||
      (pr.user?.login || '').toLowerCase().includes(keyword) ||
      (pr.labels || []).some(l => l.name.toLowerCase().includes(keyword))
    );
  }
  if (ciFilter) {
    filtered = filtered.filter(pr => pr.ci_status === ciFilter);
  }
  if (reviewFilter) {
    filtered = filtered.filter(pr => pr.review_status === reviewFilter);
  }

  renderPRList(filtered);
}

// Decide whether to search from cache or do remote refresh
function searchFromCacheOrRemote() {
  const keyword = document.getElementById('keywordInput').value.trim();
  const ciFilter = document.getElementById('ciStatusFilter').value;
  const reviewFilter = document.getElementById('reviewStatusFilter').value;

  if (keyword || ciFilter || reviewFilter) {
    searchFromCache();
  } else {
    refreshAll();
  }
}

// Search from server-side cache only (zero API calls to GitHub)
async function searchFromCache() {
  const repo = document.getElementById('repoInput').value.trim() || 'apache/flink';
  const author = document.getElementById('authorInput').value.trim();
  const state = document.getElementById('stateSelect').value;
  const keyword = document.getElementById('keywordInput').value.trim();
  const ciFilter = document.getElementById('ciStatusFilter').value;
  const reviewFilter = document.getElementById('reviewStatusFilter').value;

  try {
    let url = `/api/prs/search-cache?repo=${encodeURIComponent(repo)}&author=${encodeURIComponent(author)}&state=${state}&page=${currentPage}&per_page=${perPage}`;
    if (keyword) url += `&keyword=${encodeURIComponent(keyword)}`;
    if (ciFilter) url += `&ci_status=${encodeURIComponent(ciFilter)}`;
    if (reviewFilter) url += `&review_status=${encodeURIComponent(reviewFilter)}`;

    const data = await safeFetch(url);

    if (data.cache_hit && data.total_count > 0) {
      totalCount = data.total_count;
      totalPages = data.total_pages || 1;
      currentPage = data.page || 1;
      currentPRs = data.items || [];
      renderPRList(currentPRs);
      renderPagination();
      if (data._cache) updateCacheInfo(data._cache, data._gh_calls);
      showToast(`Found ${data.total_count} PR(s) from cache`, 'info');
    } else {
      // Cache miss — fall back to full remote search (only for keyword; CI/Review filters stay client-side)
      refreshAll();
    }
  } catch (err) {
    refreshAll();
  }
}

// Auto Refresh
function setupAutoRefresh() {
  clearInterval(refreshTimer);
  clearInterval(countdownTimer);
  const cdEl = getRefreshCountdown();
  if (cdEl) cdEl.textContent = '';

  const toggleEl = document.getElementById('autoRefreshToggle');
  const enabled = toggleEl ? toggleEl.checked : true;
  if (!enabled) return;

  const intervalEl = document.getElementById('refreshInterval');
  const seconds = intervalEl ? (parseInt(intervalEl.value) || 60) : 60;
  countdownValue = seconds;

  countdownTimer = setInterval(() => {
    countdownValue--;
    const el = getRefreshCountdown();
    if (!el) return;
    if (countdownValue > 0) {
      const statusPrefix = consecutiveFailures > 0 ? '⚠ Last refresh failed · ' : '';
      el.textContent = `${statusPrefix}Auto refresh in ${countdownValue}s`;
      el.className = 'refresh-countdown' + (consecutiveFailures > 0 ? ' refresh-countdown-warn' : '');
    } else {
      el.textContent = 'Refreshing...';
      el.className = 'refresh-countdown';
    }
  }, 1000);

  refreshTimer = setInterval(() => {
    countdownValue = seconds;
    refreshAll();
  }, seconds * 1000);
}

function setLoading(loading) {
  isLoading = loading;
  loadingBar.classList.toggle('active', loading);
}

async function safeFetch(url) {
  const resp = await fetch(url);
  if (!resp.ok) {
    let errMsg = `HTTP ${resp.status}`;
    try {
      const body = await resp.json();
      if (body.error) errMsg = body.error;
    } catch (_) {
      try { errMsg += ': ' + await resp.text(); } catch (_2) {}
    }
    throw new Error(errMsg);
  }
  return resp.json();
}

function classifyError(err) {
  const msg = (err.message || '').toLowerCase();
  if (msg.includes('rate limit') || msg.includes('403')) {
    return { icon: '🚫', title: 'API Rate Limit Exceeded', detail: 'GitHub API rate limit reached. Please wait or ensure gh CLI is authenticated (gh auth login).' };
  }
  if (msg.includes('network') || msg.includes('failed to fetch') || msg.includes('load failed')) {
    return { icon: '🔌', title: 'Network Connection Failed', detail: 'Unable to connect to server. Please check your network connection or if the service is running.' };
  }
  if (msg.includes('timeout') || msg.includes('timed out')) {
    return { icon: '⏱', title: 'Request Timeout', detail: 'Server response timed out. The network may be unstable or GitHub API is slow.' };
  }
  if (msg.includes('404')) {
    return { icon: '🔍', title: 'Repository Not Found', detail: 'Please check if the repository name is correct (format: owner/repo).' };
  }
  if (msg.includes('401') || msg.includes('bad credentials')) {
    return { icon: '🔑', title: 'Authentication Failed', detail: 'gh CLI is not authenticated. Run "gh auth login" to authenticate.' };
  }
  if (msg.includes('500') || msg.includes('502') || msg.includes('503')) {
    return { icon: '🔧', title: 'GitHub Service Error', detail: 'GitHub API server error. Please try again later.' };
  }
  return { icon: '❌', title: 'Refresh Failed', detail: err.message || 'An unknown error occurred' };
}

function showErrorBanner(err) {
  const info = classifyError(err);
  document.getElementById('errorBannerIcon').textContent = info.icon;
  document.getElementById('errorBannerTitle').textContent = info.title;

  let detailText = info.detail;
  if (consecutiveFailures > 1) {
    detailText += ` (${consecutiveFailures} consecutive failures)`;
  }
  if (lastSuccessTime) {
    detailText += ` · Last success: ${formatTime(lastSuccessTime)}`;
  }
  document.getElementById('errorBannerDetail').textContent = detailText;

  errorBanner.classList.add('visible');
}

function hideErrorBanner() {
  errorBanner.classList.remove('visible');
}

function formatTime(date) {
  const now = new Date();
  const diffMs = now - date;
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMs / 3600000);
  if (diffHours < 24) return `${diffHours}h ago`;
  return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
}

// Fetch data. force=true bypasses server cache.
async function refreshAll(force = false) {
  if (isLoading) return;
  setLoading(true);

  const repo = document.getElementById('repoInput').value.trim() || 'apache/flink';
  const author = document.getElementById('authorInput').value.trim();
  const state = document.getElementById('stateSelect').value;
  const keyword = document.getElementById('keywordInput').value.trim();
  const forceParam = force ? '&force=true' : '';
  const keywordParam = keyword ? `&keyword=${encodeURIComponent(keyword)}` : '';

  try {
    const [statsData, prsData] = await Promise.all([
      safeFetch(`/api/stats?repo=${encodeURIComponent(repo)}&author=${encodeURIComponent(author)}${forceParam}`),
      safeFetch(`/api/prs?repo=${encodeURIComponent(repo)}&author=${encodeURIComponent(author)}&state=${state}&page=${currentPage}&per_page=${perPage}${forceParam}${keywordParam}`),
    ]);

    if (statsData.error) throw new Error(statsData.error);
    if (prsData.error) throw new Error(prsData.error);

    // Update pagination state
    totalCount = prsData.total_count || 0;
    totalPages = prsData.total_pages || 1;
    currentPage = prsData.page || 1;

    updateStats(statsData, prsData);
    currentPRs = prsData.items || [];
    // Apply client-side filters (CI/Review status) if active, otherwise render all
    applyClientFilters();
    renderPagination();

    // Update cache info display
    updateCacheInfo(prsData._cache, prsData._gh_calls);

    // Success: reset error state
    consecutiveFailures = 0;
    lastError = null;
    lastSuccessTime = new Date();
    hideErrorBanner();

    // Fetch rate limit (non-critical)
    fetch('/api/rate-limit').then(r => r.json()).then(data => {
      const core = data.resources?.core;
      if (core) {
        document.getElementById('rateLimitInfo').textContent = `API: ${core.remaining}/${core.limit}`;
        if (core.remaining < 10) {
          showToast(`⚠ API quota running low (${core.remaining}/${core.limit})`, 'error');
        }
      }
    }).catch(() => {});

    // Fetch latest gh CLI call stats (non-critical)
    fetch('/api/cache-stats').then(r => r.json()).then(data => {
      if (data.gh_calls) {
        updateApiCallsInfo(data.gh_calls);
      }
    }).catch(() => {});
  } catch (err) {
    consecutiveFailures++;
    lastError = err;
    showErrorBanner(err);
    showToast('Refresh failed: ' + err.message, 'error');
  } finally {
    setLoading(false);
    const seconds = parseInt(document.getElementById('refreshInterval').value) || 60;
    countdownValue = seconds;
  }
}

function forceRefreshAll() {
  refreshAll(true);
}

// Pagination
function goToPage(page) {
  if (page < 1 || page > totalPages || page === currentPage) return;
  currentPage = page;
  refreshAll();
}

function resetAndRefresh() {
  currentPage = 1;
  refreshAll();
}

function renderPagination() {
  const container = document.getElementById('paginationContainer');
  if (!container) return;

  container.style.display = 'flex';

  const pageSizeOptions = [5, 10, 15, 20, 30, 50];
  const pageSizeHtml = `<div class="pagination-page-size">
    <span>Page Size</span>
    <select id="pageSizeSelect" onchange="onPageSizeChange()">
      ${pageSizeOptions.map(n => `<option value="${n}" ${n === perPage ? 'selected' : ''}>${n}</option>`).join('')}
    </select>
  </div>`;

  const autoRefreshChecked = document.getElementById('autoRefreshToggle')?.checked ?? true;
  const intervalVal = document.getElementById('refreshInterval')?.value ?? '60';

  const refreshBarHtml = `<div class="pagination-refresh-bar">
    <div class="auto-refresh-toggle">
      <label class="switch">
        <input type="checkbox" id="autoRefreshToggle" ${autoRefreshChecked ? 'checked' : ''}>
        <span class="slider"></span>
      </label>
      <span class="refresh-label">Auto</span>
      <select id="refreshInterval" class="interval-select">
        <option value="30" ${intervalVal === '30' ? 'selected' : ''}>30s</option>
        <option value="60" ${intervalVal === '60' ? 'selected' : ''}>60s</option>
        <option value="120" ${intervalVal === '120' ? 'selected' : ''}>2min</option>
        <option value="300" ${intervalVal === '300' ? 'selected' : ''}>5min</option>
      </select>
    </div>
    <div class="refresh-countdown" id="refreshCountdown"></div>
    <button class="btn btn-sm btn-refresh" onclick="refreshAll()" title="Refresh (cached)">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
      Refresh
    </button>
    <button class="btn btn-sm btn-refresh btn-force-refresh" onclick="forceRefreshAll()" title="Force refresh">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 2v6h-6"/><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M3 22v-6h6"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/></svg>
      Force
    </button>
  </div>`;

  if (totalPages <= 1) {
    const infoText = totalCount > 0 ? `Showing 1-${totalCount} of ${totalCount}` : '';
    container.innerHTML = `
      <div class="pagination-row">
        <div class="pagination-left">${pageSizeHtml}${infoText ? `<div class="pagination-info">${infoText}</div>` : ''}</div>
        ${refreshBarHtml}
        <div class="pagination-controls"></div>
      </div>
    `;
    bindRefreshBarEvents();
    restoreCountdownText();
    return;
  }

  const startItem = (currentPage - 1) * perPage + 1;
  const endItem = Math.min(currentPage * perPage, totalCount);

  let pages = [];
  const maxVisible = 7;

  if (totalPages <= maxVisible) {
    for (let i = 1; i <= totalPages; i++) pages.push(i);
  } else {
    pages.push(1);
    if (currentPage > 3) pages.push('...');

    let start = Math.max(2, currentPage - 1);
    let end = Math.min(totalPages - 1, currentPage + 1);

    if (currentPage <= 3) { start = 2; end = 4; }
    if (currentPage >= totalPages - 2) { start = totalPages - 3; end = totalPages - 1; }

    for (let i = start; i <= end; i++) pages.push(i);

    if (currentPage < totalPages - 2) pages.push('...');
    pages.push(totalPages);
  }

  container.innerHTML = `
    <div class="pagination-row">
      <div class="pagination-left">
        ${pageSizeHtml}
        <div class="pagination-info">Showing ${startItem}-${endItem} of ${totalCount}</div>
      </div>
      ${refreshBarHtml}
      <div class="pagination-controls">
        <button class="pagination-btn" onclick="goToPage(${currentPage - 1})" ${currentPage === 1 ? 'disabled' : ''}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"/></svg>
        </button>
        ${pages.map(p => {
          if (p === '...') return '<span class="pagination-ellipsis">...</span>';
          return `<button class="pagination-btn ${p === currentPage ? 'active' : ''}" onclick="goToPage(${p})">${p}</button>`;
        }).join('')}
        <button class="pagination-btn" onclick="goToPage(${currentPage + 1})" ${currentPage === totalPages ? 'disabled' : ''}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>
        </button>
      </div>
    </div>
  `;

  bindRefreshBarEvents();
  restoreCountdownText();
}

let refreshBarBound = false;
function bindRefreshBarEvents() {
  const toggle = document.getElementById('autoRefreshToggle');
  const interval = document.getElementById('refreshInterval');
  if (toggle) toggle.addEventListener('change', setupAutoRefresh);
  if (interval) interval.addEventListener('change', setupAutoRefresh);
  if (!refreshBarBound) {
    refreshBarBound = true;
    setupAutoRefresh();
  }
}

function restoreCountdownText() {
  const el = getRefreshCountdown();
  if (!el) return;
  const toggleEl = document.getElementById('autoRefreshToggle');
  const enabled = toggleEl ? toggleEl.checked : true;
  if (!enabled) { el.textContent = ''; return; }
  if (countdownValue > 0) {
    const statusPrefix = consecutiveFailures > 0 ? '⚠ Last refresh failed · ' : '';
    el.textContent = `${statusPrefix}Auto refresh in ${countdownValue}s`;
    el.className = 'refresh-countdown' + (consecutiveFailures > 0 ? ' refresh-countdown-warn' : '');
  } else {
    el.textContent = 'Refreshing...';
    el.className = 'refresh-countdown';
  }
}

function updateCacheInfo(cacheStats, ghCalls) {
  const el = document.getElementById('cacheInfo');
  if (!el) return;
  if (!cacheStats) { el.textContent = ''; return; }
  el.textContent = `Cache: ${cacheStats.entries} entries · Hit rate ${cacheStats.hitRate}${ghCalls ? ` · ${ghCalls.saved} gh calls saved` : ''}`;
  el.title = `Cache entries: ${cacheStats.entries}\nHits: ${cacheStats.hits}\nMisses: ${cacheStats.misses}\nHit rate: ${cacheStats.hitRate}${ghCalls ? `\nTotal gh CLI calls: ${ghCalls.total}\nSaved calls: ${ghCalls.saved}` : ''}`;

  // Update gh CLI calls display
  updateApiCallsInfo(ghCalls);
}

function updateApiCallsInfo(ghCalls) {
  const el = document.getElementById('apiCallsInfo');
  if (!el) return;
  if (!ghCalls) { el.textContent = 'GH Calls: -'; return; }
  el.textContent = `GH Calls: ${ghCalls.total}`;
  el.title = `Total gh CLI calls: ${ghCalls.total}\nCalls saved by cache: ${ghCalls.saved}`;
}

function updateStats(stats, prsData) {
  document.getElementById('openCount').textContent = stats.open || 0;
  document.getElementById('mergedCount').textContent = stats.merged || stats.contributions || 0;
  document.getElementById('closedCount').textContent = stats.closed || 0;

  // Count todos
  const items = prsData.items || [];
  let todoCount = 0;
  items.forEach(pr => {
    todoCount += (pr.todos || []).length;
  });
  document.getElementById('todoCount').textContent = todoCount;
}

function renderPRList(prs) {
  if (!prs || prs.length === 0) {
    prList.innerHTML = `
      <div class="empty-state">
        <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.3">
          <path d="M6 3v12"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>
        </svg>
        <p>No matching PRs found</p>
      </div>`;
    return;
  }

  prList.innerHTML = prs.map(pr => renderPRCard(pr)).join('');
}

function renderPRCard(pr) {
  const todos = pr.todos || [];
  const highTodo = todos.some(t => t.severity === 'high');
  const mediumTodo = todos.some(t => t.severity === 'medium');
  const cardClass = highTodo ? 'has-high-todo' : mediumTodo ? 'has-medium-todo' : '';

  const mergeIcon = pr.mergeable === null ? '⏳' : pr.mergeable ? '✅' : '❌';
  const commentCount = (pr.comments || 0) + (pr.review_comments || 0);

  const todosHtml = todos.length > 0
    ? `<span class="pr-inline-todos">${todos.map(t => `<span class="todo-inline severity-${t.severity}"><span class="todo-dot"></span>${escapeHtml(t.text)}</span>`).join('')}</span>`
    : '';

  return `
    <div class="pr-card ${cardClass}">
      <div class="pr-header">
        <div class="pr-title-area">
          <div class="pr-title-row">
            <span class="pr-number">#${pr.number}</span>
            <a class="pr-title" href="${pr.html_url}" target="_blank" rel="noopener">${escapeHtml(pr.title)}</a>
          </div>
          <div class="pr-meta">
            <span class="pr-meta-item">
              ${pr.user ? `<img class="pr-author-avatar" src="${pr.user.avatar_url}" alt="${pr.user.login}"> ${pr.user.login}` : ''}
            </span>
            <span class="pr-meta-item">${timeAgo(pr.updated_at)}</span>
            <span class="pr-meta-item"><span class="diff-stat diff-add">+${pr.additions || 0}</span> <span class="diff-stat diff-del">-${pr.deletions || 0}</span></span>
            <span class="pr-meta-item">${pr.changed_files || 0} files</span>
            <span class="pr-meta-item">${mergeIcon} ${commentCount > 0 ? `💬${commentCount}` : ''}</span>
            ${renderLabelsInline(pr.labels)}
          </div>
        </div>
        <div class="pr-status-badges">
          ${pr.draft ? '<span class="badge badge-draft">Draft</span>' : ''}
          ${renderCIBadge(pr.ci_status)}
          ${renderReviewBadge(pr.review_status)}
          ${pr.has_conflicts ? '<span class="badge badge-conflict">Conflict</span>' : ''}
          ${pr.mergeable_state === 'behind' ? '<span class="badge badge-pending">Rebase</span>' : ''}
        </div>
      </div>
      ${todosHtml}
      <div class="pr-footer">
        <div class="pr-actions">
          <a class="btn btn-sm" href="${pr.html_url}" target="_blank" rel="noopener">View</a>
          <a class="btn btn-sm" href="${pr.html_url}/files" target="_blank" rel="noopener">Files</a>
          ${pr.ci_status === 'failure' ? `<button class="btn btn-sm btn-danger" onclick="triggerCI(${pr.number})">Re-run CI</button>` : ''}
          <a class="btn btn-sm" href="${pr.azure_ci_url || (pr.html_url + '/checks')}" target="_blank" rel="noopener">${pr.azure_ci_url ? 'Azure CI' : 'CI'}</a>
        </div>
        ${renderCIChecksToggle(pr)}
      </div>
      ${renderCIChecksExpand(pr)}
    </div>
  `;
}

function renderLabelsInline(labels) {
  if (!labels || labels.length === 0) return '';
  return labels.map(l => {
    const color = l.color || '6e7681';
    const textColor = getContrastColor(color);
    return `<span class="pr-label-inline" style="background:#${color};color:${textColor}">${escapeHtml(l.name)}</span>`;
  }).join('');
}

function renderCIChecksToggle(pr) {
  const checks = pr.ci_checks || [];
  if (checks.length === 0) return '';
  const succeeded = checks.filter(c => c.conclusion === 'success' || c.conclusion === 'skipped').length;
  const failed = checks.filter(c => c.conclusion === 'failure' || c.conclusion === 'timed_out').length;
  return `<button class="ci-toggle-btn" onclick="toggleCIChecks(this)">${succeeded}✓${failed ? ' ' + failed + '✗' : ''} / ${checks.length} checks ▾</button>`;
}

function renderLabels(labels) {
  if (!labels || labels.length === 0) return '';
  return `<div class="pr-labels">${labels.map(l => {
    const color = l.color || '6e7681';
    const textColor = getContrastColor(color);
    return `<span class="pr-label" style="background:#${color};color:${textColor}">${escapeHtml(l.name)}</span>`;
  }).join('')}</div>`;
}

function renderCIBadge(status) {
  const map = {
    success: '<span class="badge badge-success"><span class="badge-dot"></span>CI Passed</span>',
    failure: '<span class="badge badge-failure"><span class="badge-dot"></span>CI Failed</span>',
    pending: '<span class="badge badge-pending"><span class="badge-dot"></span>CI Running</span>',
    unknown: '<span class="badge badge-unknown"><span class="badge-dot"></span>CI Unknown</span>',
  };
  return map[status] || map.unknown;
}

function renderCIText(status) {
  const map = {
    success: '✅ Passed',
    failure: '❌ Failed',
    pending: '⏳ Running',
    unknown: '❓ Unknown',
  };
  return map[status] || map.unknown;
}

function renderReviewBadge(status) {
  const map = {
    approved: '<span class="badge badge-approved">✓ Approved</span>',
    changes_requested: '<span class="badge badge-changes">✗ Changes Requested</span>',
    pending: '<span class="badge badge-pending">Pending Review</span>',
  };
  return map[status] || '';
}

function renderReviewText(status, reviews) {
  const reviewers = (reviews || []).map(r => r.user).join(', ');
  const map = {
    approved: `✅ Approved${reviewers ? ' by ' + reviewers : ''}`,
    changes_requested: `❌ Changes requested${reviewers ? ' by ' + reviewers : ''}`,
    pending: '⏳ Pending review',
  };
  return map[status] || 'Unknown';
}

function renderCIChecksExpand(pr) {
  const checks = pr.ci_checks || [];
  if (checks.length === 0) return '';

  return `
    <div class="ci-checks-list">
      ${checks.map(c => {
        const icon = getCICheckIcon(c);
        return `<div class="ci-check-item"><span class="ci-check-icon ${icon.cls}">${icon.svg}</span><a href="${c.html_url || '#'}" target="_blank" rel="noopener">${escapeHtml(c.name)}</a><span style="margin-left:auto;font-size:11px;color:var(--text-muted)">${c.conclusion || c.status || ''}</span></div>`;
      }).join('')}
    </div>
  `;
}

function getCICheckIcon(check) {
  if (check.conclusion === 'success' || check.conclusion === 'skipped') {
    return { cls: 'ci-check-success', svg: '✓' };
  }
  if (check.conclusion === 'failure' || check.conclusion === 'timed_out') {
    return { cls: 'ci-check-failure', svg: '✗' };
  }
  if (check.status === 'in_progress' || check.status === 'queued') {
    return { cls: 'ci-check-pending', svg: '◌' };
  }
  return { cls: 'ci-check-neutral', svg: '○' };
}

function toggleCIChecks(btn) {
  const card = btn.closest('.pr-card');
  const list = card.querySelector('.ci-checks-list');
  if (!list) return;
  list.classList.toggle('open');
  btn.classList.toggle('open');
}

// Actions
async function triggerCI(prNumber) {
  const repo = document.getElementById('repoInput').value.trim() || 'apache/flink';
  showToast('Triggering CI re-run...', 'info');

  try {
    const resp = await fetch(`/api/prs/${prNumber}/rerun-ci?repo=${encodeURIComponent(repo)}`, {
      method: 'POST',
    });
    const data = await resp.json();
    if (resp.ok) {
      showToast(data.message || 'CI triggered', 'success');
    } else {
      showToast(data.error || 'Trigger failed', 'error');
    }
  } catch (err) {
    showToast('Failed to trigger CI: ' + err.message, 'error');
  }
}

// Helpers
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function timeAgo(dateStr) {
  if (!dateStr) return '';
  const now = new Date();
  const date = new Date(dateStr);
  const diffMs = now - date;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 30) return `${diffDays}d ago`;
  return date.toLocaleDateString('en-US');
}

function getContrastColor(hexcolor) {
  const r = parseInt(hexcolor.substr(0, 2), 16);
  const g = parseInt(hexcolor.substr(2, 2), 16);
  const b = parseInt(hexcolor.substr(4, 2), 16);
  const yiq = ((r * 299) + (g * 587) + (b * 114)) / 1000;
  return yiq >= 128 ? '#000' : '#fff';
}

function showToast(message, type = 'info') {
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  toastContainer.appendChild(toast);
  setTimeout(() => toast.remove(), 4000);
}

function toggleHelpModal() {
  const overlay = document.getElementById('helpOverlay');
  if (overlay) overlay.classList.toggle('visible');
}
