const ACTION_LABELS = {
  delete: 'Deleted tweets',
  deleteMedia: 'Deleted media',
  unlike: 'Cleared likes',
  unrepost: 'Removed reposts',
  deleteReplies: 'Deleted replies',
  followVerified: 'Followed verified accounts',
  followAll: 'Followed followers',
  bulkUnfollow: 'Bulk unfollowed'
};

let history = [];
let pendingDelete = null;

const $ = (id) => document.getElementById(id);
const svg = (id) => {
  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  icon.setAttribute('class', 'icon');
  icon.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#${id}`);
  icon.appendChild(use);
  return icon;
};

function formatDate(timestamp) {
  if (!timestamp) return 'Unknown date';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(timestamp));
}

function formatDuration(durationMs) {
  const seconds = Math.max(0, Math.round((durationMs || 0) / 1000));
  const minutes = Math.floor(seconds / 60);
  return minutes ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}

function csvEscape(value) {
  const text = value == null ? '' : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function flattenBackup(backup = {}) {
  const rows = [];
  const addPost = (type, item) => rows.push({
    type,
    date: item.date || item.actionAt || '',
    content: item.text || '',
    person: item.author || '',
    displayName: '',
    url: item.url || '',
    action: item.action || '',
    actionAt: item.actionAt || ''
  });
  const addUser = (type, item) => rows.push({
    type,
    date: item.actionAt || '',
    content: '',
    person: item.username || '',
    displayName: item.displayName || '',
    url: item.profileUrl || '',
    action: item.action || '',
    actionAt: item.actionAt || ''
  });
  (backup.tweets || []).forEach(item => addPost('Deleted tweet', item));
  (backup.replies || []).forEach(item => addPost('Deleted reply', item));
  (backup.media || []).forEach(item => addPost(item.mediaKind === 'video' ? 'Deleted video' : 'Deleted photo', item));
  (backup.unliked || []).forEach(item => addPost('Unliked post', item));
  (backup.unreposted || []).forEach(item => addPost('Removed repost', item));
  (backup.follows || []).forEach(item => addUser('Followed', item));
  (backup.unfollows || []).forEach(item => addUser('Unfollowed', item));
  return rows;
}

function downloadJob(job) {
  const rows = flattenBackup(job.backup);
  const headers = ['Type', 'Date', 'Content', 'Author/Username', 'Display Name', 'URL', 'Action', 'Action Date'];
  const lines = [headers.join(',')];
  rows.forEach(row => lines.push([
    row.type, row.date, row.content, row.person, row.displayName, row.url, row.action, row.actionAt
  ].map(csvEscape).join(',')));
  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `x_bulk_clean_${job.action || 'job'}_${new Date(job.completedAt || Date.now()).toISOString().slice(0, 10)}.csv`;
  anchor.click();
  URL.revokeObjectURL(url);
}

async function downloadAllHistory() {
  if (!history.length) return;
  const stored = await chrome.storage.local.get(history.map(job => `job_${job.id}`));
  const headers = ['Job ID', 'Job action', 'Job status', 'Account', 'Job started', 'Job completed', 'Record type', 'Record date', 'Content', 'Author/Username', 'Display name', 'URL', 'Record action', 'Record action date'];
  const lines = [headers.join(',')];
  for (const summary of history) {
    const job = stored[`job_${summary.id}`] || summary;
    const rows = flattenBackup(job.backup);
    const jobValues = [job.id || '', ACTION_LABELS[job.action] || job.action || '', job.status || '', job.account?.username ? `@${job.account.username}` : '', job.startedAt ? formatDate(job.startedAt) : '', job.completedAt ? formatDate(job.completedAt) : ''];
    if (!rows.length) lines.push([...jobValues, 'No affected records', '', '', '', '', '', '', ''].map(csvEscape).join(','));
    rows.forEach(row => lines.push([...jobValues, row.type, row.date, row.content, row.person, row.displayName, row.url, row.action, row.actionAt].map(csvEscape).join(',')));
  }
  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `x_bulk_clean_history_${new Date().toISOString().slice(0, 10)}.csv`;
  anchor.click();
  URL.revokeObjectURL(url);
}

function makeButton(label, iconId, className, handler) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className || '';
  button.append(svg(iconId), document.createTextNode(label));
  button.addEventListener('click', handler);
  return button;
}

function createRecordRow(record) {
  const row = document.createElement('div');
  row.className = 'record';
  const type = document.createElement('span');
  type.className = 'record-type';
  type.textContent = record.type;
  const date = document.createElement('span');
  date.className = 'record-date';
  date.textContent = record.date ? formatDate(record.date) : '—';
  const content = document.createElement('span');
  content.className = 'record-content';
  const contentText = record.content || record.displayName || record.person || '—';
  if (record.url) {
    const link = document.createElement('a');
    link.href = record.url.startsWith('/') ? `https://x.com${record.url}` : record.url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = contentText;
    content.appendChild(link);
  } else {
    content.textContent = contentText;
  }
  const person = document.createElement('span');
  person.className = 'record-person';
  person.textContent = record.person ? `@${record.person.replace(/^@/, '')}` : '—';
  row.append(type, date, content, person);
  return row;
}

async function renderJobDetail(summary, container) {
  if (container.dataset.loaded === 'true') return;
  container.dataset.loaded = 'true';
  const stored = await chrome.storage.local.get([`job_${summary.id}`]);
  const job = stored[`job_${summary.id}`];
  if (!job) {
    container.textContent = 'Detailed records for this job are no longer available.';
    return;
  }

  const facts = document.createElement('div');
  facts.className = 'job-facts';
  const factValues = [
    ['Account', job.account?.username ? `@${job.account.username}` : 'Unknown'],
    ['Started', formatDate(job.startedAt)],
    ['Duration', formatDuration(job.durationMs)],
    ['Result', job.statusText || job.status]
  ];
  if (Number.isFinite(job.selectedTotal)) factValues.push(['Selected', `${job.selectedTotal}`]);
  if (Number.isFinite(job.skipped)) factValues.push(['Not found', `${job.skipped}`]);
  factValues.forEach(([label, value]) => {
    const fact = document.createElement('span');
    fact.className = 'fact';
    const strong = document.createElement('strong');
    strong.textContent = `${label}: `;
    fact.append(strong, document.createTextNode(value));
    facts.appendChild(fact);
  });
  const actions = document.createElement('div');
  actions.className = 'job-actions';
  actions.append(
    makeButton('Download CSV', 'i-download', '', () => downloadJob(job)),
    makeButton('Remove', 'i-trash', 'delete', () => openDeleteDialog(summary.id))
  );
  facts.appendChild(actions);

  const records = flattenBackup(job.backup);
  const recordsBox = document.createElement('div');
  recordsBox.className = 'records';
  if (!records.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-records';
    empty.textContent = 'This job did not affect any records.';
    recordsBox.appendChild(empty);
  } else {
    const head = document.createElement('div');
    head.className = 'record-head';
    ['Type', 'Date and time', 'Content or account', 'Author'].forEach(text => {
      const span = document.createElement('span');
      span.textContent = text;
      head.appendChild(span);
    });
    recordsBox.appendChild(head);
    let shown = 0;
    const appendBatch = () => {
      records.slice(shown, shown + 200).forEach(record => recordsBox.insertBefore(createRecordRow(record), loadMore));
      shown = Math.min(records.length, shown + 200);
      loadMore.hidden = shown >= records.length;
      loadMore.textContent = `Load more (${records.length - shown} remaining)`;
    };
    const loadMore = document.createElement('button');
    loadMore.type = 'button';
    loadMore.className = 'fact';
    loadMore.style.margin = '9px';
    loadMore.addEventListener('click', appendBatch);
    recordsBox.appendChild(loadMore);
    appendBatch();
  }
  container.append(facts, recordsBox);
}

function createJobCard(job) {
  const details = document.createElement('details');
  details.className = 'job';
  details.dataset.action = job.action || 'other';
  const summary = document.createElement('summary');
  const icon = document.createElement('span');
  icon.className = 'job-icon';
  icon.appendChild(svg('i-history'));
  const main = document.createElement('span');
  main.className = 'job-main';
  const title = document.createElement('span');
  title.className = 'job-title';
  title.textContent = ACTION_LABELS[job.action] || 'Cleanup job';
  const meta = document.createElement('span');
  meta.className = 'job-meta';
  const account = job.account?.username ? `@${job.account.username} · ` : '';
  meta.textContent = `${account}${formatDate(job.completedAt || job.startedAt)}`;
  main.append(title, meta);
  const status = document.createElement('span');
  status.className = `status ${job.status || 'interrupted'}`;
  status.textContent = (job.status || 'interrupted').replaceAll('_', ' ');
  const count = document.createElement('span');
  count.className = 'job-count';
  const number = document.createElement('strong');
  number.textContent = `${job.total || 0}`;
  const records = document.createElement('span');
  records.textContent = 'records';
  count.append(number, records);
  const chevron = document.createElement('span');
  chevron.className = 'chevron';
  chevron.appendChild(svg('i-chevron'));
  summary.append(icon, main, status, count, chevron);
  const detail = document.createElement('div');
  detail.className = 'job-detail';
  details.append(summary, detail);
  details.addEventListener('toggle', () => {
    if (details.open) renderJobDetail(job, detail);
  });
  return details;
}

function renderHistory() {
  const query = $('historySearch').value.trim().toLowerCase();
  const filtered = history.filter(job => {
    const haystack = [ACTION_LABELS[job.action], job.action, job.status, job.statusText,
      job.account?.username, job.account?.displayName].filter(Boolean).join(' ').toLowerCase();
    return !query || haystack.includes(query);
  });
  $('historyList').replaceChildren(...filtered.map(createJobCard));
  $('emptyState').hidden = history.length !== 0;
  $('historyList').hidden = history.length === 0;
  $('clearAll').disabled = history.length === 0;
  $('downloadAll').disabled = history.length === 0;
  $('totalJobs').textContent = `${history.length}`;
  $('totalRecords').textContent = `${history.reduce((sum, job) => sum + (job.total || 0), 0)}`;
}

async function loadHistory() {
  const stored = await chrome.storage.local.get(['jobHistory']);
  history = Array.isArray(stored.jobHistory) ? stored.jobHistory : [];
  history.sort((a, b) => (b.completedAt || b.startedAt || 0) - (a.completedAt || a.startedAt || 0));
  renderHistory();
}

function openDeleteDialog(jobId) {
  pendingDelete = jobId;
  $('dialogTitle').textContent = jobId === 'all' ? 'Clear all job history?' : 'Remove this job history?';
  $('dialogText').textContent = jobId === 'all'
    ? 'Every saved job and detailed CSV backup will be permanently removed from this browser.'
    : 'This saved job and its detailed CSV backup will be permanently removed from this browser.';
  $('dialogConfirm').textContent = jobId === 'all' ? 'Clear everything' : 'Remove job';
  $('deleteDialog').showModal();
}

async function confirmDelete() {
  if (!pendingDelete) return;
  if (pendingDelete === 'all') {
    const keys = history.map(job => `job_${job.id}`);
    if (keys.length) await chrome.storage.local.remove(keys);
    await chrome.storage.local.set({ jobHistory: [] });
  } else {
    const id = pendingDelete;
    await chrome.storage.local.remove([`job_${id}`]);
    await chrome.storage.local.set({ jobHistory: history.filter(job => job.id !== id) });
  }
  pendingDelete = null;
  $('deleteDialog').close();
  await loadHistory();
}

document.addEventListener('DOMContentLoaded', async () => {
  $('historyRateLink')?.addEventListener('click', () => {
    chrome.storage.local.set({ reviewPromptStatus: 'clicked' });
  });
  $('historySearch').addEventListener('input', renderHistory);
  $('downloadAll').addEventListener('click', downloadAllHistory);
  $('clearAll').addEventListener('click', () => openDeleteDialog('all'));
  $('dialogCancel').addEventListener('click', () => $('deleteDialog').close());
  $('dialogConfirm').addEventListener('click', confirmDelete);
  $('deleteDialog').addEventListener('close', () => { pendingDelete = null; });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.jobHistory) loadHistory();
  });
  await loadHistory();
});
