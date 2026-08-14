# Changelog

All notable changes to **pi-router-pintar** — the fork of
[`beettlle/pi-smart-router`](https://github.com/beettlle/pi-smart-router) published to npm —
are documented here. Versions follow SemVer (`0.y.z`).

## [0.17.2] - 2026-08-14

### Fixed
- Re-registration of the `smart-router/auto` entry now carries the provider's
  `api`/`baseUrl` fields on every call. Pi validates the raw registration config
  before merging, so a models-only re-registration threw `no "api" specified`
  and silently skipped the footer context-window sync (footer stayed at `200k`
  even though routing was active). Registration failures are also surfaced via
  `console.error` instead of failing the routed request.

## [0.17.1] - 2026-08-13

### Fixed
- The registered `smart-router/auto` model entry now syncs the delegated model's real
  `contextWindow`/`maxTokens` after each successful routing decision (deduped per change)
  and restores them from the execution ledger on session resume. Pi's footer context
  percentage and the auto-compaction threshold (`contextWindow − reserveTokens`) now
  follow the model actually selected by the router instead of a hardcoded `200k`/`16k`.

## [0.17.0] - 2026-08-13

### Added
- **Plan B complexity re-scoring**: deterministic per-request complexity scorer,
  complexity-aware session pin switching, and pipeline wiring for justified bidirectional
  economical ↔ frontier switching that preserves KV-cache economics.
- **Pi model limit pass-through**: retain component prices and Pi model limits
  (`contextWindow`/`maxTokens`); convert Pi per-1M cost rates at the registry boundary
  (SP-046).

## [0.16.2] - 2026-08-13

### Fixed
- **Loop-escalation failure detection** via the `is_error`/`status` fields instead of
  fragile body-substring matching.
- **`gpt-5.5+` classified as `frontier-cloud`** in the model mapper (5.6/5.7/…).
- **Self-delegation guard**: `smart-router/auto` excluded from delegation targets so the
  router never routes requests back into itself.

### Changed
- Fork renamed to **`pi-router-pintar`** and published to npm; upstream credit and MIT
  license retained.

## [0.16.0] - 2026-08-03

### Added
- First fork release: continues the upstream lineage; K=4 head-mode A/B measurement and
  refreshed live benchmark profiles (SP-218/SP-219).
