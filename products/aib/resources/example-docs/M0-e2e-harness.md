# Milestone 0 — E2E Test Harness

## Goal

Prove we can launch Electron under Playwright, interact with the UI, and run isolated tests. This milestone establishes the **foundation** for all future E2E testing.

**No product features in this milestone** — only infrastructure.

---

## Prerequisites

Before starting M0, ensure:
- Node 24 LTS + Bun installed
- .NET 10 SDK installed
- Playwright installed globally or in project
- Basic Electron app boots (even if empty)

---

## Tasks Overview

| Task | Description | E2E Test |
|------|-------------|----------|
| 0.1 | Test mode flag handling (backend + Electron) | — |
| 0.2 | Dialog stubs for folder selection | — |
| 0.3 | Test API surface (`__memexTest`) | — |
| 0.4 | Playwright Electron harness + fixtures | `app_launches_and_shows_empty_state` |
| 0.5 | Empty state UI with Cmd+K | `app_launches_and_shows_empty_state` |

---

## Task 0.1: Test Mode Flag Handling

### Purpose
The application must detect when it's running in E2E test mode and adjust behavior accordingly:
- Use isolated data directories
- Disable animations
- Enable test API
- Allow fixture-based tool outputs

### Backend Requirements

**TestModeConfig** (`src/Memex.Core/Configuration/TestModeConfig.cs`):
- Immutable record holding all test mode settings
- Static `FromEnvironment()` factory reads env vars
- Properties: `IsE2E`, `FixtureDir`, `UseFixtureToolOutputs`, `UserDataDir`, `DisableEffects`

**Program.cs changes**:
1. Load `TestModeConfig.FromEnvironment()` early
2. Register as singleton for DI
3. Override DB path when `UserDataDir` is set
4. Log test mode status to console (helps debug CI failures)

### Electron Main Process Requirements

**Test config loading** (`apps/memex-electron/src/main.ts`):
- Load test config from `process.env` at startup
- Call `app.setPath('userData', ...)` **before** `app.whenReady()` — critical timing!
- Mirror same properties as backend: `isE2E`, `userDataDir`, `fixtureDir`, `disableEffects`, `fixtureToolOutputs`

**Window creation adjustments in test mode**:
- Skip fade-in animations (`show: true` immediately)
- Set solid background color
- Send config to renderer via `app:config` event after load

**Custom protocol** (`memex://`):
- Register file protocol for thumbnail serving
- Pattern: `memex://thumb/{mediaId}/{size}` → local file path
- Allows secure thumbnail loading without exposing filesystem

**IPC handler**: `app:getTestConfig` — lets renderer query test mode status

### Decisions Made

| Decision | Rationale |
|----------|-----------|
| Config as immutable record | Thread-safe, no mutation bugs |
| Environment variables over flags | Easy to set in Playwright, CI, and scripts |
| Early `userData` override | Must happen before Electron 'ready' event |
| Separate config per layer | Backend and Electron may run different instances |

---

## Task 0.2: Dialog Stubs for Folder Selection

### Purpose
In E2E tests, we cannot interact with native OS dialogs. The app must return fixture paths automatically when `MEMEX_FIXTURE_DIR` is set.

### Dialog Stub Requirements

**Problem**: Native OS dialogs cannot be controlled by Playwright. Tests would hang waiting for user input.

**Solution**: IPC handlers that check test mode and return fixture paths automatically.

**IPC handlers to implement**:

| Handler | E2E Behavior | Production Behavior |
|---------|--------------|--------------------|
| `dialog:selectFolder` | Return `fixtureDir` if set, else `canceled: true` | Show native folder picker |
| `dialog:selectFile` | Return `canceled: true` (or specific fixture file) | Show native file picker |
| `dialog:showMessage` | Auto-confirm (return `response: 0`) | Show native message box |

**Important details**:
- Verify fixture directory exists before returning it
- Log all stub invocations with `[E2E]` prefix for debugging
- Return same shape as real Electron dialog APIs (`{ canceled, filePaths }`)

### Preload Bridge Requirements

**Two API surfaces** exposed via `contextBridge`:

#### 1. `window.memexApi` (always available)

| Method | Purpose |
|--------|--------|
| `getAppConfig()` | Get test mode config |
| `selectFolder()` | Trigger folder picker (or stub) |
| `selectFile(options)` | Trigger file picker (or stub) |
| `showMessage(options)` | Show message dialog (or auto-confirm) |
| `onAppConfig(callback)` | Subscribe to config changes |

#### 2. `window.__memexTest` (E2E mode only)

| Method | Purpose |
|--------|--------|
| `getAppState()` | Get job counts, media count, db path |
| `waitForIdle(timeoutMs)` | Block until no running/paused jobs |
| `getLastToast()` | Get last toast message for assertions |
| `dumpJobs()` | Debug dump of all jobs |
| `forceRefresh()` | Trigger UI refresh |
| `queryDb(sql, params)` | Run SELECT query (read-only!) |

**Security considerations**:
- Test API only exposed when `MEMEX_E2E=1`
- `queryDb` restricted to SELECT queries only
- All methods go through IPC (no direct Node access in renderer)

### Type Declarations

Create `apps/memex-ui/src/types/preload.d.ts` with:
- `DialogResult`, `MessageDialogOptions`, `MessageDialogResult` interfaces
- `AppConfig` interface (`isE2E`, `disableEffects`)
- `MemexApi` interface (main API surface)
- `MemexTestApi` interface (test-only API)
- Global `Window` interface augmentation

---

## Task 0.3: Test API Implementation

### Purpose
The `__memexTest` API allows Playwright tests to:
- Query app state for assertions
- Wait for background jobs to complete
- Access toast messages
- Debug job states

### Test API Implementation Requirements

**Electron main process** (`apps/memex-electron/src/main.ts`):

Only register handlers when `testConfig.isE2E` is true:

| IPC Handler | Implementation |
|-------------|---------------|
| `test:getAppState` | Combine app version + sidecar state |
| `test:waitForIdle` | Poll job counts until running=0 and paused=0, with timeout |
| `test:getLastToast` | Return stored toast (capture via `toast:show` event from renderer) |
| `test:dumpJobs` | Forward to sidecar `test.dumpJobs` |
| `test:forceRefresh` | Send `app:forceRefresh` to renderer |
| `test:queryDb` | Forward to sidecar `test.queryDb` |

**Backend sidecar** (`src/Memex.Backend/JsonRpc/TestHandler.cs`):

JSON-RPC handlers that:
1. Guard with `if (!_testConfig.IsE2E) throw`
2. Query SQLite for job/media counts
3. Restrict `queryDb` to SELECT-only (security)

**Records needed**:
- `AppStateResult` — job counts + media count
- `JobCountsResult` — running, paused, completed, failed counts
- `JobDump` — id, type, state, currentStep, itemsProcessed, itemsTotal

---

## Task 0.4: Playwright Electron Harness

### Purpose
Set up Playwright to launch and control the Electron app with proper fixtures for isolated testing.

### Playwright Configuration

**File**: `e2e/playwright.config.ts`

**Key settings**:
- `workers: 1` — Electron tests need process isolation (can't parallelize)
- `timeout: 20_000` with explicit per-test exceptions for known long-path flows
- `expect.timeout: 3_000` to keep ordinary assertions fast-fail
- `fullyParallel: false` — Sequential test execution
- `retries: 2` in CI only
- `maxFailures: 1` in CI only
- Global setup/teardown for build + cleanup
- Single `electron` project matching `**/*.spec.ts`

### Global Setup/Teardown

**global-setup.ts**:
1. Build `memex-ui` (skip if `MEMEX_E2E_DEV` set for faster iteration)
2. Build `memex-electron` main process
3. Ensure `e2e/fixtures/` directory exists

**global-teardown.ts**:
1. Clean orphaned test directories in `/tmp/memex-e2e/`
2. Only remove directories older than 1 hour (safety for parallel runs)

### Electron Test Fixture

**File**: `e2e/fixtures/electron-fixture.ts`

Extend Playwright's base test with Electron-specific fixtures:

**Context provided to each test**:

| Fixture | Purpose | Lifecycle |
|---------|---------|----------|
| `testId` | Unique UUID per test | Generated fresh |
| `userDataDir` | Isolated `/tmp/memex-e2e/{testId}` | Created before, deleted after |
| `fixtureDir` | Path to media fixtures (if `options.fixture` set) | Resolved from `e2e/fixtures/` |
| `electronApp` | Launched Electron app instance | Launched before, closed after |
| `page` | Main window Page object | Acquired from `electronApp.firstWindow()` |

**Environment variables set automatically**:
- `MEMEX_E2E=1`
- `MEMEX_USER_DATA_DIR={userDataDir}`
- `MEMEX_DISABLE_EFFECTS=1`
- `MEMEX_FIXTURE_DIR={fixtureDir}` (if fixture specified)
- `MEMEX_FIXTURE_TOOL_OUTPUTS=1` (if option set)

**Page readiness checks**:
1. Wait for `domcontentloaded`
2. Wait for `[data-testid="app-shell"]` visible
3. Verify `window.__memexTest` exists

**Helper functions to export**:
- `waitForIdle(page, timeoutMs)` — waits for no running jobs
- `getAppState(page)` — returns job counts + media count
- `getLastToast(page)` — returns last toast message
- `queryDb(page, sql, params)` — runs SELECT query

---

## Task 0.5: Empty State UI + Cmd+K

### Purpose
Create the minimal UI shell that shows:
- Empty state when no media imported
- Working Cmd+K command bar

### UI Requirements

**App Shell** (`apps/memex-ui/src/App.tsx`):

| Element | `data-testid` | `data-state` | Purpose |
|---------|--------------|--------------|--------|
| Root container | `app-shell` | `loading` / `ready` | E2E readiness detection |
| Cmd+K button | `cmdk-trigger` | — | Opens command bar |

**Keyboard shortcuts**:
- `Cmd+K` / `Ctrl+K` → Open command bar
- `Escape` → Close command bar
- Disable CSS transitions when `config.disableEffects` is true

**Empty State** (`apps/memex-ui/src/components/EmptyState.tsx`):

| Element | `data-testid` | Purpose |
|---------|--------------|--------|
| Container | `empty-state` | Detect empty library state |
| Import button | `import-trigger` | Primary CTA to start import |

**Content**:
- Icon placeholder
- "No media imported yet" heading
- Helpful description text
- "Import Folder" button
- Keyboard hint for `⌘I`

**Command Bar** (`apps/memex-ui/src/components/CommandBar.tsx`):

| Element | `data-testid` | Purpose |
|---------|--------------|--------|
| Modal overlay | `cmdk-overlay` | Click outside to close |
| Search input | `cmdk-input` | Filter commands |
| Command item | `cmdk-item-{id}` | Individual command rows |

**Initial commands**:
- Import Folder (`⌘I`)
- Settings (`⌘,`)
- Help & Documentation

**Keyboard navigation**:
- Arrow keys to select
- Enter to execute
- Type to filter
- Focus input when opened

**useAppConfig hook** (`apps/memex-ui/src/hooks/useAppConfig.ts`):
- Load config via `window.memexApi.getAppConfig()` on mount
- Subscribe to `onAppConfig` for updates
- Return `{ config, isLoading }`
- Default to `{ isE2E: false, disableEffects: false }` on error

---

## E2E Test: `app_launches_and_shows_empty_state`

### E2E Test Scenarios

**File**: `e2e/tests/app-launch.spec.ts`

#### Test: `app_launches_and_shows_empty_state`

| Step | Action | Assertion |
|------|--------|-----------|
| 1 | Wait for app | `app-shell` has `data-state="ready"` |
| 2 | Check empty state | `empty-state` visible, contains "No media imported yet" |
| 3 | Check CTA | `import-trigger` visible |
| 4 | Check command bar trigger | `cmdk-trigger` visible |
| 5 | Press Cmd+K | `cmdk-dialog` visible, `cmdk-input` focused |
| 6 | Check commands | `cmdk-item-import`, `cmdk-item-settings` visible |
| 7 | Type "import" | Only `cmdk-item-import` visible (filtered) |
| 8 | Press Escape | `cmdk-dialog` not visible |

#### Test: `test_api_is_available_in_e2e_mode`

| Step | Action | Assertion |
|------|--------|-----------|
| 1 | Evaluate `window.__memexTest` | Defined (not undefined) |
| 2 | Call `getAppState()` | Returns `dbPath`, `jobCounts`, `mediaCount: 0` |

#### Test: `isolated_user_data_directory`

| Step | Action | Assertion |
|------|--------|-----------|
| 1 | Call `getAppState()` | `dbPath` contains `userDataDir` fixture path |

---

## Acceptance Criteria

### Task 0.1: Test Mode Flags
- [ ] `MEMEX_E2E=1` enables test mode in backend and Electron
- [ ] `MEMEX_USER_DATA_DIR` overrides userData path before app ready
- [ ] `MEMEX_DISABLE_EFFECTS=1` is passed to renderer
- [ ] Backend logs test mode status on startup

### Task 0.2: Dialog Stubs
- [ ] `dialog:selectFolder` returns `MEMEX_FIXTURE_DIR` in E2E mode
- [ ] `dialog:showMessage` auto-confirms in E2E mode
- [ ] Real dialogs work in production mode

### Task 0.3: Test API
- [ ] `__memexTest` only exposed when `MEMEX_E2E=1`
- [ ] `getAppState()` returns build version, db path, counts
- [ ] `waitForIdle()` waits for all jobs to complete
- [ ] `getLastToast()` returns last toast message
- [ ] `queryDb()` allows SELECT queries only

### Task 0.4: Playwright Harness
- [ ] Tests launch with isolated `userDataDir`
- [ ] `userDataDir` is cleaned up after each test
- [ ] `fixtureDir` can be specified per test
- [ ] App waits for `data-testid="app-shell"` before continuing

### Task 0.5: Empty State UI
- [ ] Empty state shows when no media imported
- [ ] Cmd+K opens command bar
- [ ] Command bar shows searchable commands
- [ ] Escape closes command bar
- [ ] All interactive elements have `data-testid`

### E2E Test
- [ ] `app_launches_and_shows_empty_state` passes
- [ ] `test_api_is_available_in_e2e_mode` passes
- [ ] `isolated_user_data_directory` passes
- [ ] Existing consolidated flows are extended before a new E2E spec file is added
- [ ] Repeated imports of the same fixture across separate specs are justified
- [ ] Normal tests target <=10s and anything >20s has an explicit documented exception

---

## Files Changed Summary

| File | Action | Purpose |
|------|--------|---------|
| `src/Memex.Core/Configuration/TestModeConfig.cs` | Create | Test mode config record |
| `src/Memex.Backend/Program.cs` | Modify | Load test config, configure paths |
| `src/Memex.Backend/JsonRpc/TestHandler.cs` | Create | Test API handlers |
| `apps/memex-electron/src/main.ts` | Modify | Test flags, dialog stubs, test IPC |
| `apps/memex-electron/src/preload.ts` | Modify | Test API bridge |
| `apps/memex-ui/src/types/preload.d.ts` | Create | TypeScript declarations |
| `apps/memex-ui/src/App.tsx` | Modify | App shell with data-testid |
| `apps/memex-ui/src/components/EmptyState.tsx` | Create | Empty state component |
| `apps/memex-ui/src/components/CommandBar.tsx` | Create | Command bar component |
| `apps/memex-ui/src/hooks/useAppConfig.ts` | Create | App config hook |
| `e2e/playwright.config.ts` | Create | Playwright configuration |
| `e2e/global-setup.ts` | Create | Build before tests |
| `e2e/global-teardown.ts` | Create | Cleanup after tests |
| `e2e/fixtures/electron-fixture.ts` | Create | Electron test fixture |
| `e2e/tests/app-launch.spec.ts` | Create | First E2E test |
