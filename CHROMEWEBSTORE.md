# Chrome Web Store Listing — X Bulk Clean

> Last Updated: 2026-11-24

## Store Listing

**Extension Name**
X Bulk Clean: Delete Tweets, Likes & Unfollow for Twitter

**Short Description**
Bulk delete tweets, replies, likes & reposts, mass unfollow on X (Twitter), and export CSV backups locally. Free & open source.

**Detailed Description**
Clean up your X (formerly Twitter) account safely, selectively, and completely free — right from Chrome's Side Panel.

X Bulk Clean is an open-source extension that runs 100% locally in your browser. There are no subscriptions, no tweet limits, no API keys, and no external servers. Your account data never leaves your device.

WHAT YOU CAN CLEAN
• Tweets — Scan your timeline and delete selected posts in bulk
• Replies — Clean up replies only, or scan posts + replies in a single pass
• Reposts — Undo retweets/reposts in bulk
• Media — Preview thumbnails of your Photos and Videos and delete selected media posts in bulk
• Likes — Review and unlike old posts
• Following — Mass unfollow accounts, with filters for accounts that don't follow back or have no profile photo

PREVIEW & SELECT BEFORE YOU DELETE
Unlike blind mass-deleters, X Bulk Clean lets you run a read-only scan first and inspect every item live in the side panel before anything is touched:
• Quick date presets (Last 30 days, Last 90 days, Older than 1 year) plus custom From/To date ranges
• Search by keyword, @handle, or bio
• Filter by minimum likes, media only, or posts with links
• Sort by Newest, Oldest, or Most liked
• Fast selection with Select All, Invert, Shift+Click range select, and keyboard shortcuts

BUILT-IN SAFETY & BACKUPS
• Never-Unfollow Whitelist — Protect important accounts with one click so they are always skipped during unfollow
• Automatic CSV Backups — Download a local CSV copy of your selected tweets, likes, reposts, or following list before deletion
• Safe & Fast Speed Modes — Built-in pacing and Rate Limit Guard help avoid temporary X limits
• Pause, Resume & Retry — Pause or stop any job at any time, track live ETA, and retry failed items with one click
• Persistent Job History — Review past cleanups per account and export CSV reports anytime

DESIGNED TO STAY OUT OF YOUR WAY
• Opens directly in Chrome's Side Panel alongside X
• Light, Dark, and System themes
• Optional Performance Mode hides photos and pauses videos during scans to keep Chrome fast

HOW TO USE
1. Sign in to x.com (or twitter.com) in Chrome.
2. Click the X Bulk Clean icon in your toolbar to open the Side Panel.
3. Pick a tab (Tweets, Replies, Likes, Reposts, or Following) and click Scan.
4. Filter and select the items you want to remove, keep CSV backup checked, and confirm.

PRIVACY & OPEN SOURCE
X Bulk Clean collects zero user data and makes zero requests to third-party servers. Everything runs locally in your browser.
Source code & issue tracker: https://github.com/agmmnn/x-bulk-clean

Note: Deleting tweets, likes, reposts, or unfollowing accounts on X is permanent and cannot be undone by the extension. Exporting a CSV backup before running large cleanups is strongly recommended.

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
`https://github.com/agmmnn/x-bulk-clean/blob/master/PRIVACY.md`

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
| 1.6.0 | 2026-11-27 | Added dedicated Media tab (Photos & Videos with visual thumbnails), full language-independent X support, reliable account detection with auto-retry and Check again button, `/reposts` & `/i/history/likes` support, and Following scan & UI fixes. | Released |
| 1.5.2 | 2026-11-24 | Added Side Panel notice when X display language is not set to English (with quick link to X language settings) and documented the requirement in README. | Released |
| 1.5.1 | 2026-11-24 | Minor Side Panel UI polish (compact Settings header & mascot sizing) and fixed Dark Mode mascot transparency. | Released |
| 1.5.0 | 2026-11-24 | Direct Side Panel launch, unified 5-tab flow (added Likes), rich morphing profile card, live scan streaming, never-unfollow whitelist, theme switch (System/Light/Dark), bottom-sheet confirmation with Safe/Fast speed & auto-CSV backup, full-panel Settings, and SEO-optimized store metadata. | Released |
| 1.4.0 | 2026-07-11 | Preview & Select in Chrome's Side Panel, reply scan modes, selected-only unfollow, persistent job history with CSV exports, Performance mode, and Rate Limit Guard. | Published |
| 1.3.0 | 2026-07-11 | Reorganized codebase to clean directory structure with a dedicated `src/` directory. Fixed loading bar animation behavior on scan stops and job completion. | Published |
