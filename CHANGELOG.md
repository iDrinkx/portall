# Changelog

Toutes les modifications notables de ce projet sont documentées dans ce fichier.

## <small>1.21.2 (2026-02-25)</small>

* Merge pull request #13 from iDrinkx/develop ([d3cd089](https://github.com/iDrinkx/plex-portal/commit/d3cd089)), closes [#13](https://github.com/iDrinkx/plex-portal/issues/13)
* fix: add MonsterVerse achievement and update collection handling for mixed media ([3c9f4b8](https://github.com/iDrinkx/plex-portal/commit/3c9f4b8))
* fix: adjust XP values for achievements to improve scoring balance ([99d6407](https://github.com/iDrinkx/plex-portal/commit/99d6407))
* fix: update achievement progress totals and enhance fallback handling for revocable badges ([6f738ed](https://github.com/iDrinkx/plex-portal/commit/6f738ed))
* fix: update achievement XP values for balanced scoring in collections ([97cc749](https://github.com/iDrinkx/plex-portal/commit/97cc749))

## <small>1.21.1 (2026-02-25)</small>

* Merge pull request #12 from iDrinkx/develop ([0d9e733](https://github.com/iDrinkx/plex-portal/commit/0d9e733)), closes [#12](https://github.com/iDrinkx/plex-portal/issues/12)
* fix: enhance Wizarr user retrieval and fallback logic for active subscriptions ([6e494ef](https://github.com/iDrinkx/plex-portal/commit/6e494ef))
* fix: implement post-login data prefetching for improved user experience ([5f17d44](https://github.com/iDrinkx/plex-portal/commit/5f17d44))
* fix: optimize user stats retrieval and caching for improved performance ([65e994f](https://github.com/iDrinkx/plex-portal/commit/65e994f))
* fix: update achievement names and descriptions for consistency with collections ([00ef24d](https://github.com/iDrinkx/plex-portal/commit/00ef24d))
* fix: update cron job log message for clarity ([56999ec](https://github.com/iDrinkx/plex-portal/commit/56999ec))

## 1.21.0 (2026-02-24)

* Merge pull request #11 from iDrinkx/develop ([62c34d6](https://github.com/iDrinkx/plex-portal/commit/62c34d6)), closes [#11](https://github.com/iDrinkx/plex-portal/issues/11)
* fix: adjust header styles and remove unused refresh timer in statistics page ([b6db4e5](https://github.com/iDrinkx/plex-portal/commit/b6db4e5))
* fix: correct icons for "Platine" and "Diamant" ranks in XP system ([2437bdc](https://github.com/iDrinkx/plex-portal/commit/2437bdc))
* fix: correct icons for ranks in XP system ([ced5725](https://github.com/iDrinkx/plex-portal/commit/ced5725))
* fix: enhance logging for thumbnail debugging in classement API ([3e0ef12](https://github.com/iDrinkx/plex-portal/commit/3e0ef12))
* fix: enhance logging for thumbnail fetching in classement API and handle errors ([2d090e7](https://github.com/iDrinkx/plex-portal/commit/2d090e7))
* fix: ensure classement cache is populated at startup with await ([23d06db](https://github.com/iDrinkx/plex-portal/commit/23d06db))
* fix: ensure consistent XP/level calculation between profile and classement ([0493984](https://github.com/iDrinkx/plex-portal/commit/0493984))
* fix: extract pathname from full URL for thumbnail path in classement API ([cad4e84](https://github.com/iDrinkx/plex-portal/commit/cad4e84))
* fix: improve joinedAt retrieval to handle DB deletion scenario ([acf36fa](https://github.com/iDrinkx/plex-portal/commit/acf36fa))
* fix: reduce XP cache TTL to 5 minutes for synchronization with classement refresh ([0f50900](https://github.com/iDrinkx/plex-portal/commit/0f50900))
* fix: remove caching for classement API to ensure fresh data and update thumbnail handling ([2b7bade](https://github.com/iDrinkx/plex-portal/commit/2b7bade))
* fix: restructure header layout for improved alignment of statistics page ([56d2d50](https://github.com/iDrinkx/plex-portal/commit/56d2d50))
* fix: save recalculated stats to database for consistency between ranking and profile ([912792b](https://github.com/iDrinkx/plex-portal/commit/912792b))
* fix: send Plex URLs directly to frontend for thumbnail loading in classement API ([e710b26](https://github.com/iDrinkx/plex-portal/commit/e710b26))
* fix: update classement API to cache user stats while ensuring fresh Plex thumbnails ([e9ae6d0](https://github.com/iDrinkx/plex-portal/commit/e9ae6d0))
* fix: update refresh timer styles for profile and statistics pages for better alignment ([b8910b9](https://github.com/iDrinkx/plex-portal/commit/b8910b9))
* fix: update SSRF validation for plex thumbnail path to include user avatars ([7981c55](https://github.com/iDrinkx/plex-portal/commit/7981c55))
* fix: update user stats retrieval to use correct function and improve handling of inactive users ([3bb4d57](https://github.com/iDrinkx/plex-portal/commit/3bb4d57))
* feat: add badge count to XP snapshot and update related display logic ([105bcae](https://github.com/iDrinkx/plex-portal/commit/105bcae))
* feat: add global stats endpoint and update UI for switching between personal and global statistics ([58b0104](https://github.com/iDrinkx/plex-portal/commit/58b0104))
* feat: add immediate session scan and classement refresh on cron job startup ([a2e5e56](https://github.com/iDrinkx/plex-portal/commit/a2e5e56))
* feat: add refresh timer for profile and statistics pages to display last update time ([684d8ba](https://github.com/iDrinkx/plex-portal/commit/684d8ba))
* feat: add XP multipliers hint to profile view for enhanced user guidance ([cdfac61](https://github.com/iDrinkx/plex-portal/commit/cdfac61))
* feat: enhance user retrieval from Wizarr API with improved endpoint handling and pagination ([d01adb8](https://github.com/iDrinkx/plex-portal/commit/d01adb8))
* feat: enhance XP calculation and classement refresh by adding precomputed hours and deduplication lo ([e9f10f2](https://github.com/iDrinkx/plex-portal/commit/e9f10f2))
* feat: enhance XP calculation by incorporating precomputed stats for improved accuracy ([6bad6b2](https://github.com/iDrinkx/plex-portal/commit/6bad6b2))
* feat: implement automatic cache validation and repair mechanism for classement ([18195f2](https://github.com/iDrinkx/plex-portal/commit/18195f2))
* feat: implement automatic user import from Wizarr on startup and enhance classement refresh logic ([3845a78](https://github.com/iDrinkx/plex-portal/commit/3845a78))
* feat: implement classement data caching and refresh mechanism ([e3c39db](https://github.com/iDrinkx/plex-portal/commit/e3c39db))
* feat: implement XP snapshot loading from API for enhanced profile updates ([84033c6](https://github.com/iDrinkx/plex-portal/commit/84033c6))
* feat: update cron jobs to run every 60 minutes and refresh classement after session updates ([f166041](https://github.com/iDrinkx/plex-portal/commit/f166041))
* feat: update XP breakdown calculations to handle fresh snapshots and improve display formatting ([ff5990d](https://github.com/iDrinkx/plex-portal/commit/ff5990d))
* refactor: centralize XP calculation to guarantee profile/classement consistency ([96c4d1c](https://github.com/iDrinkx/plex-portal/commit/96c4d1c))

## <small>1.20.6 (2026-02-23)</small>

* Merge pull request #10 from iDrinkx/develop ([0259f7f](https://github.com/iDrinkx/plex-portal/commit/0259f7f)), closes [#10](https://github.com/iDrinkx/plex-portal/issues/10)
* fix: remove redundant debug logging and ensure consistent user retrieval in classement API ([867141e](https://github.com/iDrinkx/plex-portal/commit/867141e))

## <small>1.20.5 (2026-02-23)</small>

* Merge pull request #9 from iDrinkx/develop ([ee4c520](https://github.com/iDrinkx/plex-portal/commit/ee4c520)), closes [#9](https://github.com/iDrinkx/plex-portal/issues/9)
* fix: enhance debug logging for XP profile retrieval and handle errors ([cc1dc8a](https://github.com/iDrinkx/plex-portal/commit/cc1dc8a))

## <small>1.20.4 (2026-02-23)</small>

* Merge pull request #8 from iDrinkx/develop ([5278b58](https://github.com/iDrinkx/plex-portal/commit/5278b58)), closes [#8](https://github.com/iDrinkx/plex-portal/issues/8)
* fix: enhance debug logging for classement API to track user achievements and errors ([43aac49](https://github.com/iDrinkx/plex-portal/commit/43aac49))

## <small>1.20.3 (2026-02-23)</small>

* Merge pull request #7 from iDrinkx/develop ([c893d76](https://github.com/iDrinkx/plex-portal/commit/c893d76)), closes [#7](https://github.com/iDrinkx/plex-portal/issues/7)
* fix: add option to skip cache for classement API and enhance debug logging for XP calculations ([ef2cd37](https://github.com/iDrinkx/plex-portal/commit/ef2cd37))

## <small>1.20.2 (2026-02-23)</small>

* Merge pull request #6 from iDrinkx/develop ([fcd794f](https://github.com/iDrinkx/plex-portal/commit/fcd794f)), closes [#6](https://github.com/iDrinkx/plex-portal/issues/6)
* fix: add debug logging for XP calculations in API responses ([0c976a1](https://github.com/iDrinkx/plex-portal/commit/0c976a1))

## <small>1.20.1 (2026-02-23)</small>

* Merge pull request #5 from iDrinkx/develop ([b85316b](https://github.com/iDrinkx/plex-portal/commit/b85316b)), closes [#5](https://github.com/iDrinkx/plex-portal/issues/5)
* fix: enhance user stats retrieval by adding user thumbnail and joined date from Tautulli ([c41d7ed](https://github.com/iDrinkx/plex-portal/commit/c41d7ed))
* fix: update daysJoined calculation to use joinedAt from database and remove Tautulli dependency ([0fb1f65](https://github.com/iDrinkx/plex-portal/commit/0fb1f65))

## 1.20.0 (2026-02-23)

* Merge pull request #4 from iDrinkx/develop ([3209766](https://github.com/iDrinkx/plex-portal/commit/3209766)), closes [#4](https://github.com/iDrinkx/plex-portal/issues/4)
* fix: adjust XP calculation multipliers for hours and anciennete ([6f0eaff](https://github.com/iDrinkx/plex-portal/commit/6f0eaff))
* fix: update section title from "Progression des Succès" to "Progression des Badges" ([aac68d7](https://github.com/iDrinkx/plex-portal/commit/aac68d7))
* feat: add tabbed navigation for ranking views with dynamic content switching ([0e317ed](https://github.com/iDrinkx/plex-portal/commit/0e317ed))
* feat: implement automated database maintenance system with manual trigger API ([2bddc91](https://github.com/iDrinkx/plex-portal/commit/2bddc91))

## 1.19.0 (2026-02-23)

* Merge pull request #3 from iDrinkx/develop ([1438295](https://github.com/iDrinkx/plex-portal/commit/1438295)), closes [#3](https://github.com/iDrinkx/plex-portal/issues/3)
* refactor: remove background translation for series titles in calendar ([8031235](https://github.com/iDrinkx/plex-portal/commit/8031235))
* refactor: remove translation functionality from modal overview ([92ffeae](https://github.com/iDrinkx/plex-portal/commit/92ffeae))
* refactor: simplify calendar API integration by removing public URL parameters and updating poster UR ([427f483](https://github.com/iDrinkx/plex-portal/commit/427f483))
* feat: add calendar card for upcoming movie and series releases ([4576058](https://github.com/iDrinkx/plex-portal/commit/4576058))
* feat: add calendar feature for upcoming Radarr and Sonarr releases ([8315754](https://github.com/iDrinkx/plex-portal/commit/8315754))
* feat: add click event to display dynamic day overlay for additional events ([5a2df09](https://github.com/iDrinkx/plex-portal/commit/5a2df09))
* feat: add detailed modal for event display with overview, genres, and status ([ed53520](https://github.com/iDrinkx/plex-portal/commit/ed53520))
* feat: add dynamic day overlay with event details and improved interactivity ([592afb1](https://github.com/iDrinkx/plex-portal/commit/592afb1))
* feat: add functionality to track last opened day in overlay for improved modal navigation ([4e022cb](https://github.com/iDrinkx/plex-portal/commit/4e022cb))
* feat: add public URLs for Radarr and Sonarr, enhance calendar API integration ([76079fe](https://github.com/iDrinkx/plex-portal/commit/76079fe))
* feat: add translation functionality for series overviews in Sonarr calendar ([b2532b6](https://github.com/iDrinkx/plex-portal/commit/b2532b6))
* feat: enhance calendar month view with improved styling and interactivity ([6dd0efd](https://github.com/iDrinkx/plex-portal/commit/6dd0efd))
* feat: implement lazy translation for modal overview with caching ([afe582c](https://github.com/iDrinkx/plex-portal/commit/afe582c))
* feat: implement mobile month view for calendar with weekly event display ([870b026](https://github.com/iDrinkx/plex-portal/commit/870b026))
* feat: implement throttling and background translation for series titles in calendar ([f2f093d](https://github.com/iDrinkx/plex-portal/commit/f2f093d))
* feat: optimize header styling for day overlay modal ([0bd964a](https://github.com/iDrinkx/plex-portal/commit/0bd964a))
* style: adjust alignment and padding for active modal overlay ([7cc62fd](https://github.com/iDrinkx/plex-portal/commit/7cc62fd))
* style: apply red theme to calendar nav link and dashboard card ([a99f817](https://github.com/iDrinkx/plex-portal/commit/a99f817)), closes [#ef4444](https://github.com/iDrinkx/plex-portal/issues/ef4444) [#f87171](https://github.com/iDrinkx/plex-portal/issues/f87171)
* style: update cal-modal-badge to improve layout with display and margin adjustments ([af985d0](https://github.com/iDrinkx/plex-portal/commit/af985d0))
* fix: add null checks for modal and overlay event listeners to prevent errors ([ce2108b](https://github.com/iDrinkx/plex-portal/commit/ce2108b))
* fix: apply glow effect to user avatars in podium and rankings ([0a331a8](https://github.com/iDrinkx/plex-portal/commit/0a331a8))
* fix: convert relative poster URLs to absolute URLs for Radarr and Sonarr ([34c82df](https://github.com/iDrinkx/plex-portal/commit/34c82df))
* fix: enhance avatar display by adjusting overflow and will-change properties ([74911fd](https://github.com/iDrinkx/plex-portal/commit/74911fd))
* fix: enhance event elements with data attributes for improved interactivity ([cf9f769](https://github.com/iDrinkx/plex-portal/commit/cf9f769))
* fix: enhance glow effect intensity on mobile for podium and avatar rings ([c304df4](https://github.com/iDrinkx/plex-portal/commit/c304df4))
* fix: enhance glow effect on placeholders for user avatars ([b0e4700](https://github.com/iDrinkx/plex-portal/commit/b0e4700))
* fix: enhance visibility of glow effect on mobile for podium and avatar rings ([c4e1021](https://github.com/iDrinkx/plex-portal/commit/c4e1021))
* fix: improve avatar display by adjusting overflow and will-change properties ([eab9724](https://github.com/iDrinkx/plex-portal/commit/eab9724))
* fix: remove query parameters from external poster URLs in TVDB poster URL generation ([b28d9dc](https://github.com/iDrinkx/plex-portal/commit/b28d9dc))
* fix: remove unused element for modal availability in event details ([5c0e58f](https://github.com/iDrinkx/plex-portal/commit/5c0e58f))
* fix: update Sonarr calendar thumbnail URL retrieval to prioritize remote URL ([9f3b257](https://github.com/iDrinkx/plex-portal/commit/9f3b257))

## 1.18.0 (2026-02-22)

* Merge pull request #2 from iDrinkx/develop ([5bfef60](https://github.com/iDrinkx/plex-portal/commit/5bfef60)), closes [#2](https://github.com/iDrinkx/plex-portal/issues/2)
* feat: add develop branch to Docker workflow triggers ([9bb5dea](https://github.com/iDrinkx/plex-portal/commit/9bb5dea))
* feat: add Wizarr access check for user authentication ([794ce72](https://github.com/iDrinkx/plex-portal/commit/794ce72))
* feat: enhance authentication flow by parallelizing Plex and Wizarr access checks ([34548bb](https://github.com/iDrinkx/plex-portal/commit/34548bb))
* feat: improve Wizarr access check by filtering users by email and handling missing email case ([01b17ab](https://github.com/iDrinkx/plex-portal/commit/01b17ab))
* feat: run Seerr SSO cookie grab in the background during login ([b62de25](https://github.com/iDrinkx/plex-portal/commit/b62de25))
* feat: streamline Plex access check and move Wizarr verification to background ([5dcc2c9](https://github.com/iDrinkx/plex-portal/commit/5dcc2c9))

## <small>1.17.3 (2026-02-22)</small>

* Merge branch 'main' of https://github.com/iDrinkx/plex-portal ([15025f1](https://github.com/iDrinkx/plex-portal/commit/15025f1))
* refactor: remove version badge from footer display ([bd090da](https://github.com/iDrinkx/plex-portal/commit/bd090da))

## <small>1.17.2 (2026-02-22)</small>

* Merge branch 'main' of https://github.com/iDrinkx/plex-portal ([a5d2fc2](https://github.com/iDrinkx/plex-portal/commit/a5d2fc2))
* refactor: remove unnecessary wait and fetch steps from release workflow ([91ca1b8](https://github.com/iDrinkx/plex-portal/commit/91ca1b8))

## <small>1.17.1 (2026-02-22)</small>

* Merge branch 'main' of https://github.com/iDrinkx/plex-portal ([231ef7a](https://github.com/iDrinkx/plex-portal/commit/231ef7a))
* refactor: remove redundant fetch step from release workflow ([796a659](https://github.com/iDrinkx/plex-portal/commit/796a659))

## 1.17.0 (2026-02-22)

* feat: add npm install step to release workflow ([68d8645](https://github.com/iDrinkx/plex-portal/commit/68d8645))
* Merge branch 'main' of https://github.com/iDrinkx/plex-portal ([e153222](https://github.com/iDrinkx/plex-portal/commit/e153222))
* refactor: simplify version badge logic and remove outdated version check ([78e1714](https://github.com/iDrinkx/plex-portal/commit/78e1714))

## [1.16.0](https://github.com/iDrinkx/plex-portal/compare/v1.15.5...v1.16.0) (2026-02-22)

### ✨ Nouvelles fonctionnalités

* add latest version check from GitHub API and update version badge styling ([402a77c](https://github.com/iDrinkx/plex-portal/commit/402a77ce8408ea633d8693790bf4bae7724fecd4))

## [1.15.5](https://github.com/iDrinkx/plex-portal/compare/v1.15.4...v1.15.5) (2026-02-22)

### 🐛 Corrections de bugs

* increase wait time for GitHub sync in release workflow ([01b6ccc](https://github.com/iDrinkx/plex-portal/commit/01b6ccc820a8b01b9a84ce506039eab9e1b95071))

## [1.15.4](https://github.com/iDrinkx/plex-portal/compare/v1.15.3...v1.15.4) (2026-02-22)

### 🐛 Corrections de bugs

* increase wait time for GitHub sync in release workflow ([c8b62b2](https://github.com/iDrinkx/plex-portal/commit/c8b62b240f698a3880302b0711af484a4d318db9))

## [1.15.3](https://github.com/iDrinkx/plex-portal/compare/v1.15.2...v1.15.3) (2026-02-22)

### 🐛 Corrections de bugs

* add wait time and fetch latest commits in release workflow ([6fec29c](https://github.com/iDrinkx/plex-portal/commit/6fec29ca191a7349b5bb328cb4bc9ac55a934b23))

## [1.15.2](https://github.com/iDrinkx/plex-portal/compare/v1.15.1...v1.15.2) (2026-02-22)

### 🐛 Corrections de bugs

* increase wait time for GitHub sync and add fetch latest commits step ([6738416](https://github.com/iDrinkx/plex-portal/commit/673841652a244edaf6cd82c0cdfa67016832cd4d))

## [1.15.1](https://github.com/iDrinkx/plex-portal/compare/v1.15.0...v1.15.1) (2026-02-22)

### 🐛 Corrections de bugs

* update GitHub Actions workflow to set fetch depth and reference for checkout ([3b6aa1d](https://github.com/iDrinkx/plex-portal/commit/3b6aa1dd4c0fb338ecc788e1c486d02bb9939a71))

## [1.15.0](https://github.com/iDrinkx/plex-portal/compare/v1.14.0...v1.15.0) (2026-02-22)

### ✨ Nouvelles fonctionnalités

* add version footer and changelog modal to dashboard ([e43c00d](https://github.com/iDrinkx/plex-portal/commit/e43c00de1b8026b1632f85f97be6f4e142b370b8))

## [1.14.0](https://github.com/iDrinkx/plex-portal/compare/v1.13.6...v1.14.0) (2026-02-22)

### ✨ Nouvelles fonctionnalités

* add public /changelog page for version display and changelog access ([4f5f769](https://github.com/iDrinkx/plex-portal/commit/4f5f769406a6a39c07f8c1fded109f65c521ae33))
* add simple public /version page displaying latest version ([dcc0fac](https://github.com/iDrinkx/plex-portal/commit/dcc0facf580608b70d6955f8f84eb39ea7421de6))

## [1.13.6](https://github.com/iDrinkx/plex-portal/compare/v1.13.5...v1.13.6) (2026-02-22)

### 🐛 Corrections de bugs

* update version display instructions in README ([768f84c](https://github.com/iDrinkx/plex-portal/commit/768f84c4114b997dff380f72db9e85225f5d5e0e))

## [1.13.5](https://github.com/iDrinkx/plex-portal/compare/v1.13.4...v1.13.5) (2026-02-22)

### 🐛 Corrections de bugs

* add dynamic version badge endpoint and update README badge display ([bdf5063](https://github.com/iDrinkx/plex-portal/commit/bdf506382a1805bf72709dae11904ac5a59b5649))

## [1.13.4](https://github.com/iDrinkx/plex-portal/compare/v1.13.3...v1.13.4) (2026-02-22)

### 🐛 Corrections de bugs

* streamline README version badge update process using GitHub API ([da384d7](https://github.com/iDrinkx/plex-portal/commit/da384d7cda8b28ef66a1b01f8f6baad0a8aff230))

## [1.13.3](https://github.com/iDrinkx/plex-portal/compare/v1.13.2...v1.13.3) (2026-02-22)

### 🐛 Corrections de bugs

* enhance README badge update logic and ensure proper version fetching ([1819d6c](https://github.com/iDrinkx/plex-portal/commit/1819d6c4a7860c9e90ea13f6d9725e87330410ec))

## [1.13.2](https://github.com/iDrinkx/plex-portal/compare/v1.13.1...v1.13.2) (2026-02-22)

### 🐛 Corrections de bugs

* update README version badge to 1.13.1 and improve badge update logic in release workflow ([59b4c41](https://github.com/iDrinkx/plex-portal/commit/59b4c414156e40ead7e01f9ba3083921c0142d32))

## [1.13.1](https://github.com/iDrinkx/plex-portal/compare/v1.13.0...v1.13.1) (2026-02-22)

### 🐛 Corrections de bugs

* update version to 1.13.0 and enhance README badge update logic ([3f859c6](https://github.com/iDrinkx/plex-portal/commit/3f859c6029e892bf3a2d2c7b6d23aa7435e20791))

## [1.13.0](https://github.com/iDrinkx/plex-portal/compare/v1.12.0...v1.13.0) (2026-02-22)

### ✨ Nouvelles fonctionnalités

* add API endpoint for changelog and update README version badge ([8ac464d](https://github.com/iDrinkx/plex-portal/commit/8ac464d3874f204cf8131965161547563f43eac1))

### 📚 Documentation

* update version display in README.md ([1aa91c3](https://github.com/iDrinkx/plex-portal/commit/1aa91c373932c7f59024ca9c244ee75a8b82f4bf))

## [1.12.0](https://github.com/iDrinkx/plex-portal/compare/v1.11.6...v1.12.0) (2026-02-22)

### ✨ Nouvelles fonctionnalités

* add version footer and changelog modal with API integration ([d3d7244](https://github.com/iDrinkx/plex-portal/commit/d3d724493467862c88a7027b279a0946d8aa39e0))

### 📚 Documentation

* add source code and contribution guidelines to documentation ([5119e3f](https://github.com/iDrinkx/plex-portal/commit/5119e3f48d2f1af588b22b773af5d18274bae014))
* update README and add LICENSE file with usage terms ([4537dbc](https://github.com/iDrinkx/plex-portal/commit/4537dbc9f54479fa030b8365cc4f57b5b4fd4a64))
* update README.md version and fix links in UNRAID.md ([042f4fa](https://github.com/iDrinkx/plex-portal/commit/042f4fa1255eefd93f016ae3ba20b6f6b0b8b0bc))

# Changelog

## [1.11.6] - 2025-02-21

### 📚 Documentation
- Updated README and added LICENSE file with usage terms

### 🔧 Maintenance
- Optimized XP calculation and adjusted achievement values for improved engagement

---

## [1.11.5] - 2025-02-20

### ✨ Features
- Initial release with XP and achievement system

---

## Release Notes

### Version 1.13.0 (Upcoming)
- **New XP Multipliers**: HOURS: 10 XP/h, ANCIENNETE: 1.5 XP/j
- **Updated Achievement Rewards**: 200-5000 XP range based on difficulty
- **Enhanced UI**: Improved achievements display with animations and tooltips

### Version 1.12.0
- Rebalanced XP system: HOURS: 8 XP/h, ANCIENNETE: 1 XP/j
- Individual achievement XP values (200-1200 range)

### Version 1.11.x
- Mobile UI improvements for achievements section
- Desktop glassmorphism design with animations
- Docker workflow optimization with semantic-release

---

**For the latest updates and detailed changelog, visit:** https://github.com/iDrinkx/plex-portal/releases
