<p align="center">
  <img src="src/icons/logo.png" alt="X Bulk Clean logo" width="160" height="160">
</p>

<h1 align="center">X Bulk Clean</h1>

<p align="center">
  <a href="https://chromewebstore.google.com/detail/bcpkijoolaciolfegopiaifmoedbolgg">
    <img src="https://img.shields.io/chrome-web-store/v/bcpkijoolaciolfegopiaifmoedbolgg" alt="Chrome Web Store version">
  </a>
  <a href="https://chromewebstore.google.com/detail/bcpkijoolaciolfegopiaifmoedbolgg">
    <img src="https://img.shields.io/chrome-web-store/users/bcpkijoolaciolfegopiaifmoedbolgg" alt="Chrome Web Store users">
  </a>
  <a href="https://github.com/agmmnn/x-bulk-clean/blob/master/LICENSE">
    <img src="https://img.shields.io/github/license/agmmnn/x-bulk-clean" alt="MIT License">
  </a>
</p>

<p align="center">
  <a href="https://github.com/agmmnn/x-bulk-clean">github.com/agmmnn/x-bulk-clean</a>
</p>

**X Bulk Clean** is a Chrome extension for quickly cleaning up your X account. Bulk delete tweets, replies, reposts, and likes, or mass unfollow accounts without managing items one by one. It runs directly in your browser for a simple, fast, and privacy-friendly cleanup experience.

## Features

- **Direct Side Panel workflow** with 5 unified tabs: **Tweets**, **Replies**, **Likes**, **Reposts**, and **Following**
- **Preview & Select before deleting**: read-only scans stream items live into the side panel so you can review and choose exactly what to remove
- **Flexible reply scanning**: scan clearly identified replies only, or **Posts + replies** in a single pass for manual review of possible orphan replies
- **Smart filters & sorting**: quick date chips (**All time**, **Last 30d**, **Last 90d**, **Older than 1 year**), custom **From/To** dates, keyword/`@author`/bio search, **Min. likes**, **Media only**, **Has links**, Following filters (**Doesn't follow back**, **No profile photo**), and sorting (**Newest**, **Oldest**, **Most liked**)
- **Fast selection**: tri-state Select All, Invert, `Shift+Click` range select, and keyboard shortcuts (`Space`, `Ctrl/Cmd+A`)
- **Never-unfollow whitelist**: protect accounts directly from any Following row or manage protected `@handles` in Settings so they are skipped during unfollow
- **Safety & CSV backups**: pre-selected CSV backup download before deletion, **Safe / Fast** speed modes with built-in Rate Limit Guard, typed confirmation for bulk actions, and overlap locking
- **Live control & recovery**: Pause, Resume, or Stop active jobs at any time, view live ETA, and **Retry failed** items with one click
- **Persistent Job History**: account-aware history with dates, counts, affected records, individual CSV downloads, and one-click **Download all CSV** export
- **Themes & Performance mode**: System / Light / Dark theme support plus an optional Performance mode that hides photos and pauses videos while running
- **100% local & open source**: no analytics, subscriptions, API keys, or external backend

## Install from Chrome Web Store

The easiest way to install X Bulk Clean:

1. Visit the [Chrome Web Store listing](https://chromewebstore.google.com/detail/bcpkijoolaciolfegopiaifmoedbolgg).
2. Click **Add to Chrome**.
3. Sign in to X, open the extension, and choose an action.

## Install from source

1. Download or clone this repository.
2. Open `chrome://extensions` in Google Chrome.
3. Enable **Developer mode** (toggle in the top-right corner).
4. Click **Load unpacked** (top-left corner).
5. Select the `src` folder inside the cloned repository.
6. Sign in to X, open the extension, and choose an action.

X Bulk Clean requires Chrome 116 or newer (for the Side Panel API).

## Development & Packaging

To bundle the extension into a clean ZIP archive ready for the Chrome Web Store:
1. Make the packaging script executable (if not already): `chmod +x package.sh`
2. Run `./package.sh` in the project root.
3. This creates a release-ready `x-bulk-clean-v<version>.zip` excluding git metadata, documentation, and editor files.

## Important safety notes

Bulk actions are destructive and may be difficult or impossible to reverse. Export a CSV backup first, test with a small account or a small set of items, and keep the X tab visible while an action is running. X can change its interface or impose rate limits at any time, which may interrupt an action.

Use the extension only on accounts you own or are authorized to manage. You are responsible for complying with X's terms and applicable rules.

## Privacy

X Bulk Clean operates on the active X page. It does not include analytics, licensing, payment processing, or an external service. See [PRIVACY.md](PRIVACY.md) for details.

## Contributing

Bug reports and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

Released under the [MIT License](LICENSE).

Interface icons are based on [Lucide](https://lucide.dev/) and covered by the notices in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

X Bulk Clean is not affiliated with, endorsed by, or sponsored by X Corp.
