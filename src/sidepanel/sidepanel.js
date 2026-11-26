const X_URL = /^https:\/\/(x\.com|twitter\.com)\//;
const TYPES = ['tweets', 'replies', 'reposts', 'media', 'likes', 'unfollow'];
const RENDER_BATCH = 120;
const SESSION_KEY = 'xbcPanelSessionV2';

const $ = (id) => document.getElementById(id);

let activeTab = null;
let activeAccount = null;
let currentType = 'tweets';
let viewMode = 'idle'; // 'idle' | 'scanning' | 'paused' | 'stopped' | 'review' | 'deleting' | 'done'
let activeScanType = null;
let cleanupRunning = false;
let cleanupPaused = false;
let cleanupType = null;
let pollTimer = null;
let pollMisses = 0;
let doneCollapseTimer = null;
let renderedCount = RENDER_BATCH;

let whitelist = new Set();
let profileMetaCache = {};
let settingsOpen = false;
let accountRetryTimer = null;
let accountRetryIndex = 0;
let lastDetectStatus = null; // null | 'loading' | 'logged_out' | 'error'
let defaultAutoCsv = true;
let defaultCleanupSpeed = 'safe';
let currentSort = 'newest';
let tabCache = Object.fromEntries(TYPES.map(t => [t, {
  items: [],
  estimatedTotal: null,
  scannedAt: null,
  scanDurationSec: null,
  replyScope: 'fast',
  mediaScope: 'photo',
  scanState: 'idle' // 'idle' | 'paused' | 'stopped' | 'done'
}]));

// Filter & selection state
let datePreset = 'all';
let preDatePreset = 'all';
let filterNotFollowingBack = false;
let filterNoAvatar = false;
let lastClickedIndex = null;
let cachedFiltered = [];

// Bottom sheet & Done state
let sheetMode = 'selected'; // 'selected' | 'bulkAll' | 'retry'
let requireTypedDelete = false;
let lastDoneResult = null; // { jobId, type, succeeded, failedItems, backup }

const isPermanentType = (type = currentType) => type === 'tweets' || type === 'replies' || type === 'media';
const isFollowingType = (type = currentType) => type === 'unfollow';
const isMediaType = (type = currentType) => type === 'media';
const currentCache = (type = currentType) => tabCache[type];
const selectedReplyScope = () => document.querySelector('input[name="replyScope"]:checked')?.value || 'fast';
const selectedMediaScope = () => document.querySelector('input[name="mediaScope"]:checked')?.value || 'photo';
const activeMediaScope = () => (viewMode === 'idle' ? selectedMediaScope() : (currentCache('media')?.mediaScope || selectedMediaScope()));
const isPhotoMediaView = (type = currentType) => type === 'media' && activeMediaScope() === 'photo';
const selectedSpeed = () => document.querySelector('input[name="cleanupSpeed"]:checked')?.value || 'safe';

function typeNoun(type, count = 2) {
  const one = count === 1;
  if (type === 'unfollow') return one ? 'account' : 'accounts';
  if (type === 'likes') return one ? 'like' : 'likes';
  if (type === 'reposts') return one ? 'repost' : 'reposts';
  if (type === 'replies') return one ? 'reply' : 'replies';
  if (type === 'media') {
    const kind = activeMediaScope() === 'video' ? 'video' : 'photo';
    return one ? kind : `${kind}s`;
  }
  return one ? 'tweet' : 'tweets';
}

function actionVerb(type, tense = 'imperative') {
  if (tense === 'past') {
    if (type === 'unfollow') return 'unfollowed';
    if (type === 'likes') return 'unliked';
    if (type === 'reposts') return 'removed';
    return 'deleted';
  }
  if (tense === 'ing') {
    if (type === 'unfollow') return 'Unfollowing';
    if (type === 'likes') return 'Unliking';
    if (type === 'reposts') return 'Removing';
    return 'Deleting';
  }
  if (type === 'unfollow') return 'Unfollow';
  if (type === 'likes') return 'Unlike';
  if (type === 'reposts') return 'Remove';
  return 'Delete';
}

function destructiveLabel(count, type = currentType) {
  if (!count) return 'Select items to continue';
  const n = count.toLocaleString();
  if (type === 'replies' && currentCache('replies').replyScope === 'all') {
    return `Delete ${n} ${count === 1 ? 'post/reply' : 'posts & replies'}`;
  }
  return `${actionVerb(type)} ${n} ${typeNoun(type, count)}`;
}

function formatClock(sec) {
  const s = Math.max(0, Math.floor(sec || 0));
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function formatRelativeTime(ts) {
  if (!ts) return '';
  const diffMin = Math.max(0, Math.round((Date.now() - ts) / 60000));
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const hrs = Math.round(diffMin / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

function formatItemDate(value) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' }).format(d);
}

// === Session & Whitelist Storage ===

let saveSessionTimer = null;
function scheduleSessionSave() {
  clearTimeout(saveSessionTimer);
  saveSessionTimer = setTimeout(async () => {
    try {
      const compactTabs = {};
      for (const t of TYPES) {
        const c = tabCache[t];
        compactTabs[t] = {
          items: (c.items || []).slice(0, 2500),
          estimatedTotal: c.estimatedTotal,
          scannedAt: c.scannedAt,
          scanDurationSec: c.scanDurationSec ?? null,
          replyScope: c.replyScope,
          mediaScope: c.mediaScope || 'photo',
          scanState: c.scanState
        };
      }
      await chrome.storage.session.set({
        [SESSION_KEY]: {
          currentType,
          profileMetaCache,
          tabCache: compactTabs,
          lastDoneResult: lastDoneResult ? {
            jobId: lastDoneResult.jobId,
            type: lastDoneResult.type,
            succeeded: lastDoneResult.succeeded,
            failedItems: (lastDoneResult.failedItems || []).slice(0, 500)
          } : null
        }
      });
    } catch (_) {}
  }, 250);
}

async function restoreSession() {
  try {
    const stored = await chrome.storage.session.get([SESSION_KEY]);
    const saved = stored?.[SESSION_KEY];
    if (!saved) return;
    if (saved.currentType && TYPES.includes(saved.currentType)) currentType = saved.currentType;
    if (saved.profileMetaCache && typeof saved.profileMetaCache === 'object') {
      profileMetaCache = saved.profileMetaCache;
    }
    if (saved.tabCache) {
      for (const t of TYPES) {
        if (saved.tabCache[t]) {
          tabCache[t] = {
            items: Array.isArray(saved.tabCache[t].items) ? saved.tabCache[t].items : [],
            estimatedTotal: saved.tabCache[t].estimatedTotal ?? null,
            scannedAt: saved.tabCache[t].scannedAt ?? null,
            scanDurationSec: saved.tabCache[t].scanDurationSec ?? null,
            replyScope: saved.tabCache[t].replyScope || 'fast',
            mediaScope: saved.tabCache[t].mediaScope || 'photo',
            scanState: saved.tabCache[t].scanState || 'idle'
          };
        }
      }
    }
    if (saved.lastDoneResult) lastDoneResult = saved.lastDoneResult;
  } catch (_) {}
}

async function loadWhitelist() {
  const stored = await chrome.storage.local.get(['unfollowWhitelist']);
  const arr = Array.isArray(stored.unfollowWhitelist) ? stored.unfollowWhitelist : [];
  whitelist = new Set(arr.map(h => String(h).replace(/^@/, '').toLowerCase()).filter(Boolean));
  renderWhitelistTags();
}

async function saveWhitelist() {
  await chrome.storage.local.set({ unfollowWhitelist: Array.from(whitelist) });
  // Ensure protected items are never selected
  tabCache.unfollow.items.forEach(item => {
    if (whitelist.has((item.username || item.id || '').toLowerCase())) item.selected = false;
  });
  renderWhitelistTags();
  if (viewMode === 'review' || viewMode === 'scanning' || viewMode === 'paused' || viewMode === 'stopped') {
    refreshList();
  }
}

function renderWhitelistTags() {
  const box = $('whitelistTags');
  if (!box) return;
  box.replaceChildren();
  if (!whitelist.size) {
    const empty = document.createElement('span');
    empty.className = 'wl-empty-hint';
    empty.textContent = 'No protected accounts yet. Tap the shield icon on any account in the Following tab to protect them.';
    box.appendChild(empty);
    return;
  }
  for (const handle of Array.from(whitelist).sort()) {
    const tag = document.createElement('span');
    tag.className = 'wl-tag';
    tag.append(document.createTextNode(`@${handle}`));
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = '×';
    btn.setAttribute('aria-label', `Remove @${handle} from whitelist`);
    btn.addEventListener('click', () => {
      whitelist.delete(handle);
      saveWhitelist();
    });
    tag.appendChild(btn);
    box.appendChild(tag);
  }
}

// === Tab & Account Detection ===

async function findActiveXTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.url && X_URL.test(tab.url)) return tab;

  const pickBest = (list) => {
    if (!list.length) return null;
    const isLogin = (t) => /\/(i\/flow\/)?login\b/i.test(t.url || '');
    return list.find(t => !t.discarded && !isLogin(t))
      || list.find(t => !t.discarded)
      || list.find(t => !isLogin(t))
      || list[0];
  };

  const inWin = await chrome.tabs.query({ currentWindow: true, url: ['https://x.com/*', 'https://twitter.com/*'] });
  const winMatch = pickBest(inWin);
  if (winMatch) return winMatch;

  const all = await chrome.tabs.query({ url: ['https://x.com/*', 'https://twitter.com/*'] });
  return pickBest(all);
}

function waitForTabLoad(tabId, timeoutMs = 15000) {
  return new Promise(resolve => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      setTimeout(resolve, 1200);
    };
    const listener = (id, info) => { if (id === tabId && info.status === 'complete') finish(); };
    const timer = setTimeout(finish, timeoutMs);
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function detectAccount(tab) {
  if (!tab) return null;
  try {
    const result = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const parseCount = (raw) => {
          const s = (raw || '').trim().replace(/\u00a0/g, ' ');
          if (!s) return null;
          const m = s.match(/(\d+(?:[.,]\d+)*)\s*(K|M|B|Mn|Mr|mil|Mio|Tsd|万|億|천|만)?/i);
          if (!m) return null;
          let numStr = m[1];
          const unit = (m[2] || '').toLowerCase();
          if (unit) {
            // Decimal comma or dot when followed by unit (e.g. "1,2 B" or "5.6K")
            numStr = numStr.replace(',', '.');
          } else if (/^\d{1,3}([.,]\d{3})+$/.test(numStr)) {
            numStr = numStr.replace(/[.,]/g, '');
          } else {
            numStr = numStr.replace(/,/g, '');
          }
          const num = parseFloat(numStr);
          if (Number.isNaN(num)) return null;
          if (unit === 'k' || unit === 'mil' || unit === 'tsd' || unit === '천') return Math.round(num * 1000);
          if (unit === 'b') {
            const lang = (document.documentElement?.lang || '').toLowerCase();
            return Math.round(num * (lang.startsWith('tr') ? 1000 : 1000000000));
          }
          if (unit === '万' || unit === '만') return Math.round(num * 10000);
          if (unit === 'm' || unit === 'mn' || unit === 'mio') return Math.round(num * 1000000);
          if (unit === 'mr') return Math.round(num * 1000000000);
          if (unit === '億') return Math.round(num * 100000000);
          return Math.round(num);
        };

        const readInitialStateUser = () => {
          try {
            for (const sc of document.scripts) {
              const t = sc.textContent || '';
              const idx = t.indexOf('window.__INITIAL_STATE__=');
              if (idx === -1) continue;
              const start = idx + 'window.__INITIAL_STATE__='.length;
              const end = t.indexOf(';window.__META_DATA__', start);
              const raw = end !== -1 ? t.slice(start, end) : t.slice(start).replace(/;?\s*$/, '');
              const obj = JSON.parse(raw);
              const uid = obj?.session?.user_id;
              const u = uid ? obj?.entities?.users?.entities?.[uid] : null;
              if (u?.screen_name) return u;
            }
          } catch (_) {}
          return null;
        };

        const extractAvatarTestIdHandle = (root) => {
          const el = root?.querySelector?.('[data-testid^="UserAvatar-Container-"]');
          const tid = el?.getAttribute('data-testid') || '';
          const h = tid.replace(/^UserAvatar-Container-/, '');
          return /^[A-Za-z0-9_]{1,15}$/.test(h) ? h : null;
        };

        const reserved = /^(home|explore|notifications|messages|i|search|compose|settings|login|signup)$/i;
        const link = document.querySelector('[data-testid="AppTabBar_Profile_Link"]') ||
          document.querySelector('a[aria-label="Profile"]') ||
          document.querySelector('nav[role="navigation"] a[href*="/"][role="link"][aria-label*="Profile" i]');
        const switcher = document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"]');
        const dashBtn = document.querySelector('[data-testid="DashButton_ProfileIcon_Link"]');
        const href = link?.getAttribute('href') || '';
        const hrefHandle = href.replace(/^\//, '').split('/')[0];
        const texts = Array.from(switcher?.querySelectorAll('span') || [])
          .filter(span => span.children.length === 0)
          .map(span => (span.textContent || '').trim()).filter(Boolean);
        const textHandle = texts.find(text => /^@[A-Za-z0-9_]{1,15}$/.test(text))?.slice(1) || null;
        const switcherAvatarHandle = extractAvatarTestIdHandle(switcher);
        const dashAvatarHandle = extractAvatarTestIdHandle(dashBtn);
        const composerRoot = document.querySelector('[data-testid="primaryColumn"] [data-testid="tweetTextarea_0"]')?.closest('[data-testid="cellInnerDiv"], form, div[role="region"]');
        const composerAvatarHandle = extractAvatarTestIdHandle(composerRoot);

        const domUsername =
          (/^[A-Za-z0-9_]{1,15}$/.test(hrefHandle) && !reserved.test(hrefHandle)) ? hrefHandle
            : switcherAvatarHandle
              || dashAvatarHandle
              || textHandle
              || composerAvatarHandle
              || null;

        const hasLoginPrompt = !!document.querySelector('[data-testid="loginButton"], a[href="/i/flow/login"]');
        const stateUser = readInitialStateUser();
        const stateMatchesDom = stateUser && (!domUsername || stateUser.screen_name.toLowerCase() === domUsername.toLowerCase());

        const username = domUsername || (!hasLoginPrompt && stateUser?.screen_name ? stateUser.screen_name : null);
        if (!username) {
          const hasNav = !!document.querySelector('nav[role="navigation"], [data-testid="primaryColumn"], [data-testid="BottomBar"]');
          return { _status: (!hasLoginPrompt && !hasNav) ? 'loading' : 'logged_out' };
        }

        const avatar = switcher?.querySelector('img[src]') || dashBtn?.querySelector('img[src]') || link?.querySelector('img[src]');
        const rawAvatar = avatar?.currentSrc || avatar?.src || (stateMatchesDom ? stateUser.profile_image_url_https : '') || '';
        const avatarUrl = rawAvatar ? rawAvatar.replace(/_normal(\.[a-z]+)$/i, '_200x200$1') : '';
        const alt = (avatar?.alt || '').trim();
        const displayName =
          (alt && !/^(image|profile photo)$/i.test(alt) ? alt : '')
          || texts.find(text => text !== `@${username}` && !text.startsWith('@') && text.length <= 60)
          || (stateMatchesDom ? stateUser.name : '')
          || username;

        let verified = !!switcher?.querySelector('[data-testid="icon-verified"]')
          || Boolean(stateMatchesDom && (stateUser.is_blue_verified || stateUser.verified));
        let bannerUrl = (stateMatchesDom && stateUser.profile_banner_url) || '';
        let posts = (stateMatchesDom && typeof stateUser.statuses_count === 'number') ? stateUser.statuses_count : null;
        let following = (stateMatchesDom && typeof stateUser.friends_count === 'number') ? stateUser.friends_count : null;
        let followers = (stateMatchesDom && typeof stateUser.followers_count === 'number') ? stateUser.followers_count : null;

        const pathLower = (location.pathname || '').toLowerCase();
        const onOwnProfile = pathLower === `/${username.toLowerCase()}` || pathLower.startsWith(`/${username.toLowerCase()}/`);
        if (onOwnProfile) {
          const userNameBlock = document.querySelector('[data-testid="UserName"]');
          if (userNameBlock?.querySelector('[data-testid="icon-verified"]')) verified = true;
          const bannerImg = document.querySelector('a[href$="/header_photo"] img[src], img[src*="profile_banners"]');
          if (bannerImg) bannerUrl = bannerImg.currentSrc || bannerImg.src || bannerUrl;

          if (posts == null) {
            const h2 = document.querySelector('[data-testid="primaryColumn"] h2');
            const subline = h2?.parentElement?.querySelector('div[dir="auto"]:not(:has(h2))')
              || Array.from(h2?.parentElement?.children || []).find(el => el !== h2 && /\d/.test(el.textContent || ''));
            const parsedPosts = parseCount(subline?.textContent || '');
            if (parsedPosts != null) posts = parsedPosts;
          }

          const followingLink = document.querySelector(`a[href="/${username}/following" i] span, a[href$="/following"] span`);
          const domFollowing = followingLink ? parseCount(followingLink.textContent) : null;
          if (domFollowing != null) following = domFollowing;

          const followersLink = document.querySelector(`a[href="/${username}/verified_followers" i] span, a[href="/${username}/followers" i] span, a[href$="/verified_followers"] span, a[href$="/followers"] span`);
          const domFollowers = followersLink ? parseCount(followersLink.textContent) : null;
          if (domFollowers != null) followers = domFollowers;
        }

        return {
          username,
          displayName,
          avatarUrl,
          verified,
          bannerUrl,
          stats: { posts, following, followers }
        };
      }
    });
    const info = result?.[0]?.result || null;
    if (info?.username) {
      const key = info.username.toLowerCase();
      const prev = profileMetaCache[key] || { bannerUrl: '', verified: false, stats: {} };
      const merged = {
        bannerUrl: info.bannerUrl || prev.bannerUrl || '',
        verified: Boolean(info.verified || prev.verified),
        stats: {
          posts: info.stats?.posts ?? prev.stats?.posts ?? null,
          following: info.stats?.following ?? prev.stats?.following ?? null,
          followers: info.stats?.followers ?? prev.stats?.followers ?? null
        }
      };
      profileMetaCache[key] = merged;
      info.bannerUrl = merged.bannerUrl;
      info.verified = merged.verified;
      info.stats = merged.stats;
      scheduleSessionSave();
    }
    return info;
  } catch (err) {
    return { _status: 'error', _error: err?.message || 'Could not access X tab' };
  }
}

function formatCompactStat(n) {
  if (n == null) return '';
  if (n >= 1000000) return `${(n / 1000000).toFixed(1).replace(/\.0$/, '')}M`;
  if (n >= 10000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}K`;
  return n.toLocaleString();
}

function formatReachedMonth(items) {
  let oldest = Infinity;
  for (const item of items || []) {
    if (!item?.date) continue;
    const t = new Date(item.date).getTime();
    if (!Number.isNaN(t) && t < oldest) oldest = t;
  }
  if (!Number.isFinite(oldest)) return '';
  return `reached ${new Intl.DateTimeFormat(undefined, { month: 'short', year: 'numeric' }).format(new Date(oldest))}`;
}

function formatOldestDate(items) {
  let oldest = Infinity;
  for (const item of items || []) {
    if (!item?.date) continue;
    const t = new Date(item.date).getTime();
    if (!Number.isNaN(t) && t < oldest) oldest = t;
  }
  if (!Number.isFinite(oldest)) return '';
  return `oldest: ${new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(oldest))}`;
}

function setAccountIssue(text = '') {
  const pill = $('accountIssuePill');
  const dot = $('profileOnlineDot');
  if (!pill || !dot) return;
  if (text) {
    pill.textContent = text;
    pill.hidden = false;
    dot.style.background = 'var(--amber)';
  } else {
    pill.hidden = true;
    dot.style.background = '';
  }
}

function clearAccountRetry() {
  if (accountRetryTimer) {
    clearTimeout(accountRetryTimer);
    accountRetryTimer = null;
  }
  accountRetryIndex = 0;
}

function scheduleAccountRetry() {
  if (accountRetryTimer || cleanupRunning || activeScanType) return;
  const delays = [900, 1800, 3200, 5500];
  if (accountRetryIndex >= delays.length) return;
  const delay = delays[accountRetryIndex++];
  accountRetryTimer = setTimeout(async () => {
    accountRetryTimer = null;
    if (cleanupRunning || activeScanType || activeAccount?.username) return;
    await syncAccountStatus(true);
  }, delay);
}

function syncAccountChrome() {
  const ready = !!activeAccount?.username;
  $('accountSlot').hidden = settingsOpen;
  $('signedOutStrip').hidden = ready;
  $('profileCard').hidden = !ready;
  $('profileCard').classList.toggle('compact', viewMode !== 'idle');
  $('idleBottomBar').hidden = settingsOpen || viewMode !== 'idle' || !ready;
}

function renderAccount(accountResult, hasXTab = false) {
  const ready = !!accountResult?.username;
  activeAccount = ready ? accountResult : null;
  lastDetectStatus = ready ? null : (accountResult?._status || (hasXTab ? 'logged_out' : null));

  if (ready) {
    clearAccountRetry();
  } else if (hasXTab && (lastDetectStatus === 'loading' || lastDetectStatus === 'logged_out')) {
    scheduleAccountRetry();
  }

  $('signedOutStrip').textContent =
    lastDetectStatus === 'loading' ? 'Waiting for X to load…'
      : lastDetectStatus === 'error' ? 'Cannot access X tab'
        : 'Not signed in';
  $('accountIssuePill').hidden = true;
  $('profileOnlineDot').style.background = '';

  if (ready) {
    $('profileDisplayName').textContent = activeAccount.displayName || activeAccount.username;
    $('profileHandle').textContent = `@${activeAccount.username}`;
    $('profileVerified').hidden = !activeAccount.verified;
    $('profileInitials').textContent = (activeAccount.displayName || activeAccount.username || 'X').slice(0, 2);

    const pAvatar = $('profileAvatar');
    if (activeAccount.avatarUrl) {
      pAvatar.onload = () => { pAvatar.classList.add('visible'); $('profileInitials').hidden = true; };
      pAvatar.onerror = () => { pAvatar.classList.remove('visible'); $('profileInitials').hidden = false; };
      pAvatar.src = activeAccount.avatarUrl;
    } else {
      pAvatar.classList.remove('visible');
      pAvatar.removeAttribute('src');
      $('profileInitials').hidden = false;
    }

    const bannerEl = $('profileBanner');
    bannerEl.style.backgroundImage = activeAccount.bannerUrl ? `url("${activeAccount.bannerUrl.replace(/"/g, '%22')}")` : '';

    const s = activeAccount.stats || {};
    const hasPosts = s.posts != null;
    const hasFollowing = s.following != null;
    const hasFollowers = s.followers != null;
    $('statPostsWrap').hidden = !hasPosts;
    $('statFollowingWrap').hidden = !hasFollowing;
    $('statFollowersWrap').hidden = !hasFollowers;
    if (hasPosts) $('statPosts').textContent = formatCompactStat(s.posts);
    if (hasFollowing) $('statFollowing').textContent = formatCompactStat(s.following);
    if (hasFollowers) $('statFollowers').textContent = formatCompactStat(s.followers);
    $('profileStats').hidden = !(hasPosts || hasFollowing || hasFollowers);
  }

  $('noAccountEmpty').hidden = ready || settingsOpen;
  if (!ready) {
    if (lastDetectStatus === 'loading') {
      $('noAccountTitle').textContent = 'Waiting for X to load…';
      $('noAccountCopy').textContent = 'Your X tab is still loading. Your account will connect automatically in a moment, or tap Check again.';
    } else if (lastDetectStatus === 'error') {
      $('noAccountTitle').textContent = "Can't read this X tab";
      $('noAccountCopy').textContent = 'Reload the X tab or make sure X Bulk Clean has site access to x.com in Chrome extension settings, then tap Check again.';
    } else {
      $('noAccountTitle').textContent = 'Sign in to X to start';
      $('noAccountCopy').textContent = hasXTab
        ? 'Sign in to your X account in this tab — or if you are already signed in, tap Check again.'
        : 'Open x.com and sign in to detect your account and unlock cleanup tools.';
    }
  }

  $('startScan').disabled = !ready;
  $('startBulkAll').disabled = !ready;
  syncAccountChrome();
  if (viewMode === 'idle') syncIdleViewForType();
}

async function openX() {
  clearAccountRetry();
  const existing = await findActiveXTab();
  if (existing) {
    const [cur] = await chrome.tabs.query({ active: true, currentWindow: true });
    const alreadyFocused = cur?.id === existing.id;
    await chrome.tabs.update(existing.id, { active: true });
    if (existing.windowId != null) await chrome.windows.update(existing.windowId, { focused: true });

    const detected = await detectAccount(existing);
    if (detected?.username) {
      activeTab = existing;
      renderAccount(detected, true);
      return;
    }
    if (alreadyFocused || /\/(i\/flow\/)?login\b|\/settings\b/i.test(existing.url || '')) {
      await chrome.tabs.update(existing.id, { url: 'https://x.com/home', active: true });
    }
    scheduleAccountRetry();
  } else {
    await chrome.tabs.create({ url: 'https://x.com/home' });
    scheduleAccountRetry();
  }
}

function showError(msg) {
  const el = $('errorBanner');
  el.textContent = msg || '';
  el.hidden = !msg;
}

async function ensurePreviewPage(type, scopeOverride = null) {
  activeTab = await findActiveXTab();
  if (!activeTab || !activeAccount?.username) return null;
  const domain = activeTab.url.includes('twitter.com') ? 'twitter.com' : 'x.com';
  const mScope = scopeOverride || currentCache('media')?.mediaScope || selectedMediaScope();
  const path =
    type === 'replies' ? '/with_replies'
      : type === 'media' ? `/media?filter=${mScope === 'video' ? 'video' : 'photo'}`
        : type === 'likes' ? '/likes'
          : type === 'reposts' ? '/reposts'
            : type === 'unfollow' ? '/following'
              : '';
  const target = `https://${domain}/${activeAccount.username}${path}`;
  const current = type === 'media'
    ? (activeTab.url || '').replace(/#.*$/, '').replace(/\/$/, '')
    : (activeTab.url || '').replace(/[?#].*$/, '').replace(/\/$/, '');
  const alreadyOnLikes = type === 'likes' && /\/(i\/history\/likes|[^/]+\/likes)$/i.test(current);
  if (current.toLowerCase() !== target.toLowerCase() && !alreadyOnLikes) {
    const loaded = waitForTabLoad(activeTab.id);
    await chrome.tabs.update(activeTab.id, { url: target, active: true });
    await loaded;
  }
  return chrome.tabs.get(activeTab.id);
}

async function executeInTab(func, args = []) {
  if (!activeTab) return null;
  try {
    const result = await chrome.scripting.executeScript({ target: { tabId: activeTab.id }, func, args });
    return result?.[0]?.result;
  } catch (_) {
    return null;
  }
}

// === Injected Live Preview Scanner (runs in X tab — self-contained!) ===

function startPreviewScanner(type, account, performanceMode, replyScope = 'fast') {
  if (window.__xCleaner?.interval) return { ok: false, error: 'A cleanup job is already running.' };
  const previous = window.__xbcPreview;
  if (previous?.interval) clearInterval(previous.interval);
  if (previous?.style) previous.style.remove();

  const parseCountText = (raw) => {
    const s = (raw || '').trim().replace(/\u00a0/g, ' ');
    if (!s) return 0;
    const m = s.match(/(\d+(?:[.,]\d+)*)\s*(K|M|B|Mn|Mr|mil|Mio|Tsd|万|億|천|만)?/i);
    if (!m) return 0;
    let numStr = m[1];
    const unit = (m[2] || '').toLowerCase();
    if (unit) {
      numStr = numStr.replace(',', '.');
    } else if (/^\d{1,3}([.,]\d{3})+$/.test(numStr)) {
      numStr = numStr.replace(/[.,]/g, '');
    } else {
      numStr = numStr.replace(/,/g, '');
    }
    const num = parseFloat(numStr);
    if (Number.isNaN(num)) return 0;
    if (unit === 'k' || unit === 'mil' || unit === 'tsd' || unit === '천') return Math.round(num * 1000);
    if (unit === 'b') {
      const lang = (document.documentElement?.lang || '').toLowerCase();
      return Math.round(num * (lang.startsWith('tr') ? 1000 : 1000000000));
    }
    if (unit === '万' || unit === '만') return Math.round(num * 10000);
    if (unit === 'm' || unit === 'mn' || unit === 'mio') return Math.round(num * 1000000);
    if (unit === 'mr') return Math.round(num * 1000000000);
    if (unit === '億') return Math.round(num * 100000000);
    return Math.round(num);
  };

  const extractProfileTotal = () => {
    // Only use profile counts where they represent an accurate/approx upper bound:
    // Following count is exact; Posts count is approx upper bound for "Posts + replies" mode only.
    if (type === 'replies' && replyScope === 'all') {
      if (typeof account?.stats?.posts === 'number' && account.stats.posts > 0) return account.stats.posts;
      const h2 = document.querySelector('[data-testid="primaryColumn"] h2');
      const subline = Array.from(h2?.parentElement?.children || []).find(el => el !== h2 && /\d/.test(el.textContent || ''));
      const val = parseCountText(subline?.textContent || '');
      if (val > 0) return val;
    }
    if (type === 'unfollow') {
      if (typeof account?.stats?.following === 'number' && account.stats.following > 0) return account.stats.following;
      const link = document.querySelector('a[href$="/following"] span');
      if (link) {
        const val = parseCountText(link.textContent);
        if (val > 0) return val;
      }
    }
    return null;
  };

  const P = window.__xbcPreview = {
    type,
    replyScope,
    account,
    performanceMode: !!performanceMode,
    estimatedTotal: extractProfileTotal(),
    items: [],
    seen: new Set(),
    running: true,
    paused: false,
    done: false,
    issue: null,
    rateLimitUntil: 0,
    interval: null,
    style: null,
    busy: false,
    emptyCycles: 0,
    startedAt: Date.now()
  };

  const ownHandle = () => {
    const link = document.querySelector('[data-testid="AppTabBar_Profile_Link"]') || document.querySelector('a[aria-label="Profile"]');
    const fromLink = link?.getAttribute('href')?.replace(/^\//, '').split('/')[0].toLowerCase();
    if (fromLink && /^[a-z0-9_]{1,15}$/.test(fromLink)) return fromLink;
    const avatarEl = document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"] [data-testid^="UserAvatar-Container-"], [data-testid="DashButton_ProfileIcon_Link"] [data-testid^="UserAvatar-Container-"]');
    const fromAvatar = (avatarEl?.getAttribute('data-testid') || '').replace(/^UserAvatar-Container-/, '').toLowerCase();
    if (fromAvatar && /^[a-z0-9_]{1,15}$/.test(fromAvatar)) return fromAvatar;
    return (account?.username || '').toLowerCase() || null;
  };
  const me = ownHandle();
  const tweetId = article => article.querySelector('a[href*="/status/"]')?.getAttribute('href')?.match(/\/status\/(\d+)/)?.[1] || null;
  const authorHandle = article => article.querySelector('[data-testid="User-Name"] a[role="link"][href^="/"]')?.getAttribute('href')?.replace(/^\//, '').split('/')[0].toLowerCase() || null;
  const userHandle = cell => {
    for (const link of cell.querySelectorAll('a[role="link"][href^="/"]')) {
      const handle = link.getAttribute('href')?.replace(/^\//, '').split('/')[0];
      if (/^[A-Za-z0-9_]{1,15}$/.test(handle || '')) return handle;
    }
    return null;
  };
  const extractLikeCount = (article) => {
    const btn = article.querySelector('[data-testid="like"], [data-testid="unlike"]');
    if (!btn) return 0;
    const textVal = parseCountText(btn.textContent || '');
    if (textVal > 0) return textVal;
    const label = btn.getAttribute('aria-label') || '';
    return parseCountText(label);
  };
  const findReplyBannerHandle = (article) => {
    const userNameEl = article.querySelector('[data-testid="User-Name"]');
    const tweetTextEl = article.querySelector('[data-testid="tweetText"]');
    const socialEl = article.querySelector('[data-testid="socialContext"]');
    for (const a of article.querySelectorAll('a[role="link"][href^="/"]')) {
      if (userNameEl?.contains(a) || tweetTextEl?.contains(a) || socialEl?.contains(a)) continue;
      if (a.closest('[data-testid="Tweet-User-Avatar"]')) continue;
      // Ignore links inside a nested quoted tweet card
      const quoteCard = a.closest('[tabindex="0"][role="link"]');
      if (quoteCard && quoteCard !== article && article.contains(quoteCard)) continue;
      const txt = (a.textContent || '').trim();
      if (!/^@[A-Za-z0-9_]{1,15}$/.test(txt)) continue;
      if (userNameEl && !(userNameEl.compareDocumentPosition(a) & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
      if (tweetTextEl && !(a.compareDocumentPosition(tweetTextEl) & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
      return txt;
    }
    return '';
  };
  const findParentTweetAuthor = (article) => {
    const cell = article.closest('[data-testid="cellInnerDiv"]');
    let prev = cell?.previousElementSibling;
    for (let hops = 0; prev && hops < 4; hops++, prev = prev.previousElementSibling) {
      const prevTweet = prev.querySelector?.('article[data-testid="tweet"]');
      if (prevTweet) {
        if (!hasConnector(prev)) return '';
        const h = authorHandle(prevTweet);
        return h ? `@${h}` : '@';
      }
    }
    return '';
  };
  const extractReplyingTo = (article) => {
    const fromBanner = findReplyBannerHandle(article);
    if (fromBanner) return fromBanner;
    const fromParent = findParentTweetAuthor(article);
    if (fromParent && fromParent !== '@') return fromParent;
    const m = (article.textContent || '').slice(0, 320).match(/Replying to\s+(@[A-Za-z0-9_]{1,15})/i);
    return m ? m[1] : '';
  };
  const hasExternalLink = (article, text) => {
    if (article.querySelector('a[href^="https://t.co/"], [data-testid="card.wrapper"]')) return true;
    return /https?:\/\/\S+/i.test(text || '');
  };
  const isMine = article => !me || authorHandle(article) === me;
  const hasConnector = cell => {
    if (!cell) return false;
    const divs = cell.querySelectorAll('div');
    for (let i = 0; i < Math.min(divs.length, 160); i++) {
      const el = divs[i], width = el.offsetWidth, height = el.offsetHeight;
      if (width >= 1 && width <= 3 && height >= 18) {
        const bg = getComputedStyle(el).backgroundColor;
        if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') return true;
      }
    }
    return false;
  };
  const isReply = article => {
    if (findReplyBannerHandle(article)) return true;
    if (findParentTweetAuthor(article)) return true;
    return /Replying to/i.test((article.textContent || '').slice(0, 300));
  };
  const atBottom = () => window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 240;

  const detectRateLimit = () => {
    const toast = document.querySelector('[data-testid="toast"]') || document.querySelector('[role="alert"]');
    const text = (toast?.textContent || '').trim();
    return /rate.?limit|too many requests|please wait a few moments|429|hız sınır|çok fazla istek|birkaç dakika bekle|制限|しばらく待|límite|demasiadas solicitudes|limite de débit|trop de requêtes|zu viele anfragen/i.test(text);
  };

  const applyPerfStyle = () => {
    if (!P.performanceMode || P.style) return;
    if (type === 'media' && replyScope === 'photo') return;
    const style = document.createElement('style');
    style.id = '__xbcPreviewPerformance';
    style.textContent = type === 'media'
      ? 'article[data-testid="tweet"] video{visibility:hidden!important}'
      : 'article[data-testid="tweet"] [data-testid="tweetPhoto"],article[data-testid="tweet"] [data-testid="videoPlayer"],article[data-testid="tweet"] video{display:none!important}';
    (document.head || document.documentElement).appendChild(style);
    P.style = style;
    document.querySelectorAll('article[data-testid="tweet"] video').forEach(v => { v.pause(); v.autoplay = false; v.preload = 'none'; });
  };

  const finish = (reason, done = false) => {
    if (P.interval) clearInterval(P.interval);
    P.interval = null;
    P.running = false;
    P.paused = false;
    P.done = done;
    P.issue = reason || null;
    P.style?.remove();
    P.style = null;
  };

  const scanTick = () => {
    if (P.busy || P.paused || !P.interval) return;
    if (P.rateLimitUntil && Date.now() < P.rateLimitUntil) return;
    P.rateLimitUntil = 0;
    if (detectRateLimit()) {
      P.rateLimitUntil = Date.now() + 30000;
      return;
    }
    if (!P.estimatedTotal) P.estimatedTotal = extractProfileTotal();

    P.busy = true;
    try {
      let added = 0;
      const scopeRoot = document.querySelector('[data-testid="primaryColumn"]') || document;
      if (type === 'unfollow') {
        for (const cell of scopeRoot.querySelectorAll('[data-testid="UserCell"]')) {
          // Only include accounts actually being followed (excludes "Who to follow" suggestions)
          if (!cell.querySelector('button[data-testid$="-unfollow"]')) continue;
          const username = userHandle(cell);
          const id = username?.toLowerCase();
          if (!id || P.seen.has(id)) continue;
          const profileLinks = Array.from(cell.querySelectorAll('a[role="link"][href^="/"]'))
            .filter(a => (a.getAttribute('href') || '').replace(/^\//, '').split('/')[0].toLowerCase() === id);
          const displayName = profileLinks
            .map(a => (a.textContent || '').trim())
            .find(t => t && !t.startsWith('@')) || username;

          // Exclude elements referenced via aria-describedby (localized "Click to Unfollow ...")
          const describedIds = new Set();
          for (const el of cell.querySelectorAll('[aria-describedby]')) {
            (el.getAttribute('aria-describedby') || '').split(/\s+/).forEach(x => { if (x) describedIds.add(x); });
          }
          const bio = Array.from(cell.querySelectorAll('div[dir="auto"]'))
            .filter(el => {
              if (el.id && describedIds.has(el.id)) return false;
              if (el.closest('a[role="link"], [data-testid="userFollowIndicator"], button[data-testid$="-unfollow"], button[data-testid$="-follow"]')) return false;
              return true;
            })
            .map(el => (el.textContent || '').trim())
            .filter(Boolean)
            .at(-1) || '';
          const avatar = cell.querySelector('[data-testid^="UserAvatar-Container"] img[src], img[src*="profile_images"]');
          const avatarUrl = avatar?.currentSrc || avatar?.src || '';
          const followsYou = !!cell.querySelector('[data-testid="userFollowIndicator"]');
          const noAvatar = !avatarUrl || /default_profile/i.test(avatarUrl);

          P.seen.add(id);
          P.items.push({
            id,
            type: 'account',
            classification: 'unfollow',
            text: `${displayName} @${username}`,
            displayName,
            username,
            bio,
            avatarUrl,
            followsYou,
            noAvatar,
            date: '',
            author: username,
            url: `/${username}`,
            likes: 0,
            hasMedia: false,
            hasLinks: false,
            replyingTo: '',
            selected: false,
            discoveredAt: Date.now()
          });
          added++;
        }
      } else if (type === 'media' && replyScope === 'photo') {
        for (const a of scopeRoot.querySelectorAll('li a[href*="/status/"], a[href*="/photo/"]')) {
          const href = a.getAttribute('href') || '';
          const id = href.match(/\/status\/(\d+)/)?.[1] || null;
          if (!id || P.seen.has(id)) continue;
          const img = a.querySelector('img[src]');
          const thumbUrl = img?.currentSrc || img?.src || '';
          const altRaw = (img?.alt || '').trim();
          const altText = altRaw && !/^(image|photo|görsel|resim|fotoğraf|imagen|bild)$/i.test(altRaw) ? altRaw : '';
          const hrefAuthor = href.replace(/^\//, '').split('/')[0] || me || '';
          P.seen.add(id);
          P.items.push({
            id,
            type: 'photo',
            classification: 'photo',
            mediaKind: 'photo',
            thumbUrl,
            text: altText,
            date: '',
            author: hrefAuthor,
            replyingTo: '',
            url: `/${hrefAuthor}/status/${id}`,
            likes: 0,
            hasMedia: true,
            hasLinks: false,
            selected: false,
            discoveredAt: Date.now()
          });
          added++;
        }
      } else {
        for (const article of scopeRoot.querySelectorAll('article[data-testid="tweet"]')) {
          const id = tweetId(article);
          if (!id || P.seen.has(id)) continue;
          const repost = !!article.querySelector('[data-testid="unretweet"]');
          const liked = !!article.querySelector('[data-testid="unlike"]');
          const reply = (type === 'reposts' || type === 'likes' || type === 'media') ? false : isReply(article);

          if (type === 'likes') {
            if (!liked) continue;
          } else if (type === 'reposts') {
            if (!repost) continue;
          } else if (type === 'media') {
            if (!isMine(article) || repost) continue;
          } else {
            if (!isMine(article)) continue;
            if (type === 'replies' && repost) continue;
            if (type === 'tweets' && reply) continue;
            if (type === 'replies' && replyScope === 'fast' && !reply) continue;
          }

          const link = article.querySelector(`a[href*="/status/${id}"]`) || article.querySelector('a[href*="/status/"]');
          const tweetText = article.querySelector('[data-testid="tweetText"]')?.textContent || '';
          const videoPoster = type === 'media'
            ? (article.querySelector('video')?.getAttribute('poster') || article.querySelector('[data-testid="videoPlayer"] img[src], [data-testid="tweetPhoto"] img[src]')?.currentSrc || '')
            : '';
          P.seen.add(id);
          P.items.push({
            id,
            type: type === 'likes' ? 'like' : type === 'reposts' ? 'repost' : type === 'media' ? 'video' : reply ? 'reply' : type === 'replies' ? 'post' : 'tweet',
            classification: type === 'replies' ? (reply ? 'definite' : 'standalone') : type === 'media' ? 'video' : type,
            ...(type === 'media' ? { mediaKind: 'video', thumbUrl: videoPoster } : {}),
            text: tweetText,
            date: article.querySelector('time')?.getAttribute('datetime') || '',
            author: authorHandle(article) || me || '',
            replyingTo: reply ? extractReplyingTo(article) : '',
            url: link?.getAttribute('href') || '',
            likes: extractLikeCount(article),
            hasMedia: type === 'media' || !!article.querySelector('[data-testid="tweetPhoto"], [data-testid="videoPlayer"], video'),
            hasLinks: hasExternalLink(article, tweetText),
            selected: false,
            discoveredAt: Date.now()
          });
          added++;
        }
      }

      if (!added && atBottom()) P.emptyCycles++;
      else P.emptyCycles = 0;
      if (P.emptyCycles >= 6) {
        finish('Scan complete', true);
        return;
      }
      window.scrollBy(0, Math.max(520, window.innerHeight * 0.78));
    } finally {
      P.busy = false;
    }
  };

  const startLoop = (scrollTop = false) => {
    if (P.interval) clearInterval(P.interval);
    P.running = true;
    P.paused = false;
    P.done = false;
    P.issue = null;
    P.emptyCycles = 0;
    applyPerfStyle();
    if (scrollTop) window.scrollTo({ top: 0, behavior: 'auto' });
    P.interval = setInterval(scanTick, 1400);
  };

  window.__xbcPreviewStop = () => finish('Scan stopped by user', false);
  window.__xbcPreviewResume = () => {
    if (P.interval) P.paused = false;
    else if (!P.done) startLoop(false);
  };

  startLoop(true);
  return { ok: true };
}

function readPreviewState(sinceIndex = 0) {
  const P = window.__xbcPreview;
  if (!P) return null;
  return {
    type: P.type,
    replyScope: P.replyScope,
    account: P.account,
    estimatedTotal: P.estimatedTotal,
    running: !!P.interval,
    paused: !!P.paused,
    done: !!P.done,
    issue: P.issue,
    startedAt: P.startedAt,
    tabHidden: document.hidden || document.visibilityState === 'hidden',
    rateLimitSec: P.rateLimitUntil > Date.now() ? Math.ceil((P.rateLimitUntil - Date.now()) / 1000) : 0,
    count: P.items.length,
    newItems: P.items.slice(sinceIndex)
  };
}

function controlPreviewScanner(command) {
  const P = window.__xbcPreview;
  if (!P) return null;
  if (command === 'pause') P.paused = true;
  if (command === 'resume') window.__xbcPreviewResume?.();
  if (command === 'stop') window.__xbcPreviewStop?.();
  if (command === 'reset') {
    if (P.interval) clearInterval(P.interval);
    P.style?.remove();
    document.getElementById('__xbcPreviewPerformance')?.remove();
    delete window.__xbcPreview;
    delete window.__xbcPreviewStop;
    delete window.__xbcPreviewResume;
    return null;
  }
  return { paused: P.paused, running: !!P.interval, done: !!P.done, count: P.items.length };
}

// === Injected Unified Cleanup Worker (Safe/Fast speed, Whitelist skip, Failed items tracking) ===

function readCleanupState() {
  const X = window.__xCleaner;
  if (!X) return null;
  const now = Date.now();
  const pausedMs = (X.pausedTotalMs || 0) + (X.paused && X.pauseStartedAt ? (now - X.pauseStartedAt) : 0);
  const activeMs = Math.max(0, now - (X.startedAt || now) - pausedMs);
  return {
    jobId: X.jobId,
    action: X.action,
    mode: X.mode || 'selected',
    type: X.type || 'tweets',
    running: !!X.interval,
    paused: !!X.paused,
    issue: X.issue,
    tabHidden: document.hidden || document.visibilityState === 'hidden',
    rateLimitSec: X.rateLimitUntil > now ? Math.ceil((X.rateLimitUntil - now) / 1000) : 0,
    successCount: X.successCount || 0,
    failedItems: X.failedItems || [],
    totalTarget: X.totalTarget || 0,
    activeMs,
    historyPersisted: !!X.historyPersisted,
    historySaveError: X.historySaveError || null
  };
}

function controlCleanupWorker(command) {
  if (command === 'pause') window.__xCleanerPause?.();
  if (command === 'resume') window.__xCleanerResume?.();
  if (command === 'stop') window.__xCleanerStop?.();
  return true;
}

function runCleanupWorker(mode, type, selectedItems, account, performanceMode, replyScope = 'fast', speed = 'safe', whitelistArr = []) {
  if (window.__xCleaner?.interval) return { ok: false, error: 'Another cleanup is already running.' };
  if (window.__xbcPreview?.interval) clearInterval(window.__xbcPreview.interval);
  window.__xbcPreview?.style?.remove();

  const isSelected = mode === 'selected';
  const fast = speed === 'fast';
  const protectedSet = new Set((whitelistArr || []).map(h => String(h).toLowerCase()));
  const action =
    type === 'replies' ? 'deleteReplies'
      : type === 'media' ? 'deleteMedia'
        : type === 'likes' ? 'unlike'
          : type === 'reposts' ? 'unrepost'
            : type === 'unfollow' ? 'bulkUnfollow'
              : 'delete';

  const filteredSelected = (selectedItems || []).filter(item => {
    if (type === 'unfollow' && protectedSet.has((item.username || item.id || '').toLowerCase())) return false;
    return true;
  });
  const selected = new Map(filteredSelected.map(item => [item.id, item]));
  const totalTarget = isSelected ? selected.size : 0;

  const X = window.__xCleaner = {
    action,
    mode,
    type,
    totalTarget,
    backup: { tweets: [], replies: [], media: [], unliked: [], unreposted: [], follows: [], unfollows: [] },
    processed: new Set(),
    succeededIds: new Set(),
    failedItems: [],
    interval: null,
    keepAlive: null,
    busy: false,
    paused: false,
    pausedTotalMs: 0,
    pauseStartedAt: null,
    rateLimitUntil: 0,
    issue: null,
    emptyCycles: 0,
    successCount: 0,
    startedAt: Date.now(),
    historySaved: false,
    historyPersisted: false,
    jobId: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    overlayHost: null,
    overlayTimer: null,
    performanceStyle: null
  };

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const ownHandle = () => {
    const fromLink = document.querySelector('[data-testid="AppTabBar_Profile_Link"]')?.getAttribute('href')?.replace(/^\//, '').split('/')[0].toLowerCase();
    if (fromLink && /^[a-z0-9_]{1,15}$/.test(fromLink)) return fromLink;
    const avatarEl = document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"] [data-testid^="UserAvatar-Container-"], [data-testid="DashButton_ProfileIcon_Link"] [data-testid^="UserAvatar-Container-"]');
    const fromAvatar = (avatarEl?.getAttribute('data-testid') || '').replace(/^UserAvatar-Container-/, '').toLowerCase();
    if (fromAvatar && /^[a-z0-9_]{1,15}$/.test(fromAvatar)) return fromAvatar;
    return (account?.username || '').toLowerCase() || null;
  };
  const me = ownHandle();
  const tweetId = article => article.querySelector('a[href*="/status/"]')?.getAttribute('href')?.match(/\/status\/(\d+)/)?.[1] || null;
  const authorHandle = article => article.querySelector('[data-testid="User-Name"] a[role="link"][href^="/"]')?.getAttribute('href')?.replace(/^\//, '').split('/')[0].toLowerCase() || null;
  const userHandle = cell => {
    for (const link of cell.querySelectorAll('a[role="link"][href^="/"]')) {
      const handle = link.getAttribute('href')?.replace(/^\//, '').split('/')[0];
      if (/^[A-Za-z0-9_]{1,15}$/.test(handle || '')) return handle.toLowerCase();
    }
    return null;
  };
  const tweetSnap = article => {
    const a = article.querySelector('a[href*="/status/"]');
    return {
      id: tweetId(article),
      date: article.querySelector('time')?.getAttribute('datetime') || '',
      text: article.querySelector('[data-testid="tweetText"]')?.textContent || '',
      author: authorHandle(article) || '',
      url: a?.getAttribute('href') || ''
    };
  };
  const userSnap = cell => {
    const links = Array.from(cell.querySelectorAll('a[role="link"][href^="/"]'));
    const username = links.map(a => a.getAttribute('href')?.replace(/^\//, '').split('/')[0]).find(h => /^[A-Za-z0-9_]{1,15}$/.test(h || '')) || '';
    const displayName = links
      .filter(a => (a.getAttribute('href') || '').replace(/^\//, '').split('/')[0].toLowerCase() === username.toLowerCase())
      .map(a => (a.textContent || '').trim())
      .find(t => t && !t.startsWith('@')) || username;
    return { username, displayName, profileUrl: `/${username}` };
  };
  const hasConnector = cell => {
    const divs = cell?.querySelectorAll('div') || [];
    for (let i = 0; i < Math.min(divs.length, 160); i++) {
      const el = divs[i];
      if (el.offsetWidth >= 1 && el.offsetWidth <= 3 && el.offsetHeight >= 18) {
        const bg = getComputedStyle(el).backgroundColor;
        if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') return true;
      }
    }
    return false;
  };
  const hasReplyBanner = article => {
    const userNameEl = article.querySelector('[data-testid="User-Name"]');
    const tweetTextEl = article.querySelector('[data-testid="tweetText"]');
    const socialEl = article.querySelector('[data-testid="socialContext"]');
    for (const a of article.querySelectorAll('a[role="link"][href^="/"]')) {
      if (userNameEl?.contains(a) || tweetTextEl?.contains(a) || socialEl?.contains(a)) continue;
      if (a.closest('[data-testid="Tweet-User-Avatar"]')) continue;
      const quoteCard = a.closest('[tabindex="0"][role="link"]');
      if (quoteCard && quoteCard !== article && article.contains(quoteCard)) continue;
      const txt = (a.textContent || '').trim();
      if (!/^@[A-Za-z0-9_]{1,15}$/.test(txt)) continue;
      if (userNameEl && !(userNameEl.compareDocumentPosition(a) & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
      if (tweetTextEl && !(a.compareDocumentPosition(tweetTextEl) & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
      return true;
    }
    return false;
  };
  const isReply = article => {
    if (hasReplyBanner(article)) return true;
    const cell = article.closest('[data-testid="cellInnerDiv"]');
    let prev = cell?.previousElementSibling;
    for (let i = 0; prev && i < 4; i++, prev = prev.previousElementSibling) {
      if (prev.querySelector?.('article[data-testid="tweet"]')) return hasConnector(prev);
    }
    return /Replying to/i.test((article.textContent || '').slice(0, 300));
  };
  const atBottom = () => window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 240;
  const clickConfirm = async testId => {
    for (let i = 0; i < 10; i++) {
      const button = document.querySelector(`[data-testid="${testId}"]`);
      if (button && button.offsetParent !== null) { button.click(); return true; }
      await sleep(fast ? 130 : 200);
    }
    return false;
  };
  const isDeleteMenuItem = item => {
    if (!item || item.offsetParent === null) return false;
    // 1. Language-independent: X's trash-can SVG icon path
    const pathD = item.querySelector('svg path')?.getAttribute('d') || '';
    if (/^M16\s+6V4\.5C16\s+3\.12/i.test(pathD)) return true;
    // 2. Language-independent: destructive red color (#F4212E) on own post menu item
    const testId = item.getAttribute('data-testid') || '';
    if (!testId) {
      const svg = item.querySelector('svg');
      const span = item.querySelector('span');
      const isRed = (el) => el && getComputedStyle(el).color === 'rgb(244, 33, 46)';
      if (isRed(svg) || isRed(span)) return true;
    }
    // 3. Multi-language text fallback
    const label = (item.textContent || '').trim();
    return /^(delete( post| tweet| reply)?|sil|削除|eliminar|supprimer|löschen|elimina|excluir|удалить|삭제|删除|حذف)$/i.test(label);
  };
  const clickDeleteMenu = async () => {
    for (let i = 0; i < 9; i++) {
      const items = document.querySelectorAll('[role="menuitem"]');
      const button = Array.from(items).find(isDeleteMenuItem);
      if (button) { button.click(); return true; }
      await sleep(fast ? 110 : 160);
    }
    return false;
  };
  const detectIssue = () => {
    const toast = document.querySelector('[data-testid="toast"]') || document.querySelector('[role="alert"]');
    const text = (toast?.textContent || '').trim();
    if (/rate.?limit|too many requests|please wait a few moments|429|hız sınır|çok fazla istek|birkaç dakika bekle|制限|しばらく待|límite|demasiadas solicitudes|limite de débit|trop de requêtes|zu viele anfragen/i.test(text)) {
      return 'Rate limited by X — wait a few moments before starting another job';
    }
    if (/try again|something went wrong|unable|locked|restrict|exceeded|bir hata oluştu|tekrar dene|kısıtlan|kilitlen|エラー|もう一度|algo salió mal|inténtalo de nuevo|une erreur|réessayer|etwas ist schief|erneut versuchen/i.test(text)) {
      return text.slice(0, 200);
    }
    return null;
  };
  const stopIfIssue = async (waitMs = 0) => {
    const deadline = Date.now() + waitMs;
    do {
      const issue = detectIssue();
      if (issue) { await stop(issue); return true; }
      if (Date.now() >= deadline) break;
      await sleep(100);
    } while (X.interval);
    return false;
  };

  const progressVerb = type === 'unfollow' ? 'unfollowed' : type === 'likes' ? 'unliked' : type === 'reposts' ? 'removed' : 'deleted';
  const counts = () => ({
    tweets: X.backup.tweets.length,
    replies: X.backup.replies.length,
    media: X.backup.media.length,
    unliked: X.backup.unliked.length,
    unreposted: X.backup.unreposted.length,
    follows: 0,
    unfollows: X.backup.unfollows.length
  });

  const persist = async reason => {
    if (X.historySaved) return;
    X.historySaved = true;
    if (isSelected) {
      X.failedItems = Array.from(selected.values()).filter(item => !X.succeededIds.has(item.id));
    }
    const completedAt = Date.now(), jobCounts = counts();
    const total = jobCounts.tweets + jobCounts.replies + jobCounts.media + jobCounts.unliked + jobCounts.unreposted + jobCounts.unfollows;
    const status = /rate.?limit/i.test(reason || '') ? 'rate_limited' : /^Finished/i.test(reason || '') ? 'completed' : /Stopped by user/i.test(reason || '') ? 'stopped' : 'interrupted';
    const summary = {
      id: X.jobId, action, account,
      startedAt: X.startedAt, completedAt,
      durationMs: completedAt - X.startedAt,
      status, statusText: reason || 'Action finished',
      total, counts: jobCounts,
      ...(isSelected ? { selectedTotal: selected.size, skipped: X.failedItems.length } : {})
    };
    try {
      const stored = await chrome.storage.local.get(['jobHistory']);
      const history = Array.isArray(stored.jobHistory) ? stored.jobHistory : [];
      await chrome.storage.local.set({
        jobHistory: [summary, ...history.filter(job => job?.id !== X.jobId)],
        [`job_${X.jobId}`]: { ...summary, backup: X.backup }
      });
      X.historyPersisted = true;
    } catch (error) {
      X.historySaveError = error?.message || 'History save failed';
    }
  };

  const formatEtaText = () => {
    if (X.paused) return 'Paused';
    if (!totalTarget) {
      const elapsedSec = Math.max(0, Math.floor((Date.now() - X.startedAt - X.pausedTotalMs) / 1000));
      return `${Math.floor(elapsedSec / 60)}:${String(elapsedSec % 60).padStart(2, '0')}`;
    }
    const remaining = Math.max(0, totalTarget - X.successCount);
    if (!remaining) return '0s left';
    if (X.successCount < 2) return 'Estimating…';
    const activeMs = Math.max(1000, Date.now() - X.startedAt - X.pausedTotalMs);
    const etaSec = Math.max(1, Math.round((activeMs / X.successCount) * remaining / 1000));
    if (etaSec < 60) return `~${etaSec}s left`;
    const m = Math.floor(etaSec / 60), s = etaSec % 60;
    return s ? `~${m}m ${s}s left` : `~${m}m left`;
  };

  const updateOverlay = () => {
    const shadow = X.overlayHost?.shadowRoot;
    if (!shadow) return;
    const pct = totalTarget ? Math.min(100, Math.round((X.successCount / totalTarget) * 100)) : 0;
    shadow.getElementById('count').textContent = totalTarget
      ? `${X.successCount} of ${totalTarget} ${progressVerb} (${pct}%)`
      : `${X.successCount} ${progressVerb}`;
    shadow.getElementById('eta').textContent = formatEtaText();
    if (totalTarget) shadow.getElementById('fill').style.width = `${pct}%`;
    const pauseBtn = shadow.getElementById('pause');
    if (pauseBtn && X.interval) pauseBtn.textContent = X.paused ? 'Resume' : 'Pause';
    const kicker = shadow.querySelector('.k');
    if (kicker && X.interval) kicker.textContent = X.paused ? 'X Bulk Clean paused' : 'X Bulk Clean running';
  };

  const createOverlay = () => {
    document.getElementById('__xbcJobOverlay')?.remove();
    const host = document.createElement('div');
    host.id = '__xbcJobOverlay';
    host.style.cssText = 'position:fixed;top:16px;right:16px;z-index:2147483647';
    const shadow = host.attachShadow({ mode: 'open' });
    const verb = type === 'unfollow' ? 'Unfollowing' : type === 'likes' ? 'Unliking' : type === 'reposts' ? 'Removing' : 'Deleting';
    const object = type === 'unfollow' ? 'accounts' : type;
    const title = isSelected ? `${verb} selected ${object}` : `${verb} all ${object}`;
    shadow.innerHTML = `<style>
      *{box-sizing:border-box}
      .c{width:300px;padding:14px;border:1px solid rgba(255,255,255,.12);border-radius:12px;background:rgba(17,19,23,.96);color:#f4f5f7;box-shadow:0 18px 48px rgba(0,0,0,.38);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
      .k{color:#7f9cff;font-size:10.5px;font-weight:700;letter-spacing:.06em;text-transform:uppercase}
      .c.paused .k,.c.done .k{color:#979cab}
      h2{margin:5px 0 2px;font-size:15px}
      .a{color:#979cab;font-size:11.5px}
      .bar{height:4px;margin:10px 0 8px;overflow:hidden;border-radius:999px;background:rgba(255,255,255,.12)}
      .fill{height:100%;width:0%;border-radius:inherit;background:#7f9cff;transition:width 220ms ease}
      .c.indet .fill{width:100%;background:linear-gradient(90deg,transparent 0%,#7f9cff 45%,#c2d0ff 55%,transparent 100%);background-size:200% 100%;animation:sh 1.3s linear infinite}
      .c.paused .fill,.c.done .fill{animation:none}
      @keyframes sh{from{background-position:200% 0}to{background-position:-200% 0}}
      .m{display:flex;justify-content:space-between;gap:8px;color:#b8bcc8;font-size:11.5px;font-variant-numeric:tabular-nums}
      .review{margin-top:10px;padding:11px;border:1px solid rgba(129,140,248,.42);border-radius:10px;background:radial-gradient(120% 130% at 0% 0%,rgba(99,102,241,.24),transparent 60%),radial-gradient(110% 120% at 100% 100%,rgba(236,72,153,.22),transparent 60%),rgba(255,255,255,.04)}
      .review[hidden]{display:none}
      .review-stars{color:#fbbf24;font-size:12px;letter-spacing:1px;margin-bottom:4px;filter:drop-shadow(0 0 6px rgba(251,191,36,.45))}
      .review-copy{margin:0 0 9px;color:#f1f2f6;font-size:11.5px;line-height:1.45}
      .review-cta{width:100%;min-block-size:36px;padding:6px 10px;display:inline-flex;align-items:center;justify-content:center;gap:6px;border-radius:8px;background:linear-gradient(135deg,#4f46e5 0%,#7c3aed 55%,#db2777 100%);color:#ffffff;font:700 12px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;text-decoration:none;box-shadow:0 5px 14px rgba(124,58,237,.35)}
      .review-cta:hover{filter:brightness(1.08)}
      .btns{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:10px}
      .btns.single{grid-template-columns:1fr}
      button{min-block-size:34px;border-radius:8px;border:1px solid rgba(255,255,255,.16);background:rgba(255,255,255,.08);color:#f4f5f7;font:650 11.5px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;cursor:pointer}
      button:hover{background:rgba(255,255,255,.14)}
      button[hidden]{display:none}
      button:disabled{opacity:.5;cursor:default}
    </style>
    <section class="c ${totalTarget ? '' : 'indet'}" role="status" aria-live="polite">
      <div class="k">X Bulk Clean running</div>
      <h2>${title}</h2>
      <div class="a"></div>
      <div class="bar"><div id="fill" class="fill"></div></div>
      <div class="m"><span id="count">0 ${progressVerb}</span><span id="eta">Estimating…</span></div>
      <div id="jobReview" class="review" hidden>
        <div class="review-stars" aria-hidden="true">★★★★★</div>
        <p id="jobReviewCopy" class="review-copy"></p>
        <a id="jobReviewLink" class="review-cta" href="https://chromewebstore.google.com/detail/bcpkijoolaciolfegopiaifmoedbolgg/reviews" target="_blank" rel="noopener noreferrer">★ Rate on Chrome Web Store</a>
      </div>
      <div id="btns" class="btns">
        <button id="pause" type="button">Pause</button>
        <button id="stop" type="button">Stop</button>
      </div>
    </section>`;
    shadow.querySelector('.a').textContent = account?.username ? `@${account.username}` : 'Active account';
    shadow.getElementById('jobReviewLink').addEventListener('click', () => {
      chrome.storage.local.set({ reviewPromptStatus: 'clicked' }).catch(() => {});
      setTimeout(() => X.overlayHost?.remove(), 300);
    });
    shadow.getElementById('pause').addEventListener('click', () => {
      if (X.paused) window.__xCleanerResume?.();
      else window.__xCleanerPause?.();
    });
    shadow.getElementById('stop').addEventListener('click', () => {
      if (!X.interval) {
        const box = shadow.getElementById('jobReview');
        if (box && !box.hidden) chrome.storage.local.set({ reviewPromptStatus: 'dismissed' }).catch(() => {});
        X.overlayHost?.remove();
      } else {
        stop('Stopped by user');
      }
    });
    (document.body || document.documentElement).appendChild(host);
    X.overlayHost = host;
    updateOverlay();
    X.overlayTimer = setInterval(updateOverlay, 500);
  };

  window.__xCleanerPause = () => {
    if (!X.interval || X.paused) return;
    X.paused = true;
    X.pauseStartedAt = Date.now();
    X.overlayHost?.shadowRoot?.querySelector('.c')?.classList.add('paused');
    updateOverlay();
  };
  window.__xCleanerResume = () => {
    if (!X.interval || !X.paused) return;
    X.paused = false;
    if (X.pauseStartedAt) X.pausedTotalMs += (Date.now() - X.pauseStartedAt);
    X.pauseStartedAt = null;
    X.overlayHost?.shadowRoot?.querySelector('.c')?.classList.remove('paused');
    updateOverlay();
  };

  const stop = async reason => {
    if (X.interval) clearInterval(X.interval);
    if (X.keepAlive) clearInterval(X.keepAlive);
    if (X.overlayTimer) clearInterval(X.overlayTimer);
    X.interval = null;
    X.keepAlive = null;
    X.paused = false;
    X.issue = reason;
    X.performanceStyle?.remove();
    updateOverlay();
    const historySave = persist(reason);
    const shadow = X.overlayHost?.shadowRoot;
    if (shadow) {
      shadow.querySelector('.c')?.classList.add('done');
      shadow.querySelector('.k').textContent = reason;
      shadow.getElementById('pause').hidden = true;
      shadow.getElementById('btns').classList.add('single');
      const stopBtn = shadow.getElementById('stop');

      if (/rate.?limit/i.test(reason || '')) {
        stopBtn.textContent = 'Dismiss';
        stopBtn.disabled = false;
      } else {
        const c = counts();
        const total = c.tweets + c.replies + c.unliked + c.unreposted + c.unfollows;
        const eligible = (/^Finished/i.test(reason || '') && total >= 5) || (/Stopped by user/i.test(reason || '') && total >= 10);
        let promptStatus = null;
        if (eligible) {
          try { promptStatus = (await chrome.storage.local.get(['reviewPromptStatus'])).reviewPromptStatus || null; } catch {}
        }
        if (eligible && !promptStatus) {
          const label = type === 'unfollow' ? 'Unfollowed' : type === 'likes' ? 'Cleared' : type === 'reposts' ? 'Removed' : 'Deleted';
          const noun = type === 'unfollow' ? 'accounts' : type;
          shadow.getElementById('jobReviewCopy').textContent = `${label} ${total.toLocaleString()} ${noun} for free. Saved you time?`;
          shadow.getElementById('jobReview').hidden = false;
          stopBtn.textContent = 'Dismiss';
          stopBtn.disabled = false;
        } else {
          stopBtn.disabled = true;
          setTimeout(() => X.overlayHost?.remove(), 2200);
        }
      }
    }
    await historySave;
  };
  window.__xCleanerStop = () => stop('Stopped by user');

  if (performanceMode && !(type === 'media' && replyScope === 'photo')) {
    const style = document.createElement('style');
    style.textContent = type === 'media'
      ? 'article[data-testid="tweet"] video{visibility:hidden!important}'
      : 'article[data-testid="tweet"] [data-testid="tweetPhoto"],article[data-testid="tweet"] [data-testid="videoPlayer"],article[data-testid="tweet"] video{display:none!important}';
    (document.head || document.documentElement).appendChild(style);
    X.performanceStyle = style;
  }

  createOverlay();
  window.scrollTo({ top: 0, behavior: 'auto' });
  X.keepAlive = setInterval(() => document.body?.setAttribute('data-xbc-keepalive', String(Date.now())), 25000);

  const cycleMs = fast ? 1500 : 2400;
  const stepDelay = (base) => (fast ? Math.round(base * 0.55) : base);

  X.interval = setInterval(async () => {
    if (X.busy || X.paused || !X.interval) return;
    X.busy = true;
    try {
      const issue = detectIssue();
      if (issue) { await stop(issue); return; }
      const candidates = [];
      const scopeRoot = document.querySelector('[data-testid="primaryColumn"]') || document;

      if (type === 'unfollow') {
        for (const cell of scopeRoot.querySelectorAll('[data-testid="UserCell"]')) {
          const id = userHandle(cell);
          if (!id || X.processed.has(id) || protectedSet.has(id)) continue;
          if (isSelected && !selected.has(id)) continue;
          const control = Array.from(cell.querySelectorAll('button')).find(button => {
            const testId = button.getAttribute('data-testid') || '';
            return testId.endsWith('-unfollow') || /^following$/i.test((button.textContent || '').trim());
          });
          if (control && control.offsetParent !== null) candidates.push({ cell, id, control });
        }
      } else if (type === 'media' && replyScope === 'photo') {
        for (const a of scopeRoot.querySelectorAll('li a[href*="/status/"], a[href*="/photo/"]')) {
          const href = a.getAttribute('href') || '';
          const id = href.match(/\/status\/(\d+)/)?.[1] || null;
          if (!id || X.processed.has(id)) continue;
          if (isSelected && !selected.has(id)) continue;
          if (a.offsetParent !== null) candidates.push({ id, control: a, href });
        }
      } else {
        for (const article of scopeRoot.querySelectorAll('article[data-testid="tweet"]')) {
          const id = tweetId(article);
          if (!id || X.processed.has(id)) continue;
          if (isSelected && !selected.has(id)) continue;

          if (type === 'likes') {
            const control = article.querySelector('[data-testid="unlike"]');
            if (control) candidates.push({ article, id, control });
          } else if (type === 'reposts') {
            const control = article.querySelector('[data-testid="unretweet"]');
            if (control) candidates.push({ article, id, control });
          } else {
            if (me && authorHandle(article) !== me) continue;
            const selectedItem = isSelected ? selected.get(id) : null;
            if (type === 'replies') {
              const allowStandalone = isSelected
                ? ['orphan', 'standalone'].includes(selectedItem?.classification)
                : replyScope === 'all';
              if (!allowStandalone && !isReply(article)) continue;
            }
            if (type === 'tweets' && isReply(article)) continue;
            const control = article.querySelector('[data-testid="caret"]');
            if (control) candidates.push({ article, id, control });
          }
        }
      }

      let handled = 0;
      const maxPerCycle = fast ? 5 : (type === 'likes' ? 4 : (type === 'media' && replyScope === 'photo' ? 2 : 3));
      for (const { id, control, article, cell, href } of candidates) {
        if (!X.interval || X.paused) break;
        X.processed.add(id);
        const snap = isSelected ? selected.get(id) : (type === 'unfollow' ? userSnap(cell) : article ? tweetSnap(article) : { id, url: href || `/${me || ''}/status/${id}` });

        if (type === 'likes') {
          control.click();
          if (await stopIfIssue(stepDelay(480))) break;
          X.backup.unliked.push({ id, date: snap?.date || '', text: snap?.text || '', author: snap?.author || '', url: snap?.url || '', action: 'unliked', actionAt: new Date().toISOString() });
          X.succeededIds.add(id);
          X.successCount++;
          updateOverlay();
          await sleep(stepDelay(550));
        } else if (type === 'unfollow') {
          control.click();
          await sleep(stepDelay(550));
          const confirmed = await clickConfirm('confirmationSheetConfirm');
          if (await stopIfIssue(confirmed ? stepDelay(850) : 0)) break;
          if (confirmed) {
            X.backup.unfollows.push({
              username: snap?.username || id,
              displayName: snap?.displayName || snap?.text || id,
              profileUrl: snap?.url?.startsWith('/') ? `https://x.com${snap.url}` : snap?.profileUrl || snap?.url || `https://x.com/${id}`,
              action: 'unfollowed',
              actionAt: new Date().toISOString()
            });
            X.succeededIds.add(id);
            X.successCount++;
            updateOverlay();
          }
          await sleep(stepDelay(800));
        } else if (type === 'reposts') {
          control.click();
          await sleep(stepDelay(500));
          if (await clickConfirm('unretweetConfirm')) {
            X.backup.unreposted.push({ id, date: snap?.date || '', text: snap?.text || '', author: snap?.author || '', url: snap?.url || '', action: 'unreposted', actionAt: new Date().toISOString() });
            X.succeededIds.add(id);
            X.successCount++;
            updateOverlay();
          }
          await sleep(stepDelay(650));
        } else if (type === 'media' && replyScope === 'photo') {
          control.click();
          let dialog = null;
          let modalCaret = null;
          for (let w = 0; w < 14; w++) {
            dialog = document.querySelector('[role="dialog"], [aria-modal="true"]');
            modalCaret = dialog?.querySelector('[data-testid="caret"]') || null;
            if (modalCaret && modalCaret.offsetParent !== null) break;
            await sleep(stepDelay(160));
          }
          if (modalCaret) {
            const modalArticle = dialog?.querySelector('article[data-testid="tweet"]');
            const modalDate = modalArticle?.querySelector('time')?.getAttribute('datetime') || snap?.date || '';
            const modalText = modalArticle?.querySelector('[data-testid="tweetText"]')?.textContent || snap?.text || '';
            modalCaret.click();
            await sleep(stepDelay(500));
            if (await clickDeleteMenu()) {
              await sleep(stepDelay(450));
              if (await clickConfirm('confirmationSheetConfirm')) {
                X.backup.media.push({
                  id, date: modalDate, text: modalText, author: snap?.author || me || '',
                  url: snap?.url || `/${me || ''}/status/${id}`, mediaKind: 'photo',
                  action: 'deleted_photo', actionAt: new Date().toISOString()
                });
                X.succeededIds.add(id);
                X.successCount++;
                updateOverlay();
              }
            }
          }
          await sleep(stepDelay(700));
          const stillOpen = document.querySelector('[role="dialog"], [aria-modal="true"]');
          if (stillOpen) {
            const closeBtn = stillOpen.querySelector('[data-testid="app-bar-close"]');
            if (closeBtn) closeBtn.click();
            else document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
            await sleep(stepDelay(350));
          }
        } else {
          control.click();
          await sleep(stepDelay(500));
          if (await clickDeleteMenu()) {
            await sleep(stepDelay(450));
            if (await clickConfirm('confirmationSheetConfirm')) {
              const standalone = type === 'replies' && snap?.classification === 'standalone';
              const row = {
                id, date: snap?.date || '', text: snap?.text || '', author: snap?.author || me || '',
                url: snap?.url || '', classification: snap?.classification || '',
                ...(type === 'media' ? { mediaKind: 'video' } : {}),
                action: type === 'media' ? 'deleted_video' : type === 'replies' && !standalone ? 'deleted_reply' : 'deleted',
                actionAt: new Date().toISOString()
              };
              if (type === 'media') X.backup.media.push(row);
              else if (type === 'replies' && !standalone) X.backup.replies.push(row);
              else X.backup.tweets.push(row);
              X.succeededIds.add(id);
              X.successCount++;
              updateOverlay();
            }
          }
          await sleep(stepDelay(750));
        }
        handled++;
        if (handled >= maxPerCycle) break;
      }

      if (isSelected && X.successCount >= selected.size) {
        await stop(`Finished — ${X.successCount} ${progressVerb}`);
        return;
      }
      if (!candidates.length && atBottom()) X.emptyCycles++;
      else X.emptyCycles = 0;
      if (X.emptyCycles >= 6) {
        await stop(`Finished — ${X.successCount} ${progressVerb}`);
        return;
      }
      if (candidates.length <= handled) window.scrollBy(0, Math.max(520, window.innerHeight * 0.75));
    } finally {
      X.busy = false;
    }
  }, cycleMs);

  return { ok: true };
}

// === UI View & Tab Rendering ===

function updateTabBadges() {
  for (const t of TYPES) {
    const badge = $(`badge-${t}`);
    const count = tabCache[t].items.length;
    if (badge) {
      badge.textContent = count > 999 ? '999+' : String(count);
      badge.hidden = !count;
    }
  }
}

function updateTabWarning() {
  const warn = $('otherTabWarning');
  const activeWorkType = cleanupRunning ? cleanupType : activeScanType;
  if (activeWorkType && activeWorkType !== currentType) {
    const label = activeWorkType === 'unfollow' ? 'Following' : activeWorkType[0].toUpperCase() + activeWorkType.slice(1);
    $('otherTabWarningText').textContent = cleanupRunning
      ? `Cleaning ${label} in progress.`
      : `Scanning ${label} in progress.`;
    warn.hidden = false;
  } else {
    warn.hidden = true;
  }
}

function sortOptionsForType() {
  if (isFollowingType()) return [['newest', 'Default order'], ['az', 'A – Z'], ['notback', 'Not following back']];
  if (isPhotoMediaView()) return [['newest', 'Default order']];
  return [['newest', 'Newest'], ['oldest', 'Oldest'], ['likes', 'Most liked']];
}

function renderSortMenu() {
  const opts = sortOptionsForType();
  if (!opts.some(([v]) => v === currentSort)) currentSort = opts[0][0];
  const activeOpt = opts.find(([v]) => v === currentSort) || opts[0];
  $('sortBtnLabel').textContent = activeOpt[1];

  const menu = $('sortMenu');
  menu.replaceChildren();
  for (const [val, label] of opts) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'sort-option';
    btn.setAttribute('role', 'menuitemradio');
    btn.setAttribute('aria-checked', val === currentSort ? 'true' : 'false');
    const txt = document.createElement('span');
    txt.textContent = label;
    const chk = document.createElement('span');
    chk.className = 'sort-check';
    chk.textContent = '✓';
    btn.append(txt, chk);
    btn.addEventListener('click', () => {
      currentSort = val;
      renderSortMenu();
      menu.hidePopover();
      $('scrollBody').scrollTop = 0;
      refreshList();
    });
    menu.appendChild(btn);
  }
}

function syncToolbarForType() {
  const isFollow = isFollowingType();
  const isPhotoGrid = isPhotoMediaView();
  $('postChips').hidden = isFollow || isPhotoGrid;
  $('followingChips').hidden = !isFollow;
  $('postFilterFields').hidden = isFollow || isPhotoGrid;
  $('followingFilterFields').hidden = !isFollow;
  $('filterToggle').hidden = isPhotoGrid;
  if (isPhotoGrid) {
    $('filterDrawer').hidden = true;
    $('filterToggle').setAttribute('aria-expanded', 'false');
  }
  $('resultSearch').placeholder = isFollow
    ? 'Filter by name, @handle, or bio…'
    : isPhotoGrid ? 'Filter by alt text or status ID…' : 'Filter by keyword or @author…';
  renderSortMenu();
}

function syncIdleViewForType() {
  const type = currentType;
  const isReplies = type === 'replies';
  const isMedia = isMediaType(type);
  const isPhotoGrid = isMedia && selectedMediaScope() === 'photo';
  const isFollow = isFollowingType(type);
  $('replyScope').hidden = !isReplies;
  $('replyScopeNote').hidden = !(isReplies && selectedReplyScope() === 'all');
  $('mediaScope').hidden = !isMedia;
  $('prescanBox').hidden = isPhotoGrid;
  $('prescanDateChips').hidden = isFollow || isPhotoGrid;
  $('prescanKeyword').placeholder = isFollow ? 'Name, @handle, or bio…' : 'Keyword or @author…';

  const noun = typeNoun(type, 2);
  $('startScan').textContent = `Scan ${type === 'unfollow' ? 'following' : noun}`;

  const bulkBtn = $('startBulkAll');
  bulkBtn.classList.toggle('reversible', !isPermanentType(type));
  bulkBtn.textContent =
    type === 'unfollow' ? 'Unfollow all without preview…'
      : type === 'likes' ? 'Clear likes without preview…'
        : type === 'reposts' ? 'Remove reposts without preview…'
          : `Delete ${noun} without preview…`;

  const cache = currentCache(type);
  const hasCached = cache.items.length > 0 && !!cache.scannedAt;
  const ready = !!activeAccount?.username;
  const lastCard = $('lastScanCard');
  if (hasCached) {
    $('lastScanText').textContent = `Last scan · ${formatRelativeTime(cache.scannedAt)}`;
    lastCard.hidden = false;
  } else {
    lastCard.hidden = true;
  }

  const showFirstEmpty = ready && !hasCached;
  $('firstScanEmpty').hidden = !showFirstEmpty;
  const mascot = $('profileMascot');
  if (mascot) mascot.hidden = showFirstEmpty;
  if (showFirstEmpty) {
    const tips = {
      tweets: 'Scan your profile to preview, filter by date or likes, and choose which tweets to delete.',
      replies: 'Scan your replies tab to review threads and pick only the replies you want removed.',
      media: selectedMediaScope() === 'video'
        ? 'Scan your video posts to preview thumbnails and choose which videos to delete.'
        : 'Scan your photo grid to preview thumbnails and delete selected photo posts in place.',
      likes: 'Scan your likes to search by keyword or date and unlike selected posts.',
      reposts: 'Scan your reposts tab to review reposts and undo only the ones you choose.',
      unfollow: 'Scan your following list to find one-way follows and protect favorites before unfollowing.'
    };
    $('firstScanTip').textContent = tips[type] || tips.tweets;
  }
}

function openSettings(scrollToId = null) {
  settingsOpen = true;
  $('openSettingsBtn').classList.add('active');
  $('settingsNewDot').hidden = true;
  const ver = chrome.runtime.getManifest?.().version || '1.6.0';
  chrome.storage.local.set({ lastSeenSettingsVersion: ver }).catch(() => {});
  $('headerBrand').hidden = true;
  $('settingsBackBtn').hidden = false;
  $('categoryTabs').hidden = true;
  $('otherTabWarning').hidden = true;
  $('statusBar').hidden = true;
  $('reviewToolbar').hidden = true;
  $('bottomBar').hidden = true;
  $('idleBottomBar').hidden = true;
  $('noAccountEmpty').hidden = true;
  $('idleView').hidden = true;
  $('listView').hidden = true;
  $('doneView').hidden = true;
  $('settingsView').hidden = false;
  syncAccountChrome();
  if (scrollToId) {
    const target = $(scrollToId);
    if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    if (scrollToId === 'whitelistSection') $('whitelistInput')?.focus();
  } else {
    $('scrollBody').scrollTop = 0;
  }
}

function closeSettings() {
  if (!settingsOpen) return;
  settingsOpen = false;
  $('openSettingsBtn').classList.remove('active');
  $('headerBrand').hidden = false;
  $('settingsBackBtn').hidden = true;
  $('settingsView').hidden = true;
  $('categoryTabs').hidden = false;
  $('noAccountEmpty').hidden = !!activeAccount?.username;
  setView(viewMode);
}

function setView(nextMode) {
  viewMode = nextMode;
  if (settingsOpen) return;
  const isIdle = nextMode === 'idle';
  const isDone = nextMode === 'done';
  const showList = nextMode === 'scanning' || nextMode === 'paused' || nextMode === 'stopped' || nextMode === 'review';

  $('idleView').hidden = !isIdle;
  $('doneView').hidden = !isDone;
  $('listView').hidden = !showList;
  $('statusBar').hidden = isIdle || isDone;
  $('reviewToolbar').hidden = !showList;
  $('bottomBar').hidden = !showList;

  if (isIdle) syncIdleViewForType();
  if (showList) {
    syncToolbarForType();
    refreshList();
  }
  syncAccountChrome();
  updateTabBadges();
  updateTabWarning();
}

function selectCategoryTab(type, focusTab = false) {
  currentType = TYPES.includes(type) ? type : 'tweets';
  const tabs = Array.from(document.querySelectorAll('#categoryTabs [role="tab"]'));
  for (const tab of tabs) {
    const active = tab.dataset.type === currentType;
    tab.setAttribute('aria-selected', active ? 'true' : 'false');
    tab.tabIndex = active ? 0 : -1;
    if (active) {
      tab.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      if (focusTab) tab.focus();
    }
  }
  lastClickedIndex = null;
  $('scrollBody').scrollTop = 0;

  if (cleanupRunning && cleanupType === currentType) {
    setView('deleting');
  } else if (activeScanType === currentType) {
    setView('scanning');
  } else {
    const cache = currentCache(currentType);
    if (cache.items.length && cache.scanState !== 'idle') {
      renderCachedStatusBar(cache);
      setView(cache.scanState === 'done' ? 'review' : cache.scanState);
    } else {
      setView('idle');
    }
  }
  scheduleSessionSave();
}

function collapseDoneBanner() {
  clearTimeout(doneCollapseTimer);
  const bar = $('statusBar');
  if (!bar || bar.dataset.state !== 'done') return;
  const cache = currentCache();
  const n = cache.items.length;
  const noun = typeNoun(currentType, n);
  const parts = ['Scan complete', `${n.toLocaleString()} ${noun}`];
  if (cache.scanDurationSec != null) parts.push(formatClock(cache.scanDurationSec));
  $('statusEyebrow').textContent = parts.join(' · ');
  bar.classList.add('done-compact');
}

function showDoneBanner(type, cache, autoCollapse = true) {
  clearTimeout(doneCollapseTimer);
  const n = cache.items.length;
  const noun = typeNoun(type, n);
  const parts = ['Scan complete', `${n.toLocaleString()} ${noun}`];
  if (cache.scanDurationSec != null) parts.push(formatClock(cache.scanDurationSec));
  const oldest = type === 'unfollow' ? '' : formatOldestDate(cache.items);
  $('statusBar').classList.remove('done-compact');
  updateStatusBarUI({
    state: 'done',
    progressMode: 'determinate',
    percent: 100,
    eyebrow: parts.join(' · '),
    countText: oldest,
    action: { text: 'New scan', variant: 'secondary' }
  });
  $('statusCountText').parentElement.hidden = !oldest;
  if (autoCollapse) {
    doneCollapseTimer = setTimeout(collapseDoneBanner, 3500);
  } else {
    collapseDoneBanner();
  }
}

function updateStatusBarUI({ state, progressMode = 'shimmer', percent = 0, eyebrow, countText, note = '', noteWarn = false, action = null, subLink = null }) {
  const bar = $('statusBar');
  if (state !== 'done') {
    clearTimeout(doneCollapseTimer);
    bar.classList.remove('done-compact');
  }
  bar.dataset.state = state;
  bar.dataset.progress = progressMode;
  $('statusDoneIcon').hidden = state !== 'done';
  $('statusEyebrow').textContent = eyebrow;
  $('statusCountText').textContent = countText;
  $('statusCountText').parentElement.hidden = !countText;

  const track = $('statusProgressTrack');
  const fill = $('statusProgressFill');
  track.hidden = state === 'review' || state === 'done';
  if (progressMode === 'determinate') {
    const p = Math.max(0, Math.min(100, percent));
    fill.style.width = `${p}%`;
    track.setAttribute('aria-valuenow', String(p));
  } else {
    fill.style.width = '';
    track.removeAttribute('aria-valuenow');
  }

  const noteEl = $('statusNote');
  noteEl.textContent = note;
  noteEl.classList.toggle('warn', !!noteWarn);
  noteEl.hidden = !note;

  const btn = $('statusActionBtn');
  if (action) {
    btn.hidden = false;
    btn.textContent = action.text;
    btn.disabled = !!action.disabled;
    btn.className = `status-action-btn ${action.variant || 'secondary'}`;
  } else {
    btn.hidden = true;
  }

  const sub = $('statusSubLink');
  if (subLink) {
    sub.hidden = false;
    sub.textContent = subLink;
  } else {
    sub.hidden = true;
  }
}

function scanProgressDescriptor(type, cache, elapsedSec = null) {
  const n = cache.items.length;
  const noun = typeNoun(type, n);
  const est = cache.estimatedTotal;
  const isFollowing = type === 'unfollow';
  const isPostsPlusReplies = type === 'replies' && cache.replyScope === 'all';
  const hasDeterminate = (isFollowing || isPostsPlusReplies) && est && est > 0;
  const pct = hasDeterminate ? Math.min(100, Math.round((n / est) * 100)) : 0;

  let countText;
  if (isFollowing && hasDeterminate) {
    countText = `${n.toLocaleString()} / ${est.toLocaleString()} ${noun} found`;
  } else if (isPostsPlusReplies && hasDeterminate) {
    countText = `${n.toLocaleString()} / ~${est.toLocaleString()} approx. found`;
  } else {
    const parts = [`${n.toLocaleString()} ${noun} found`];
    if (elapsedSec != null) parts.push(formatClock(elapsedSec));
    const reached = formatReachedMonth(cache.items);
    if (reached) parts.push(reached);
    countText = parts.join(' · ');
  }

  if (hasDeterminate && elapsedSec != null) {
    countText += ` · ${formatClock(elapsedSec)}`;
  }

  return { hasDeterminate, pct, countText };
}

function renderCachedStatusBar(cache) {
  const desc = scanProgressDescriptor(currentType, cache, null);
  if (cache.scanState === 'done') {
    showDoneBanner(currentType, cache, false);
  } else {
    const label = cache.scanState === 'paused' ? 'Scan paused' : 'Scan stopped by user';
    updateStatusBarUI({
      state: cache.scanState === 'paused' ? 'paused' : 'stopped',
      progressMode: desc.hasDeterminate ? 'determinate' : 'shimmer',
      percent: desc.pct,
      eyebrow: label,
      countText: desc.countText,
      action: { text: 'Resume', variant: 'primary' },
      subLink: 'New scan'
    });
  }
}

// === Filtering, Sorting & Virtualized List ===

function resetFilters() {
  datePreset = 'all';
  filterNotFollowingBack = false;
  filterNoAvatar = false;
  $('resultSearch').value = '';
  $('dateFrom').value = '';
  $('dateTo').value = '';
  $('minLikes').value = '';
  $('filterMediaOnly').checked = false;
  $('filterHasLinks').checked = false;
  $('filterHideProtected').checked = false;
  document.querySelectorAll('#postChips .chip').forEach(c => c.setAttribute('aria-pressed', c.dataset.preset === 'all' ? 'true' : 'false'));
  $('chipNotFollowingBack').setAttribute('aria-pressed', 'false');
  $('chipNoAvatar').setAttribute('aria-pressed', 'false');
}

function countActiveFilters() {
  let c = 0;
  if (isFollowingType()) {
    if (filterNotFollowingBack) c++;
    if (filterNoAvatar) c++;
    if ($('filterHideProtected').checked) c++;
  } else {
    if (datePreset !== 'all' || $('dateFrom').value || $('dateTo').value) c++;
    if ($('minLikes').value.trim() !== '' && Number($('minLikes').value) > 0) c++;
    if ($('filterMediaOnly').checked) c++;
    if ($('filterHasLinks').checked) c++;
  }
  return c;
}

function resolveDateRange() {
  if (isFollowingType()) return { from: null, to: null };
  const customFrom = $('dateFrom').value ? new Date(`${$('dateFrom').value}T00:00:00`).getTime() : null;
  const customTo = $('dateTo').value ? new Date(`${$('dateTo').value}T23:59:59`).getTime() : null;
  if (customFrom || customTo) return { from: customFrom, to: customTo };
  const now = Date.now();
  if (datePreset === '30d') return { from: now - 30 * 86400000, to: null };
  if (datePreset === '90d') return { from: now - 90 * 86400000, to: null };
  if (datePreset === 'older1y') return { from: null, to: now - 365 * 86400000 };
  return { from: null, to: null };
}

function computeFilteredAndSorted() {
  const items = currentCache().items || [];
  const query = $('resultSearch').value.trim().toLowerCase();
  const isFollow = isFollowingType();
  const { from, to } = resolveDateRange();
  const minLikesRaw = isFollow ? '' : $('minLikes').value.trim();
  const minLikes = minLikesRaw === '' ? null : Math.max(0, Number(minLikesRaw) || 0);
  const mediaOnly = !isFollow && $('filterMediaOnly').checked;
  const hasLinksOnly = !isFollow && $('filterHasLinks').checked;
  const hideProtected = isFollow && $('filterHideProtected').checked;

  const list = items.filter(item => {
    if (query) {
      const hay = [item.id, item.text, item.displayName, item.username, item.author, item.bio, item.replyingTo].filter(Boolean).join(' ').toLowerCase();
      if (!hay.includes(query)) return false;
    }
    if (isFollow) {
      if (filterNotFollowingBack && item.followsYou) return false;
      if (filterNoAvatar && !item.noAvatar) return false;
      if (hideProtected && whitelist.has((item.username || item.id || '').toLowerCase())) return false;
      return true;
    }
    if (isPhotoMediaView()) return true;
    const time = item.date ? new Date(item.date).getTime() : null;
    if (from && (!time || time < from)) return false;
    if (to && (!time || time > to)) return false;
    if (minLikes !== null && (Number(item.likes) || 0) < minLikes) return false;
    if (mediaOnly && !item.hasMedia) return false;
    if (hasLinksOnly && !item.hasLinks) return false;
    return true;
  });

  // Live stream while scanning: show most recently discovered at the top!
  if (viewMode === 'scanning') {
    list.sort((a, b) => (b.discoveredAt || 0) - (a.discoveredAt || 0));
    return list;
  }

  const sort = currentSort;
  if (isFollow) {
    if (sort === 'az') list.sort((a, b) => (a.displayName || a.username || '').localeCompare(b.displayName || b.username || ''));
    else if (sort === 'notback') list.sort((a, b) => Number(!!a.followsYou) - Number(!!b.followsYou));
  } else if (!isPhotoMediaView()) {
    if (sort === 'oldest') list.sort((a, b) => (new Date(a.date || 0).getTime()) - (new Date(b.date || 0).getTime()));
    else if (sort === 'likes') list.sort((a, b) => (b.likes || 0) - (a.likes || 0));
    else list.sort((a, b) => (new Date(b.date || 0).getTime()) - (new Date(a.date || 0).getTime()));
  }
  return list;
}

function isSelectable(item) {
  if (!item || item.classification === 'unresolved') return false;
  if (isFollowingType() && whitelist.has((item.username || item.id || '').toLowerCase())) return false;
  return true;
}

function updateSelectionUI() {
  const allItems = currentCache().items || [];
  const selectedTotal = allItems.filter(i => i.selected && isSelectable(i)).length;
  const filteredSelectable = cachedFiltered.filter(isSelectable);
  const filteredSelected = filteredSelectable.filter(i => i.selected).length;

  const cb = $('selectAllCheckbox');
  cb.disabled = !filteredSelectable.length;
  cb.checked = filteredSelectable.length > 0 && filteredSelected === filteredSelectable.length;
  cb.indeterminate = filteredSelected > 0 && filteredSelected < filteredSelectable.length;
  $('selectAllLabel').textContent = `${selectedTotal.toLocaleString()} of ${cachedFiltered.length.toLocaleString()}`;

  const protEl = $('protectedCounter');
  if (isFollowingType()) {
    const protCount = allItems.filter(i => whitelist.has((i.username || i.id || '').toLowerCase())).length;
    protEl.textContent = `${protCount.toLocaleString()} protected`;
    protEl.hidden = protCount === 0;
  } else {
    protEl.hidden = true;
  }

  const cta = $('actionCta');
  cta.dataset.tone = isPermanentType() ? 'danger' : 'reversible';
  cta.disabled = !selectedTotal || cleanupRunning;
  cta.textContent = destructiveLabel(selectedTotal);

  const fCount = countActiveFilters();
  const badge = $('filterBadge');
  badge.textContent = String(fCount);
  badge.hidden = !fCount;
  $('filterToggle').classList.toggle('active', fCount > 0);
}

function toggleItemSelection(item, index, shiftKey) {
  if (!isSelectable(item)) return;
  const nextVal = !item.selected;
  if (shiftKey && lastClickedIndex !== null && lastClickedIndex < cachedFiltered.length) {
    const start = Math.min(lastClickedIndex, index);
    const end = Math.max(lastClickedIndex, index);
    for (let i = start; i <= end; i++) {
      if (isSelectable(cachedFiltered[i])) cachedFiltered[i].selected = nextVal;
    }
  } else {
    item.selected = nextVal;
  }
  lastClickedIndex = index;
  if (nextVal && $('statusBar').dataset.state === 'done') collapseDoneBanner();
  renderVirtualWindow();
  updateSelectionUI();
  scheduleSessionSave();
}

function createRowElement(item, index) {
  const isFollow = item.type === 'account';
  const isMediaItem = item.mediaKind === 'photo' || item.mediaKind === 'video';
  const handleLower = (item.username || item.id || '').toLowerCase();
  const isProtected = isFollow && whitelist.has(handleLower);
  const selectable = isSelectable(item);

  const card = document.createElement('div');
  card.className = `row-card${isFollow ? ' account-row' : ''}${isMediaItem ? ' media-row' : ''}${item.selected && selectable ? ' selected' : ''}${isProtected ? ' protected' : ''}${!selectable && !isProtected ? ' unverified' : ''}`;
  card.setAttribute('role', 'option');
  card.setAttribute('aria-selected', item.selected && selectable ? 'true' : 'false');
  if (isProtected) card.title = 'Skipped during unfollow';
  card.tabIndex = 0;

  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.className = 'row-check';
  cb.checked = !!(item.selected && selectable);
  cb.disabled = !selectable;
  cb.tabIndex = -1;
  cb.setAttribute('aria-label', isFollow ? `Select @${item.username}` : 'Select item');
  cb.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleItemSelection(item, index, e.shiftKey);
  });

  card.addEventListener('click', (e) => {
    if (e.target.closest('.row-hit')) return;
    toggleItemSelection(item, index, e.shiftKey);
  });
  card.addEventListener('keydown', (e) => {
    if (e.key === ' ') {
      e.preventDefault();
      toggleItemSelection(item, index, e.shiftKey);
    }
  });

  card.appendChild(cb);

  if (isFollow) {
    const av = document.createElement('div');
    av.className = 'row-avatar';
    if (item.avatarUrl && !item.noAvatar) {
      const img = document.createElement('img');
      img.alt = '';
      img.src = item.avatarUrl;
      img.addEventListener('error', () => { img.remove(); av.textContent = (item.displayName || item.username || '?').slice(0, 2); });
      av.appendChild(img);
    } else {
      av.textContent = (item.displayName || item.username || '?').slice(0, 2);
    }
    card.appendChild(av);
  } else if (isMediaItem) {
    const thumb = document.createElement('div');
    thumb.className = 'row-thumb';
    if (item.thumbUrl) {
      const img = document.createElement('img');
      img.alt = '';
      img.loading = 'lazy';
      img.referrerPolicy = 'no-referrer';
      img.src = item.thumbUrl;
      img.addEventListener('error', () => {
        img.remove();
        thumb.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#i-image"/></svg>';
      });
      thumb.appendChild(img);
    } else {
      thumb.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#i-image"/></svg>';
    }
    if (item.mediaKind === 'video') {
      const play = document.createElement('span');
      play.className = 'row-thumb-play';
      play.setAttribute('aria-hidden', 'true');
      play.textContent = '▶';
      thumb.appendChild(play);
    }
    card.appendChild(thumb);
  }

  const body = document.createElement('div');
  body.className = 'row-body';

  if (isFollow) {
    const titleLine = document.createElement('div');
    titleLine.className = 'row-title-line';
    const disp = document.createElement('span');
    disp.className = 'row-display';
    disp.textContent = item.displayName || item.username;
    const hnd = document.createElement('span');
    hnd.className = 'row-handle-sub';
    hnd.textContent = `@${item.username}`;
    titleLine.append(disp, hnd);
    body.appendChild(titleLine);

    if (item.bio) {
      const bio = document.createElement('div');
      bio.className = 'row-bio';
      bio.textContent = item.bio;
      body.appendChild(bio);
    }

    const meta = document.createElement('div');
    meta.className = 'row-meta';
    if (item.followsYou) {
      const fy = document.createElement('span');
      fy.className = 'pill follows-you';
      fy.textContent = 'Follows you';
      meta.appendChild(fy);
    }
    if (isProtected) {
      const pr = document.createElement('span');
      pr.className = 'pill protected-pill';
      pr.textContent = 'Protected';
      pr.title = 'Skipped during unfollow';
      meta.appendChild(pr);
    }
    if (item.noAvatar) {
      const na = document.createElement('span');
      na.className = 'pill';
      na.textContent = 'No photo';
      meta.appendChild(na);
    }
    if (meta.childNodes.length) body.appendChild(meta);
  } else {
    const text = document.createElement('div');
    text.className = 'row-text';
    text.textContent = item.text || (item.mediaKind === 'photo' ? 'Photo post' : item.mediaKind === 'video' ? 'Video post' : '(No text content)');
    body.appendChild(text);

    const meta = document.createElement('div');
    meta.className = 'row-meta';
    const dateStr = formatItemDate(item.date);
    const contextStr = item.type === 'reply'
      ? (item.replyingTo ? `Replying to ${item.replyingTo}` : 'Reply')
      : item.type === 'like' && item.author
        ? `@${item.author}`
        : item.mediaKind === 'photo'
          ? `Photo · #${String(item.id || '').slice(-6)}`
          : item.mediaKind === 'video'
            ? 'Video'
            : item.type;
    meta.append(document.createTextNode([dateStr, contextStr].filter(Boolean).join(' · ')));

    if (item.likes > 0 || $('minLikes').value !== '') {
      const lk = document.createElement('span');
      lk.className = 'pill likes-pill';
      lk.textContent = `♥ ${(item.likes || 0).toLocaleString()}`;
      meta.appendChild(lk);
    }
    if (item.hasMedia && !isMediaItem) {
      const md = document.createElement('span');
      md.className = 'pill';
      md.textContent = 'Media';
      meta.appendChild(md);
    }
    body.appendChild(meta);
  }

  card.appendChild(body);

  // Separate hit targets (external link + whitelist shield on Following)
  const actions = document.createElement('div');
  actions.className = 'row-actions';
  if (item.url) {
    const link = document.createElement('a');
    link.className = 'row-hit';
    link.href = item.url.startsWith('/') ? `https://x.com${item.url}` : item.url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.title = 'Open on X';
    link.setAttribute('aria-label', 'Open on X');
    link.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#i-external"/></svg>';
    link.addEventListener('click', e => e.stopPropagation());
    actions.appendChild(link);
  }
  if (isFollow) {
    const shield = document.createElement('button');
    shield.type = 'button';
    shield.className = `row-hit${isProtected ? ' active' : ''}`;
    shield.title = isProtected ? 'Remove from never-unfollow whitelist' : 'Never unfollow (protect)';
    shield.setAttribute('aria-label', isProtected ? `Unprotect @${item.username}` : `Protect @${item.username} from unfollow`);
    shield.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#i-shield"/></svg>';
    shield.addEventListener('click', (e) => {
      e.stopPropagation();
      if (whitelist.has(handleLower)) whitelist.delete(handleLower);
      else whitelist.add(handleLower);
      saveWhitelist();
    });
    actions.appendChild(shield);
  }
  if (actions.childNodes.length) card.appendChild(actions);

  return card;
}

function renderVirtualWindow(appendOnly = false) {
  const win = $('virtualWindow');
  const total = cachedFiltered.length;

  $('emptyResults').hidden = total > 0 || viewMode === 'scanning';
  if (!total) {
    win.replaceChildren();
    if (viewMode !== 'scanning') {
      const hasAny = currentCache().items.length > 0;
      $('emptyResultsText').textContent = hasAny ? 'No matching items' : `No ${typeNoun(currentType, 2)} found yet`;
      $('emptyClearFilters').hidden = !hasAny;
    }
    return;
  }

  const targetCount = Math.min(total, renderedCount);
  if (appendOnly) {
    const existing = win.childElementCount;
    if (existing >= targetCount) return;
    const frag = document.createDocumentFragment();
    for (let i = existing; i < targetCount; i++) {
      frag.appendChild(createRowElement(cachedFiltered[i], i));
    }
    win.appendChild(frag);
    return;
  }

  const frag = document.createDocumentFragment();
  for (let i = 0; i < targetCount; i++) {
    frag.appendChild(createRowElement(cachedFiltered[i], i));
  }
  win.replaceChildren(frag);
}

function refreshList() {
  cachedFiltered = computeFilteredAndSorted();
  renderedCount = Math.max(RENDER_BATCH, Math.min(renderedCount, cachedFiltered.length || RENDER_BATCH));
  renderVirtualWindow(false);
  updateSelectionUI();
}

// === Scan Lifecycle ===

async function startScan() {
  showError('');
  activeTab = await findActiveXTab();
  if (cleanupRunning) {
    showError('A cleanup job is currently running. Stop it before starting a scan.');
    return;
  }
  const detected = await detectAccount(activeTab);
  renderAccount(detected, !!activeTab);
  if (!activeTab || !activeAccount) {
    showError(detected?._status === 'error'
      ? 'Could not access the X tab. Reload x.com and try again.'
      : 'Open x.com and sign in before scanning.');
    return;
  }

  const type = currentType;
  const scope = type === 'media' ? selectedMediaScope() : selectedReplyScope();
  const cache = currentCache(type);
  cache.items = [];
  const profileStats = activeAccount?.stats || {};
  // Exact total for Following; approx upper bound for Posts + replies only; none for Tweets/Replies-only/Media/Reposts/Likes
  cache.estimatedTotal =
    type === 'unfollow' ? (profileStats.following ?? null)
      : (type === 'replies' && scope === 'all') ? (profileStats.posts ?? null)
        : null;
  cache.scannedAt = Date.now();
  cache.replyScope = type === 'replies' ? scope : cache.replyScope;
  if (type === 'media') cache.mediaScope = scope;
  cache.scanState = 'idle';

  // Carry over pre-scan filters cleanly
  resetFilters();
  const preKw = $('prescanKeyword').value.trim();
  if (preKw && !(type === 'media' && scope === 'photo')) $('resultSearch').value = preKw;
  if (!isFollowingType(type) && !(type === 'media' && scope === 'photo') && preDatePreset !== 'all') {
    datePreset = preDatePreset;
    document.querySelectorAll('#postChips .chip').forEach(c => {
      c.setAttribute('aria-pressed', c.dataset.preset === datePreset ? 'true' : 'false');
    });
  }

  await ensurePreviewPage(type, type === 'media' ? scope : null);
  activeTab = await findActiveXTab();
  const refreshed = await detectAccount(activeTab);
  if (refreshed?.username) {
    renderAccount(refreshed, true);
    if (!cache.estimatedTotal) {
      const s = refreshed.stats || {};
      cache.estimatedTotal =
        type === 'unfollow' ? (s.following ?? null)
          : (type === 'replies' && scope === 'all') ? (s.posts ?? null)
            : null;
    }
  }
  const res = await executeInTab(startPreviewScanner, [type, activeAccount, $('previewPerformance').checked, scope]);
  if (!res?.ok) {
    showError(res?.error || 'Could not start scan.');
    return;
  }

  activeScanType = type;
  pollMisses = 0;
  setAccountIssue('');
  await chrome.storage.local.set({
    activePreviewSession: { tabId: activeTab.id, type, replyScope: scope, account: activeAccount, startedAt: Date.now() }
  });

  const desc = scanProgressDescriptor(type, cache, 0);
  updateStatusBarUI({
    state: 'running',
    progressMode: desc.hasDeterminate ? 'determinate' : 'shimmer',
    percent: desc.pct,
    eyebrow: `Scanning ${type === 'unfollow' ? 'following' : typeNoun(type, 2)}`,
    countText: desc.countText,
    note: 'Keep the X tab open to continue scanning.',
    action: { text: 'Stop', variant: 'secondary' }
  });
  setView('scanning');
  startPolling();
}

async function pollLoop() {
  if (!activeTab) return;

  if (cleanupRunning) {
    const state = await executeInTab(readCleanupState);
    if (!state) {
      pollMisses++;
      if (pollMisses >= 3 && cleanupType === currentType) {
        setAccountIssue('Disconnected');
        updateStatusBarUI({
          state: 'stopped',
          progressMode: 'shimmer',
          eyebrow: 'Connection lost',
          countText: 'X tab disconnected',
          note: 'Reopen the X tab or start a new session.',
          noteWarn: true,
          action: { text: 'New scan', variant: 'secondary' }
        });
      }
      return;
    }
    pollMisses = 0;
    setAccountIssue('');
    cleanupPaused = !!state.paused;
    const count = state.successCount || 0;
    const total = state.totalTarget || 0;
    const verb = actionVerb(state.type, 'past');

    if (!state.running && (state.historyPersisted || state.historySaveError)) {
      cleanupRunning = false;
      cleanupPaused = false;
      clearInterval(pollTimer);
      pollTimer = null;
      await chrome.storage.local.remove(['activeAction', 'activeTabId', 'startTime']);

      const failedIds = new Set((state.failedItems || []).map(f => f.id));
      const cache = tabCache[state.type];
      if (cache && state.mode === 'selected') {
        cache.items = cache.items.filter(item => !item.selected || failedIds.has(item.id));
        cache.items.forEach(i => { i.selected = false; });
      }
      lastDoneResult = {
        jobId: state.jobId,
        type: state.type,
        succeeded: count,
        failedItems: state.failedItems || []
      };
      cleanupType = null;
      renderDoneView();
      setView('done');
      await renderReviewBanner();
      scheduleSessionSave();
      return;
    }

    if (cleanupType === currentType) {
      const pct = total ? Math.min(100, Math.round((count / total) * 100)) : 0;
      const elapsedSec = Math.floor((state.activeMs || 0) / 1000);
      let etaPart = formatClock(elapsedSec);
      if (total && count >= 2 && !state.paused) {
        const rem = Math.max(0, total - count);
        const etaSec = Math.max(1, Math.round((state.activeMs / count) * rem / 1000));
        etaPart = `${formatClock(elapsedSec)} · ~${etaSec < 60 ? `${etaSec}s` : `${Math.floor(etaSec / 60)}m`} left`;
      } else if (state.paused) {
        etaPart = 'Paused';
      }
      const note = state.tabHidden
        ? 'X tab is in background — keep it visible for steady progress.'
        : 'Keep the X tab open until cleanup finishes.';
      updateStatusBarUI({
        state: state.paused ? 'paused' : 'running',
        progressMode: total ? 'determinate' : 'shimmer',
        percent: pct,
        eyebrow: state.paused ? 'Cleanup paused' : `${actionVerb(state.type, 'ing')} ${typeNoun(state.type, 2)}`,
        countText: total
          ? `${count.toLocaleString()} / ${total.toLocaleString()} ${verb} (${pct}%) · ${etaPart}`
          : `${count.toLocaleString()} ${verb} · ${etaPart}`,
        note,
        noteWarn: !!state.tabHidden,
        action: { text: state.paused ? 'Resume' : 'Pause', variant: state.paused ? 'primary' : 'secondary' },
        subLink: 'Stop'
      });
    }
    return;
  }

  if (!activeScanType) return;
  const cache = tabCache[activeScanType];
  const state = await executeInTab(readPreviewState, [cache.items.length]);
  if (!state) {
    pollMisses++;
    if (pollMisses >= 3 && activeScanType === currentType) {
      setAccountIssue('Disconnected');
      const desc = scanProgressDescriptor(activeScanType, cache, null);
      updateStatusBarUI({
        state: 'stopped',
        progressMode: desc.hasDeterminate ? 'determinate' : 'shimmer',
        percent: desc.pct,
        eyebrow: 'Connection lost',
        countText: desc.countText,
        note: 'X tab was closed or navigated away.',
        noteWarn: true,
        action: { text: 'New scan', variant: 'secondary' }
      });
    }
    return;
  }
  pollMisses = 0;

  if (state.estimatedTotal && (activeScanType === 'unfollow' || (activeScanType === 'replies' && cache.replyScope === 'all'))) {
    cache.estimatedTotal = state.estimatedTotal;
  }
  if (state.newItems?.length) {
    cache.items.push(...state.newItems);
    cache.scannedAt = Date.now();
    updateTabBadges();
    if (activeScanType === currentType) refreshList();
    scheduleSessionSave();
  }

  const isRunning = state.running && !state.paused;
  const isPaused = state.running && state.paused;
  const isDone = !state.running && state.done;
  const isStopped = !state.running && !state.done;

  const count = cache.items.length;
  const noun = typeNoun(activeScanType, count);
  const elapsedSec = Math.max(0, Math.floor((Date.now() - (state.startedAt || Date.now())) / 1000));
  const desc = scanProgressDescriptor(activeScanType, cache, elapsedSec);

  if (isRunning) {
    cache.scanState = 'idle';
    if (activeScanType === currentType) {
      let note = 'Keep the X tab open to continue scanning.';
      let noteWarn = false;
      if (state.rateLimitSec > 0) {
        note = `Rate limited by X — waiting ${state.rateLimitSec}s…`;
        noteWarn = true;
        setAccountIssue('Rate limited');
      } else if (state.tabHidden) {
        note = 'X tab is in background — scanning may pause.';
        noteWarn = true;
        setAccountIssue('');
      } else {
        setAccountIssue('');
      }
      updateStatusBarUI({
        state: 'running',
        progressMode: desc.hasDeterminate ? 'determinate' : 'shimmer',
        percent: desc.pct,
        eyebrow: `Scanning ${activeScanType === 'unfollow' ? 'following' : typeNoun(activeScanType, 2)}`,
        countText: desc.countText,
        note,
        noteWarn,
        action: { text: 'Stop', variant: 'secondary' }
      });
    }
  } else if (isPaused) {
    cache.scanState = 'paused';
    activeScanType = null;
    clearInterval(pollTimer);
    pollTimer = null;
    setAccountIssue('');
    if (state.type === currentType) {
      renderCachedStatusBar(cache);
      setView('paused');
    }
    scheduleSessionSave();
  } else if (isStopped) {
    cache.scanState = 'stopped';
    activeScanType = null;
    clearInterval(pollTimer);
    pollTimer = null;
    setAccountIssue('');
    if (state.type === currentType) {
      renderCachedStatusBar(cache);
      setView('stopped');
    }
    scheduleSessionSave();
  } else if (isDone) {
    cache.scanState = 'done';
    cache.scanDurationSec = elapsedSec;
    const finishedType = activeScanType;
    activeScanType = null;
    clearInterval(pollTimer);
    pollTimer = null;
    setAccountIssue('');
    await chrome.storage.local.remove(['activePreviewSession']);
    if (finishedType === currentType) {
      showDoneBanner(finishedType, cache, true);
      setView('review');
    }
    scheduleSessionSave();
  }
}

function startPolling() {
  clearInterval(pollTimer);
  pollLoop();
  pollTimer = setInterval(pollLoop, 800);
}

async function resetCurrentScan() {
  clearInterval(pollTimer);
  pollTimer = null;
  activeScanType = null;
  setAccountIssue('');
  await executeInTab(controlPreviewScanner, ['reset']);
  await chrome.storage.local.remove(['activePreviewSession']);
  currentCache().scanState = 'idle';
  setView('idle');
  scheduleSessionSave();
}

async function handleStatusAction() {
  if (cleanupRunning) {
    await executeInTab(controlCleanupWorker, [cleanupPaused ? 'resume' : 'pause']);
    await pollLoop();
    return;
  }
  if (viewMode === 'scanning') {
    await executeInTab(controlPreviewScanner, ['stop']);
    await pollLoop();
    return;
  }
  if (viewMode === 'paused' || viewMode === 'stopped') {
    const res = await executeInTab(controlPreviewScanner, ['resume']);
    if (res) {
      activeScanType = currentType;
      setView('scanning');
      startPolling();
    } else {
      await startScan();
    }
    return;
  }
  // 'review' / 'done' -> New scan
  await resetCurrentScan();
}

async function handleStatusSubLink() {
  if (cleanupRunning) {
    await executeInTab(controlCleanupWorker, ['stop']);
    await pollLoop();
    return;
  }
  await resetCurrentScan();
}

// === Done Summary View ===

function renderDoneView() {
  if (!lastDoneResult) return;
  const { type, succeeded, failedItems } = lastDoneResult;
  const failed = (failedItems || []).length;
  const verb = actionVerb(type, 'past');
  $('doneTitle').textContent = failed ? 'Cleanup finished with some skipped' : 'Cleanup complete';
  $('doneSummary').textContent = failed
    ? `${succeeded.toLocaleString()} ${verb}, ${failed.toLocaleString()} failed`
    : `${succeeded.toLocaleString()} ${typeNoun(type, succeeded)} ${verb}`;
  $('doneIcon').classList.toggle('has-failures', failed > 0);
  $('doneRetryFailed').hidden = failed === 0;
  if (failed > 0) $('doneRetryText').textContent = `Retry ${failed.toLocaleString()} failed`;
}

// === CSV Export Helpers ===

function csvEscape(value) {
  const text = value == null ? '' : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function downloadItemsCsv(items, type, prefix = 'backup') {
  if (!items.length) return;
  const headers = ['Type', 'Date', 'Content', 'Author/Username', 'Display Name', 'Likes', 'URL'];
  const lines = [headers.join(',')];
  for (const item of items) {
    const fullUrl = item.url?.startsWith('/') ? `https://x.com${item.url}` : item.url || '';
    lines.push([
      item.type || type,
      item.date || '',
      item.type === 'account' ? (item.bio || '') : (item.text || ''),
      item.username || item.author || '',
      item.displayName || '',
      item.likes ?? 0,
      fullUrl
    ].map(csvEscape).join(','));
  }
  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `x_bulk_clean_${prefix}_${type}_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

async function downloadLastJobCsv() {
  if (!lastDoneResult?.jobId) return;
  const stored = await chrome.storage.local.get([`job_${lastDoneResult.jobId}`]);
  const job = stored[`job_${lastDoneResult.jobId}`];
  if (!job?.backup) return;
  const rows = [['Type', 'Date', 'Content', 'Author/Username', 'Display Name', 'URL', 'Action', 'Action Date']];
  const addPost = (t, item) => rows.push([t, item.date || '', item.text || '', item.author || '', '', item.url || '', item.action || '', item.actionAt || '']);
  const addUser = (t, item) => rows.push([t, item.actionAt || '', '', item.username || '', item.displayName || '', item.profileUrl || '', item.action || '', item.actionAt || '']);
  (job.backup.tweets || []).forEach(i => addPost('Deleted tweet', i));
  (job.backup.replies || []).forEach(i => addPost('Deleted reply', i));
  (job.backup.media || []).forEach(i => addPost(i.mediaKind === 'video' ? 'Deleted video' : 'Deleted photo', i));
  (job.backup.unliked || []).forEach(i => addPost('Unliked post', i));
  (job.backup.unreposted || []).forEach(i => addPost('Removed repost', i));
  (job.backup.unfollows || []).forEach(i => addUser('Unfollowed', i));
  const csv = rows.map(r => r.map(csvEscape).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `x_bulk_clean_report_${job.action || 'job'}_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// === Bottom Sheet Confirmation ===

function syncSheetConfirmButton() {
  if (!requireTypedDelete) {
    $('sheetConfirm').disabled = false;
    return;
  }
  $('sheetConfirm').disabled = ($('deleteConfirmInput').value || '').trim() !== 'DELETE';
}

function openConfirmSheet(mode) {
  sheetMode = mode;
  const type = mode === 'retry' && lastDoneResult ? lastDoneResult.type : currentType;
  const perm = isPermanentType(type);
  $('deleteConfirmInput').value = '';
  $('sheetBackupCheck').checked = defaultAutoCsv;
  const speedRadio = document.querySelector(`input[name="cleanupSpeed"][value="${defaultCleanupSpeed}"]`);
  if (speedRadio) speedRadio.checked = true;
  $('fastSpeedWarn').hidden = defaultCleanupSpeed !== 'fast';

  const confirmBtn = $('sheetConfirm');
  confirmBtn.dataset.tone = perm ? 'danger' : 'reversible';
  $('sheetAccount').textContent = `@${activeAccount?.username || 'unknown'}`;

  if (mode === 'bulkAll') {
    requireTypedDelete = true;
    $('sheetTitle').textContent = `${actionVerb(type)} all ${typeNoun(type, 2)}?`;
    $('sheetDesc').textContent = perm
      ? 'Permanent action: scrolls your profile and deletes items without preview.'
      : 'Reversible action: scrolls your list and removes items without preview.';
    $('sheetCount').textContent = `All ${typeNoun(type, 2)}`;
    $('sheetBackupOption').hidden = true;
    $('typedConfirmBox').hidden = false;
    confirmBtn.textContent = `${actionVerb(type)} all`;
    syncSheetConfirmButton();
    $('confirmSheet').showModal();
    return;
  }

  const targetItems = mode === 'retry'
    ? (lastDoneResult?.failedItems || [])
    : currentCache(type).items.filter(i => i.selected && isSelectable(i));
  if (!targetItems.length) return;

  const selectableCount = currentCache(type).items.filter(isSelectable).length;
  requireTypedDelete = perm && (targetItems.length >= 25 || (targetItems.length === selectableCount && selectableCount >= 10));

  $('sheetTitle').textContent = `${destructiveLabel(targetItems.length, type)}?`;
  $('sheetDesc').textContent = perm
    ? 'Permanent deletion — deleted posts cannot be restored from X.'
    : 'Reversible action — you can re-follow, re-like, or repost these later.';
  $('sheetCount').textContent = `${targetItems.length.toLocaleString()} ${typeNoun(type, targetItems.length)}`;
  $('sheetBackupOption').hidden = false;
  $('typedConfirmBox').hidden = !requireTypedDelete;
  confirmBtn.textContent = destructiveLabel(targetItems.length, type);
  syncSheetConfirmButton();
  $('confirmSheet').showModal();
}

async function startConfirmedCleanup() {
  if (requireTypedDelete && ($('deleteConfirmInput').value || '').trim() !== 'DELETE') return;
  const speed = selectedSpeed();
  const downloadFirst = $('sheetBackupCheck').checked;
  const type = sheetMode === 'retry' && lastDoneResult ? lastDoneResult.type : currentType;
  const targetItems = sheetMode === 'bulkAll'
    ? []
    : sheetMode === 'retry'
      ? (lastDoneResult?.failedItems || [])
      : currentCache(type).items.filter(i => i.selected && isSelectable(i));

  $('confirmSheet').close('confirm');
  showError('');

  if (sheetMode !== 'bulkAll' && !targetItems.length) return;
  if (sheetMode !== 'bulkAll' && downloadFirst) {
    downloadItemsCsv(targetItems, type, 'backup');
  }

  activeTab = await findActiveXTab();
  const currentAccount = await detectAccount(activeTab);
  if (!currentAccount?.username || currentAccount.username.toLowerCase() !== activeAccount?.username?.toLowerCase()) {
    showError(currentAccount?._status === 'error'
      ? 'Could not access the X tab. Reload x.com and try again.'
      : 'The active X account changed. Switch back to the original account first.');
    return;
  }

  if (activeScanType) {
    await executeInTab(controlPreviewScanner, ['stop']);
    activeScanType = null;
  }
  await chrome.storage.local.remove(['activePreviewSession']);
  const activeScope = type === 'media'
    ? (sheetMode === 'bulkAll' ? selectedMediaScope() : (currentCache('media')?.mediaScope || selectedMediaScope()))
    : (currentCache(type).replyScope || selectedReplyScope());
  await ensurePreviewPage(type, type === 'media' ? activeScope : null);
  activeTab = await findActiveXTab();

  const action =
    type === 'replies' ? 'deleteReplies'
      : type === 'media' ? 'deleteMedia'
        : type === 'likes' ? 'unlike'
          : type === 'reposts' ? 'unrepost'
            : type === 'unfollow' ? 'bulkUnfollow'
              : 'delete';
  await chrome.storage.local.set({ activeAction: action, activeTabId: activeTab.id, startTime: Date.now() });

  const res = await executeInTab(runCleanupWorker, [
    sheetMode === 'bulkAll' ? 'all' : 'selected',
    type,
    targetItems,
    activeAccount,
    $('previewPerformance').checked,
    activeScope,
    speed,
    Array.from(whitelist)
  ]);

  if (!res?.ok) {
    await chrome.storage.local.remove(['activeAction', 'activeTabId', 'startTime']);
    showError(res?.error || 'Could not start cleanup.');
    return;
  }

  cleanupRunning = true;
  cleanupPaused = false;
  cleanupType = type;
  pollMisses = 0;
  setView('deleting');
  startPolling();
}

// === CWS Review Banner ===

async function renderReviewBanner() {
  const banner = $('reviewBanner');
  if (!banner) return;
  const stored = await chrome.storage.local.get(['jobHistory', 'reviewPromptStatus']);
  if (stored.reviewPromptStatus) { banner.hidden = true; return; }
  const history = Array.isArray(stored.jobHistory) ? stored.jobHistory : [];
  const latest = history[0];
  if (!latest || latest.status === 'rate_limited' || latest.status === 'interrupted') { banner.hidden = true; return; }
  const totalCleaned = history
    .filter(j => j && (j.status === 'completed' || j.status === 'stopped'))
    .reduce((sum, j) => sum + (Number(j.total) || 0), 0);
  if (totalCleaned < 5) { banner.hidden = true; return; }
  $('reviewBannerCopy').textContent =
    `Cleaned ${totalCleaned.toLocaleString()} items locally for free. X Bulk Clean is open source — a quick review helps others find it.`;
  banner.hidden = false;
}

// === Theme Switch (System / Light / Dark via <meta name="color-scheme">) ===

const darkMedia = window.matchMedia('(prefers-color-scheme: dark)');

function currentStoredTheme() {
  try {
    const v = localStorage.getItem('color-scheme');
    return (v === 'light' || v === 'dark') ? v : 'system';
  } catch (_) {
    return 'system';
  }
}

function applyThemeMode(mode) {
  const meta = document.querySelector('meta[name="color-scheme"]');
  const normalized = (mode === 'light' || mode === 'dark') ? mode : 'system';
  if (meta) meta.content = normalized === 'system' ? 'light dark' : normalized;
  try {
    if (normalized === 'system') localStorage.removeItem('color-scheme');
    else localStorage.setItem('color-scheme', normalized);
  } catch (_) {}
  syncThemeUI(normalized);
}

function syncThemeUI(mode = currentStoredTheme()) {
  const radio = document.querySelector(`input[name="themeMode"][value="${mode}"]`);
  if (radio) radio.checked = true;
  const sysLabel = darkMedia.matches ? 'dark' : 'light';
  const hint = $('themeSystemHint');
  if (hint) hint.textContent = mode === 'system' ? `Following OS (${sysLabel})` : `OS is ${sysLabel}`;
}

// === Bootstrap ===

async function syncAccountStatus(fromRetry = false) {
  if (cleanupRunning || activeScanType) return;
  if (!fromRetry) clearAccountRetry();
  activeTab = await findActiveXTab();
  const account = activeTab ? await detectAccount(activeTab) : null;
  renderAccount(account, !!activeTab);
}

async function initialize() {
  await loadWhitelist();
  await restoreSession();

  activeTab = await findActiveXTab();
  const detected = activeTab ? await detectAccount(activeTab) : null;
  renderAccount(detected, !!activeTab);

  const settings = await chrome.storage.local.get(['performanceMode', 'defaultAutoCsv', 'defaultSpeed', 'activeAction', 'lastSeenSettingsVersion', 'lastSeenChangelogVersion']);
  $('previewPerformance').checked = settings.performanceMode ?? true;
  defaultAutoCsv = settings.defaultAutoCsv ?? true;
  $('defaultAutoCsv').checked = defaultAutoCsv;
  defaultCleanupSpeed = settings.defaultSpeed === 'fast' ? 'fast' : 'safe';
  const defSpeedRadio = document.querySelector(`input[name="defaultSpeed"][value="${defaultCleanupSpeed}"]`);
  if (defSpeedRadio) defSpeedRadio.checked = true;

  const currentVer = chrome.runtime.getManifest?.().version || '1.6.0';
  const hasNewSettings = settings.lastSeenSettingsVersion !== currentVer;
  const hasNewChangelog = settings.lastSeenChangelogVersion !== currentVer;
  $('settingsNewDot').hidden = !hasNewSettings;
  $('changelogNewPill').hidden = !hasNewChangelog;
  await renderReviewBanner();

  if (settings.activeAction && activeTab) {
    const cleanup = await executeInTab(readCleanupState);
    if (cleanup?.running || (!cleanup?.historyPersisted && cleanup?.issue)) {
      cleanupRunning = true;
      cleanupType = cleanup.type || currentType;
      selectCategoryTab(cleanupType);
      setView('deleting');
      startPolling();
      return;
    }
    await chrome.storage.local.remove(['activeAction', 'activeTabId', 'startTime']);
  }

  if (activeTab) {
    const state = await executeInTab(readPreviewState, [0]);
    if (state) {
      const c = tabCache[state.type] || tabCache.tweets;
      c.items = state.newItems || [];
      c.estimatedTotal = state.estimatedTotal ?? c.estimatedTotal;
      c.scannedAt = Date.now();
      if (state.type === 'media') c.mediaScope = state.replyScope === 'video' ? 'video' : 'photo';
      else c.replyScope = state.replyScope || 'fast';
      if (state.running && !state.paused) {
        activeScanType = state.type;
        c.scanState = 'idle';
        selectCategoryTab(state.type);
        setView('scanning');
        startPolling();
        return;
      }
      c.scanState = state.done ? 'done' : state.paused ? 'paused' : 'stopped';
      selectCategoryTab(state.type);
      return;
    }
  }

  selectCategoryTab(currentType);
}

document.addEventListener('DOMContentLoaded', () => {
  // Theme selector
  syncThemeUI();
  document.querySelectorAll('input[name="themeMode"]').forEach(r => {
    r.addEventListener('change', () => applyThemeMode(r.value));
  });
  darkMedia.addEventListener('change', () => syncThemeUI());
  window.addEventListener('storage', (e) => {
    if (e.key === 'color-scheme' || e.key === null) syncThemeUI();
  });

  // Header & Settings
  $('openHistory').addEventListener('click', () => chrome.runtime.openOptionsPage());
  $('openSettingsBtn').addEventListener('click', () => (settingsOpen ? closeSettings() : openSettings()));
  $('settingsBackBtn').addEventListener('click', closeSettings);
  $('openXButton').addEventListener('click', openX);
  $('recheckAccountBtn').addEventListener('click', async () => {
    const btn = $('recheckAccountBtn');
    btn.disabled = true;
    await syncAccountStatus(false);
    btn.disabled = false;
  });
  $('previewPerformance').addEventListener('change', () => {
    chrome.storage.local.set({ performanceMode: $('previewPerformance').checked });
  });
  $('defaultAutoCsv').addEventListener('change', () => {
    defaultAutoCsv = $('defaultAutoCsv').checked;
    chrome.storage.local.set({ defaultAutoCsv });
  });
  document.querySelectorAll('input[name="defaultSpeed"]').forEach(r => {
    r.addEventListener('change', () => {
      defaultCleanupSpeed = r.value === 'fast' ? 'fast' : 'safe';
      chrome.storage.local.set({ defaultSpeed: defaultCleanupSpeed });
    });
  });
  $('settingsRateLink').addEventListener('click', () => {
    chrome.storage.local.set({ reviewPromptStatus: 'clicked' });
    $('reviewBanner').hidden = true;
  });
  $('settingsChangelogLink').addEventListener('click', () => {
    const ver = chrome.runtime.getManifest?.().version || '1.6.0';
    chrome.storage.local.set({ lastSeenChangelogVersion: ver, lastSeenSettingsVersion: ver });
    $('changelogNewPill').hidden = true;
    $('settingsNewDot').hidden = true;
  });
  $('reviewBannerLink').addEventListener('click', () => {
    chrome.storage.local.set({ reviewPromptStatus: 'clicked' });
    $('reviewBanner').hidden = true;
  });
  $('reviewBannerDismiss').addEventListener('click', () => {
    chrome.storage.local.set({ reviewPromptStatus: 'dismissed' });
    $('reviewBanner').hidden = true;
  });

  // Whitelist add
  const addWhitelistHandle = () => {
    const raw = ($('whitelistInput').value || '').trim().replace(/^@/, '').toLowerCase();
    if (!/^[a-z0-9_]{1,15}$/.test(raw)) return;
    whitelist.add(raw);
    $('whitelistInput').value = '';
    saveWhitelist();
  };
  $('whitelistAddBtn').addEventListener('click', addWhitelistHandle);
  $('whitelistInput').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addWhitelistHandle(); } });

  // Category tabs + keyboard navigation
  const tabs = Array.from(document.querySelectorAll('#categoryTabs [role="tab"]'));
  tabs.forEach((tab, idx) => {
    tab.addEventListener('click', () => selectCategoryTab(tab.dataset.type));
    tab.addEventListener('keydown', (e) => {
      let next = null;
      if (e.key === 'ArrowRight') next = (idx + 1) % tabs.length;
      else if (e.key === 'ArrowLeft') next = (idx - 1 + tabs.length) % tabs.length;
      else if (e.key === 'Home') next = 0;
      else if (e.key === 'End') next = tabs.length - 1;
      if (next !== null) { e.preventDefault(); selectCategoryTab(tabs[next].dataset.type, true); }
    });
  });

  $('returnToActiveTab').addEventListener('click', () => {
    const target = cleanupRunning ? cleanupType : activeScanType;
    if (target) selectCategoryTab(target);
  });

  // Idle controls
  document.querySelectorAll('input[name="replyScope"]').forEach(r => r.addEventListener('change', syncIdleViewForType));
  document.querySelectorAll('input[name="mediaScope"]').forEach(r => r.addEventListener('change', syncIdleViewForType));
  document.querySelectorAll('#prescanDateChips .chip').forEach(chip => {
    chip.addEventListener('click', () => {
      preDatePreset = chip.dataset.prePreset;
      document.querySelectorAll('#prescanDateChips .chip').forEach(c => c.setAttribute('aria-pressed', c === chip ? 'true' : 'false'));
    });
  });
  $('openCachedScan').addEventListener('click', () => {
    const c = currentCache();
    if (!c.items.length) return;
    if (c.scanState === 'idle') c.scanState = 'done';
    renderCachedStatusBar(c);
    setView(c.scanState === 'done' ? 'review' : c.scanState);
  });
  $('startScan').addEventListener('click', startScan);
  $('startBulkAll').addEventListener('click', () => openConfirmSheet('bulkAll'));

  // Clear local data (job history + whitelist + cached scans)
  $('openClearDataBtn').addEventListener('click', () => $('clearDataDialog').showModal());
  $('clearDataCancel').addEventListener('click', () => $('clearDataDialog').close('cancel'));
  $('clearDataDialog').addEventListener('close', () => { $('clearDataDialog').returnValue = ''; });
  $('clearDataConfirm').addEventListener('click', async () => {
    $('clearDataDialog').close('confirm');
    const stored = await chrome.storage.local.get(['jobHistory']);
    const hist = Array.isArray(stored.jobHistory) ? stored.jobHistory : [];
    const jobKeys = hist.map(j => `job_${j.id}`);
    if (jobKeys.length) await chrome.storage.local.remove(jobKeys);
    await chrome.storage.local.set({ jobHistory: [], unfollowWhitelist: [] });
    whitelist.clear();
    renderWhitelistTags();
    for (const t of TYPES) {
      tabCache[t].items = [];
      tabCache[t].scannedAt = null;
      tabCache[t].estimatedTotal = null;
      tabCache[t].scanState = 'idle';
    }
    lastDoneResult = null;
    try { await chrome.storage.session.remove([SESSION_KEY]); } catch (_) {}
    updateTabBadges();
    await renderReviewBanner();
  });

  // Status bar actions
  $('statusActionBtn').addEventListener('click', handleStatusAction);
  $('statusSubLink').addEventListener('click', handleStatusSubLink);

  // Tri-state Select All & Overflow menu
  $('selectAllCheckbox').addEventListener('change', () => {
    const checked = $('selectAllCheckbox').checked;
    cachedFiltered.forEach(item => { if (isSelectable(item)) item.selected = checked; });
    if (checked && $('statusBar').dataset.state === 'done') collapseDoneBanner();
    renderVirtualWindow();
    updateSelectionUI();
    scheduleSessionSave();
  });
  $('menuInvert').addEventListener('click', () => {
    cachedFiltered.forEach(item => { if (isSelectable(item)) item.selected = !item.selected; });
    $('selectionMenu').hidePopover();
    renderVirtualWindow();
    updateSelectionUI();
    scheduleSessionSave();
  });
  $('menuClear').addEventListener('click', () => {
    currentCache().items.forEach(item => { item.selected = false; });
    $('selectionMenu').hidePopover();
    renderVirtualWindow();
    updateSelectionUI();
    scheduleSessionSave();
  });
  $('menuOpenSettings').addEventListener('click', () => {
    $('selectionMenu').hidePopover();
    openSettings('whitelistSection');
  });

  // Filters
  $('filterToggle').addEventListener('click', () => {
    const drawer = $('filterDrawer');
    const open = drawer.hidden;
    drawer.hidden = !open;
    $('filterToggle').setAttribute('aria-expanded', open ? 'true' : 'false');
  });
  document.querySelectorAll('#postChips .chip').forEach(chip => {
    chip.addEventListener('click', () => {
      datePreset = chip.dataset.preset;
      $('dateFrom').value = '';
      $('dateTo').value = '';
      document.querySelectorAll('#postChips .chip').forEach(c => c.setAttribute('aria-pressed', c === chip ? 'true' : 'false'));
      $('scrollBody').scrollTop = 0;
      refreshList();
    });
  });
  $('chipNotFollowingBack').addEventListener('click', () => {
    filterNotFollowingBack = !filterNotFollowingBack;
    $('chipNotFollowingBack').setAttribute('aria-pressed', String(filterNotFollowingBack));
    $('scrollBody').scrollTop = 0;
    refreshList();
  });
  $('chipNoAvatar').addEventListener('click', () => {
    filterNoAvatar = !filterNoAvatar;
    $('chipNoAvatar').setAttribute('aria-pressed', String(filterNoAvatar));
    $('scrollBody').scrollTop = 0;
    refreshList();
  });
  ['dateFrom', 'dateTo'].forEach(id => {
    $(id).addEventListener('input', () => {
      if ($('dateFrom').value || $('dateTo').value) {
        datePreset = 'custom';
        document.querySelectorAll('#postChips .chip').forEach(c => c.setAttribute('aria-pressed', 'false'));
      }
      refreshList();
    });
  });
  ['resultSearch', 'minLikes'].forEach(id => $(id).addEventListener('input', refreshList));
  ['filterMediaOnly', 'filterHasLinks', 'filterHideProtected'].forEach(id => $(id).addEventListener('change', refreshList));

  const doClearFilters = () => { resetFilters(); refreshList(); };
  $('clearFilters').addEventListener('click', doClearFilters);
  $('emptyClearFilters').addEventListener('click', doClearFilters);

  // Progressive infinite-scroll rendering paired with CSS content-visibility: auto
  $('scrollBody').addEventListener('scroll', () => {
    if ($('listView').hidden) return;
    const sb = $('scrollBody');
    if (renderedCount < cachedFiltered.length && sb.scrollTop + sb.clientHeight >= sb.scrollHeight - 400) {
      renderedCount = Math.min(cachedFiltered.length, renderedCount + RENDER_BATCH);
      renderVirtualWindow(true);
    }
  }, { passive: true });

  // Global keyboard shortcuts: Esc closes Settings, Ctrl/Cmd+A selects all filtered items
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && settingsOpen && !$('confirmSheet').open && !$('clearDataDialog').open) {
      closeSettings();
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'a') {
      const tag = document.activeElement?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if ($('listView').hidden) return;
      e.preventDefault();
      const selectable = cachedFiltered.filter(isSelectable);
      const allChecked = selectable.length > 0 && selectable.every(i => i.selected);
      selectable.forEach(i => { i.selected = !allChecked; });
      renderVirtualWindow();
      updateSelectionUI();
      scheduleSessionSave();
    }
  });

  // Bottom bar & Bottom sheet confirmation
  $('actionCta').addEventListener('click', () => openConfirmSheet('selected'));
  document.querySelectorAll('input[name="cleanupSpeed"]').forEach(r => {
    r.addEventListener('change', () => { $('fastSpeedWarn').hidden = selectedSpeed() !== 'fast'; });
  });
  $('deleteConfirmInput').addEventListener('input', syncSheetConfirmButton);
  $('sheetCancel').addEventListener('click', () => $('confirmSheet').close('cancel'));
  $('sheetConfirm').addEventListener('click', startConfirmedCleanup);
  $('confirmSheet').addEventListener('close', () => {
    $('confirmSheet').returnValue = '';
    $('deleteConfirmInput').value = '';
  });

  // Done screen buttons
  $('doneDownloadCsv').addEventListener('click', downloadLastJobCsv);
  $('doneRetryFailed').addEventListener('click', () => openConfirmSheet('retry'));
  $('doneBackStart').addEventListener('click', () => {
    currentCache().scanState = 'idle';
    setView('idle');
    scheduleSessionSave();
  });

  // Live storage & tab synchronization
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.performanceMode) $('previewPerformance').checked = changes.performanceMode.newValue ?? true;
    if (changes.jobHistory || changes.reviewPromptStatus) renderReviewBanner();
  });
  chrome.tabs.onActivated.addListener(() => syncAccountStatus(false));
  chrome.tabs.onUpdated.addListener((tabId, info) => {
    if (info.status === 'complete' || info.url) syncAccountStatus(false);
  });
  window.addEventListener('focus', () => syncAccountStatus(false));
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) syncAccountStatus(false);
  });

  initialize();
});
