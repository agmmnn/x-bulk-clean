# Contributing

Thanks for helping improve X Bulk Clean.

Before opening a pull request:

1. Keep the extension free of paywalls, license checks, analytics, and unnecessary external services.
2. Keep permissions to the minimum required by the feature.
3. Run `node --check src/background.js src/content.js src/theme.js src/sidepanel/sidepanel.js src/history/history.js`.
4. Load the `src/` folder as an unpacked extension and test the affected action on X.
5. Describe the behavior change, manual test performed, and any permission changes.

For bugs, include the Chrome version, relevant X page, expected behavior, actual behavior, and any error shown in the extension service-worker or page console. Do not include account credentials, cookies, or other private data.
