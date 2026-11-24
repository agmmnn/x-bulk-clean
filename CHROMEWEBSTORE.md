# Chrome Web Store Listing — X Bulk Clean

> Last Updated: 2026-11-24

## Store Listing

**Extension Name**
X Bulk Clean: Delete Tweets, Likes & Unfollow for Twitter

**Short Description**
Bulk delete tweets, replies, likes & reposts, mass unfollow on X (Twitter), and export CSV backups locally. Free & open source.

**Detailed Description**
X Bulk Clean is a free, open-source Chrome extension that runs entirely inside your browser to help you clean up and manage your X (formerly Twitter) account. It requires no license keys, subscriptions, external backends, or payment.

Key features:
- Delete posts and replies in bulk with visual confirmation
- Preview posts, replies, or reposts in Chrome's side panel and choose exactly what to delete
- Filter scanned results by text, keywords, and dates, and use advanced selection controls (Select All, Invert, Select None)
- Undo reposts and remove likes
- Follow followers or verified followers in bulk
- Bulk unfollow accounts you follow
- Prevent overlapping cleanup jobs and monitor active jobs from an on-page status panel
- Persistent, account-aware job history showing dates, times, counts, and affected records
- Export activity backups as CSV before performing destructive actions
- Optional performance mode to hide tweet-media during scans to save resources

How to use:
1. Open X (Twitter) in your active Chrome tab and ensure you are logged in.
2. Click the extension icon to open the X Bulk Clean side panel.
3. Choose an action (e.g., Delete posts/replies, Remove likes, Follow/Unfollow).
4. For Delete/Repost scans, review the list of scanned items, filter them if needed, select/deselect items, and confirm.
5. Watch the automated cleanup run directly on the page, or stop/pause it at any time.

Important safety note:
Bulk cleanups are destructive and cannot be reversed by the extension. We highly recommend exporting a CSV backup of your scanned records first and starting with a small batch of items.

**Category**
Productivity

**Single Purpose**
Provides local bulk cleanup, filtering, and management tools for X (Twitter) accounts.

**Primary Language**
English

---

## Graphics & Assets

| Asset | Dimensions | Status | Filename |
|-------|-----------|--------|----------|
| Store Icon | 128×128 PNG | ✅ Ready | `src/icons/icon128.png` |
| Screenshot 1 | 1280×800 or 640×400 | ⬜ Not created | |
| Screenshot 2 | 1280×800 or 640×400 | ⬜ Not created | |
| Screenshot 3 | 1280×800 or 640×400 | ⬜ Not created | |

---

## Permissions Justification

| Permission | Type | Justification |
|------------|------|---------------|
| `scripting` | permissions | Used to inject the timeline scanner and cleanup automation scripts directly into the active X/Twitter page. |
| `activeTab` | permissions | Grants temporary access to the active tab to execute script injection when the extension UI is opened. |
| `tabs` | permissions | Used to check if the active tab's URL is X/Twitter and to wait for page loads during navigation. |
| `storage` | permissions | Used to store the local job history, user options, and transient preview session states. |
| `unlimitedStorage` | permissions | Prevents storage errors when the user accumulates a large number of local job runs and CSV backup logs. |
| `sidePanel` | permissions | Required to register and open the "Preview & Select" panel in Chrome's side panel UI. |
| `https://twitter.com/*` | host_permissions | Required to execute scripts and read timeline content on legacy Twitter URLs. |
| `https://x.com/*` | host_permissions | Required to execute scripts and read timeline content on modern X URLs. |

---

## Privacy & Data Use

### Data Collection

**Does the extension collect user data?** No

All data (scanned posts, history logs, CSV backups, settings) is processed and stored locally on your device within Chrome's local storage. No data is ever collected, transmitted off-device, or shared with third parties.

### Data Use Certification
- [x] Data is NOT sold to third parties
- [x] Data is NOT used for purposes unrelated to the extension's core functionality
- [x] Data is NOT used for creditworthiness or lending purposes

---

## Privacy Policy

**Privacy Policy URL**
`https://github.com/agmmnn/x-bulk-clean/blob/main/PRIVACY.md`

---

## Distribution

**Visibility**: Public
**Regions**: All regions
**Pricing**: Free

---

## Developer Info

**Publisher Name**
X Bulk Clean Contributors

**Contact Email**
(Add developer contact email here)

**Support URL / Email**
`https://github.com/agmmnn/x-bulk-clean/issues`

**Homepage URL**
`https://github.com/agmmnn/x-bulk-clean`

---

## Version History

| Version | Date | Changes | Status |
|---------|------|---------|--------|
| 1.5.0 | 2026-11-24 | Direct Side Panel launch, unified 5-tab flow (added Likes), rich morphing profile card, live scan streaming, never-unfollow whitelist, theme switch (System/Light/Dark), bottom-sheet confirmation with Safe/Fast speed & auto-CSV backup, full-panel Settings, and SEO-optimized store metadata. | Ready |
| 1.3.0 | 2026-07-11 | Reorganized codebase to clean directory structure with a dedicated `src/` directory. Fixed loading bar animation behavior on scan stops and job completion. | Published |
