# Changelog 📋

All notable changes are documented here. Releases before `1.4.0` are not reconstructed in detail.

## [1.6.0] - 2026-11-27 ✨

### Added 🚀

- 🖼️ **Media tab (Photos & Videos)**: Scan your X **Photos** (`?filter=photo`) and **Videos** (`?filter=video`) with visual thumbnail previews, delete selected photos in-place from the lightbox or delete video posts directly, with full CSV backup & Job History support.
- 🌐 **Full multi-language X support**: Tweet/reply/media deletion, reply detection, profile stats, likes, reposts, and following scans now work across all X display languages (no longer requires English).

### Fixed 🐛

- 🔐 **Reliable account detection**: Fixed false "Sign in to X" prompts after logging in or reloading X by adding `__INITIAL_STATE__` & compact-layout detection, automatic hydration retries, smart tab selection, and a **Check again** button.
- 🔁 **Updated X routes & UI polish**: Navigated Reposts to X's dedicated `/reposts` tab, recognized `/i/history/likes`, excluded "Who to follow" sidebar suggestions from Following scans, fixed horizontal bio overflow, fixed `Retry failed` button visibility when 0 items fail, and refreshed the Chrome Web Store review card.

## [1.5.2] - 2026-11-24 ✨

- 🌐 Added a dismissable notice in the Side Panel when X's display language isn't set to English, with a one-click link to X language settings.
- 📝 Noted the English display language requirement in the README.

## [1.5.1] - 2026-11-24 ✨

- 🎨 Minor Side Panel UI polish (compact Settings header & mascot sizing).
- 🐛 Fixed mascot background transparency in Dark Mode.

## [1.5.0] - 2026-11-24 ✨

### Added 🚀

- 🧩 **Direct Side Panel experience**: Clicking the toolbar icon now opens the unified Side Panel directly (even before signing in to X), removing the redundant popup step.
- ❤️ **Likes tab in Preview & Select**: Scan, filter, and selectively unlike posts alongside Tweets, Replies, Reposts, and Following.
- 🛡️ **Never-unfollow whitelist**: Protect accounts directly from any Following row or manage protected `@handles` in Settings; protected accounts are automatically skipped during unfollow.
- 🌗 **Theme switcher & Dark Mode**: Full System / Light / Dark theme support across the Side Panel and Job History, with FOUC-free startup and WCAG AA contrast.
- 🔎 **Upgraded filters & sorting**: Consistent quick date chips (**All time / Last 30d / Last 90d / Older than 1 year**), Following-specific filters (**Doesn't follow back**, **No profile photo**), collapsible **Filters** drawer (**From/To dates**, **Min. likes**, **Media only**, **Has links**), and a custom sort menu (**Newest / Oldest / Most liked**).
- 📋 **Bottom-sheet confirmation & speed controls**: Pre-selected CSV backup download before deletion, **Safe / Fast** speed selector with rate-limit warning, and typed `DELETE` confirmation for bulk/permanent actions.
- 🔁 **Live streaming, Pause/Resume, ETA & Retry**: Items stream live during scans, cleanup jobs support Pause/Resume and ETA, and the Done summary offers one-click CSV export and **Retry failed**.
- ⚙️ **Full-panel Settings & session persistence**: Scalable Settings view with Cleanup defaults, **Clear local data**, Changelog badge, and `chrome.storage.session` state restoration.
- ⭐ **Non-intrusive Chrome Web Store review prompts**: Shown once after successful cleanups with permanent dismiss/click persistence.

### Changed 🎨

- 👤 **Morphing Profile Card**: Rich 52px profile card with banner, verified badge, and local `posts / following / followers` stats sits above the tabs in Idle and smoothly collapses into a compact strip during scanning and review.
- 🎯 **Cleaner scan progress & layout**: Accurate total rules (determinate bar on Following and approx. upper bound on Posts + replies; shimmer + elapsed time + oldest date reached on Tweets/Replies/Reposts/Likes), single-button status bar with auto-collapse on completion, tri-state Select All checkbox, Shift+Click range selection, Space & Ctrl/Cmd+A shortcuts, and compact content-hugging result cards.
- 🧹 **Job History polish**: Replaced the empty-state logo with the transparent `sweep.webp` mascot illustration and switched header links to clean icon buttons (Star + GitHub).
- 🏷️ **Chrome Web Store metadata**: Updated manifest title (`X Bulk Clean: Delete Tweets, Likes & Unfollow for Twitter`), added `short_name`, and tightened the store summary.

### Fixed 🐛

- 📏 Fixed inconsistent native date input sizing, pale-pink disabled action buttons, red error-like Tweet summary cards, and duplicate signed-out prompts.
- ⏱️ Fixed scan completion vs. user-stopped status bar states so stopped scans no longer appear finished.

## [1.4.0] - 2026-07-11 🚀

### Added ✨

- 🧭 Preview & Select in Chrome's Side Panel for tweets, replies, reposts, and Following accounts.
- 💬 Reply scan choices: **Replies only** or **Posts + replies** for one-pass manual review of standalone posts and possible orphan replies.
- 👥 Selected-only bulk unfollow, including profile photos, bios, search, confirmation, progress, local backup, and CSV export data.
- 🛡️ Active-account display, destructive-action confirmations, job locking, and an in-page progress overlay with stop control.
- 📦 Persistent job history with per-job details, individual CSV downloads, and a single **Download all CSV** export.
- ⚡ Performance mode for reducing media rendering while scans and cleanup jobs run.
- 🔗 Quick access to the GitHub repository from the popup header.

### Changed 🎨

- 🧩 Reworked popup, Side Panel, and History UI around safer review-first cleanup flows.
- ✨ Improved interaction feedback, accessibility focus states, reduced-motion support, and restrained state-transition animations.
- 🚪 The popup closes after a cleanup worker starts successfully.

### Fixed 🐛

- 🔓 Quick Clean actions now end an existing Preview session only after confirmation instead of becoming blocked by a stale preview lock.
- 🧠 Reply cleanup no longer needs a second main-profile scan; the Posts + replies mode keeps standalone items available for manual selection.
- ⏸️ Rate Limit Guard stops follow and unfollow jobs immediately when X reports a rate limit, avoids counting failed actions, and records the job as rate limited.
