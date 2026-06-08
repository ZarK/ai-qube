# Milestone 2 — Jobs Control Surface

## Strategic Goal

Establish the **restartability contract** that everything depends on. Users must be able to pause, resume, cancel, and reset any job. This is fundamental to the non-destructive, user-controlled philosophy of Memex.

**Success looks like:** User can pause a long-running import, close the app, reopen it, resume from where they left off, or cancel and reset to try with different settings.

---

## Spec Requirements (from spec.md)

This milestone addresses:

| Requirement | Spec Section | Notes |
|-------------|--------------|-------|
| Imports are resumable and can be cancelled | §2.1 | Core requirement |
| Every stage supports cancel/restart/rerun | §2.2, §3.2 | CancellationToken throughout |
| Tasks page shows running and completed jobs | §2.9 | Full job history |
| Each job streams progress events | §2.9 | Real-time feedback |
| Errors grouped with retry controls | §2.9 | Actionable error handling |
| Intermediate outputs can be cleaned and recomputed | §2.2 | Reset outputs feature |

---

## Why This Milestone Matters

Without proper job control:
- Users can't stop a misbehaving import
- Crashed imports leave orphaned data
- Can't experiment with different settings
- No way to recover from errors

The pause/resume/cancel/reset capabilities make Memex **safe to use** on large libraries. Users know they can always stop and try again.

---

## Task 2.1: Tasks Popover (Quick View)

### What We're Building

A **dropdown popover** from the header pill that shows active jobs at a glance.

### Design Rationale

Users need to see job status without leaving their current context. The popover:
- Shows top 5 active jobs (running or paused)
- Provides quick pause/resume/cancel controls
- Links to full tasks panel for details

### UI Requirements

#### Header Pill (Always Visible)

The tasks pill in the header shows aggregate state:

| State | Appearance | Trigger |
|-------|------------|---------|
| Idle | Muted, no count | No running/paused jobs |
| Running | Animated spinner + count | At least one job running |
| Paused | Pause icon + count | Jobs paused, none running |
| Error | Red indicator + count | Jobs failed recently |

**Priority order**: If multiple states, show highest priority: Error > Running > Paused > Idle

#### Popover Content

When clicked, popover shows:

1. **Active jobs list** (max 5)
   - Job type icon (import, thumbnail, enrichment)
   - Progress bar with percentage
   - Current step name
   - Quick action buttons (pause/resume/cancel)

2. **Summary footer**
   - "View all tasks" link to full panel
   - Total counts: "3 running, 1 paused"

#### Job Row in Popover

Each job row displays:
```
┌─────────────────────────────────────────────┐
│ 📥 Import                          Running  │
│ ████████░░░░░░░░░░░░░  42%                 │
│ Extracting metadata... (423/1,012)          │
│                              [⏸] [✕]        │
└─────────────────────────────────────────────┘
```

- Type icon and label
- State badge (Running, Paused, etc.)
- Progress bar (determinate if total known, indeterminate otherwise)
- Current step and counts
- Action buttons (context-dependent)

### Interaction Patterns

| User Action | Result |
|-------------|--------|
| Click pill | Open popover |
| Click outside | Close popover |
| Click pause button | Job pauses, button becomes resume |
| Click cancel button | Confirmation toast, then cancels |
| Click "View all" | Navigate to tasks panel |

### Required Selectors

| Selector | Element | Attributes |
|----------|---------|------------|
| `tasks-pill` | Header button | `data-job-state="idle\|running\|paused\|error"`, `data-count` |
| `tasks-popover` | Dropdown container | — |
| `task-row-{jobId}` | Job row | `data-job-state` |
| `task-progress-{jobId}` | Progress bar | `data-percent`, `data-indeterminate` |
| `task-step-{step}` | Step label | — |
| `task-pause` | Pause button | `disabled` when not pausable |
| `task-resume` | Resume button | — |
| `task-cancel` | Cancel button | — |
| `tasks-open` | View all link | — |

---

## Task 2.2: Tasks Full Panel

### What We're Building

A **dedicated panel** showing complete job history with detailed controls.

### Design Rationale

The popover shows quick status; the panel provides:
- Full job history (not just active)
- Detailed step-by-step progress
- Error logs and retry options
- Reset outputs capability
- Job configuration review

### Panel Layout

```
┌─────────────────────────────────────────────────────────┐
│ Tasks                                          [Filters]│
├─────────────────────────────────────────────────────────┤
│ ○ All  ○ Active  ○ Completed  ○ Failed                  │
├─────────────────────────────────────────────────────────┤
│                                                         │
│ ┌─────────────────────────────────────────────────────┐ │
│ │ Import — Photos/2023          ▼ Expand    Running   │ │
│ │ ████████████░░░░░░░░░░  65%                         │ │
│ │ Started 5 min ago • ETA 3 min                       │ │
│ │                                                     │ │
│ │ Steps:                                              │ │
│ │ ✓ Discover (1,012 files)                           │ │
│ │ ✓ Fingerprint (1,012 files)                        │ │
│ │ ● Metadata (658/1,012)         ← currently here    │ │
│ │ ○ Merge                                            │ │
│ │ ○ Thumbnails                                       │ │
│ │                                                     │ │
│ │ [Pause] [Cancel]                                    │ │
│ └─────────────────────────────────────────────────────┘ │
│                                                         │
│ ┌─────────────────────────────────────────────────────┐ │
│ │ Import — Old Backup            Completed            │ │
│ │ Finished 2 hours ago                                │ │
│ │ 5,432 files • 234 duplicates found                 │ │
│ │                                                     │ │
│ │ [Reset Outputs] [View in Library]                   │ │
│ └─────────────────────────────────────────────────────┘ │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

### Expanded Job View

When expanded, each job shows:

1. **Configuration summary**
   - Source folders
   - Enabled modules
   - Advanced parameters used

2. **Step-by-step progress**
   - Each pipeline step with state icon
   - Items processed / total per step
   - Duration per step

3. **Warnings and errors**
   - Grouped by type
   - File paths affected
   - Retry button for retriable errors

4. **Actions** (state-dependent)
   - Running: Pause, Cancel
   - Paused: Resume, Cancel
   - Completed: Reset Outputs, View in Library
   - Failed: Retry, Reset Outputs
   - Cancelled: Reset Outputs, Restart

### Job States Explained

| State | Meaning | Available Actions |
|-------|---------|-------------------|
| Pending | Queued, waiting to start | Cancel |
| Running | Actively processing | Pause, Cancel |
| Paused | User paused, can resume | Resume, Cancel |
| Completed | Finished successfully | Reset, View |
| Cancelled | User stopped | Reset, Restart |
| Failed | Error occurred | Retry, Reset |

### Required Selectors

| Selector | Element |
|----------|---------|
| `tasks-panel` | Panel container |
| `tasks-filter-{type}` | Filter buttons |
| `task-row-{jobId}` | Job card |
| `task-expand-{jobId}` | Expand toggle |
| `task-config-{jobId}` | Config summary |
| `task-steps-{jobId}` | Steps list |
| `task-step-{jobId}-{step}` | Individual step |
| `task-errors-{jobId}` | Errors section |
| `task-pause` | Pause button |
| `task-resume` | Resume button |
| `task-cancel` | Cancel button |
| `task-reset` | Reset outputs button |
| `task-retry` | Retry button |

---

## Task 2.3: Pause/Resume Implementation

### What We're Building

The **infrastructure** for pausing and resuming long-running jobs.

### Design Decisions

#### Cooperative Pausing

Pausing is **cooperative**, not preemptive. The pipeline must check for pause requests periodically:

```
for each file in files:
    checkPauseOrCancel()  ← blocks if paused
    process(file)
```

This means:
- Pause takes effect at next checkpoint (not mid-operation)
- Current file finishes processing before pause
- Typically < 1 second delay

**Why cooperative?** Preemptive interruption would leave data in inconsistent state. A file being written to DB would be half-written. Cooperative pausing ensures each atomic unit completes.

#### Pause vs Cancel

| Aspect | Pause | Cancel |
|--------|-------|--------|
| Intent | Temporary stop | Permanent stop |
| State preserved | Yes, can resume | Partial, may need reset |
| Use case | Computer needed for other tasks | Wrong settings, want to retry |
| Job state | `paused` | `cancelled` |

#### Resume Semantics

When resumed:
- Pipeline continues from last checkpoint
- Already-processed files are skipped
- Progress counter continues from where it was

### Implementation Requirements

#### Backend Pause State

Each active job needs:
- **CancellationTokenSource** — For cancellation
- **PauseSignal** — TaskCompletionSource or ManualResetEvent
- **IsPaused flag** — Current pause state

#### Pause Flow

```
User clicks Pause
    → UI calls pauseJob(jobId)
    → IPC to main process
    → JSON-RPC to backend
    → JobService.PauseJob(jobId):
        1. Set job.isPaused = true
        2. Create new pause signal (blocks)
        3. Update DB: state = 'paused', paused_at = now
        4. Emit JobPausedEvent
    → UI receives event, updates state
```

#### Pipeline Checkpoint

Every pipeline step must call checkpoint method:

```
async function processFiles(files, jobId):
    for file in files:
        await jobService.checkPauseOrCancel(jobId)  // May block!
        
        result = await processFile(file)
        yield result
        
        // Save checkpoint every N files
        if (processedCount % 50 == 0):
            await saveCheckpoint(jobId, file.path)
```

The `checkPauseOrCancel` method:
1. Checks cancellation token → throws if cancelled
2. Checks pause flag → blocks on pause signal if paused
3. Returns normally if neither

#### Resume Flow

```
User clicks Resume
    → UI calls resumeJob(jobId)
    → Backend:
        1. Set job.isPaused = false
        2. Signal pause signal (unblocks)
        3. Update DB: state = 'running', paused_at = null
        4. Emit JobResumedEvent
    → Blocked pipeline continues
    → Progress events resume
```

### State Machine

```
                ┌─────────┐
                │ pending │
                └────┬────┘
                     │ start
                     ▼
    ┌───────────► running ◄───────────┐
    │                │                │
    │ resume         │ pause          │
    │                ▼                │
    │           ┌────────┐            │
    └───────────│ paused │────────────┘
                └───┬────┘      cancel
                    │
    ┌───────────────┼───────────────┐
    │ cancel        │               │
    ▼               ▼               ▼
┌──────────┐  ┌───────────┐  ┌──────────┐
│cancelled │  │ completed │  │  failed  │
└──────────┘  └───────────┘  └──────────┘
```

### Error Handling

| Scenario | Behavior |
|----------|----------|
| Pause during DB write | Write completes, then pauses |
| Pause during file read | Read completes, then pauses |
| Resume after app restart | Load checkpoint, continue from there |
| Cancel while paused | Immediate transition to cancelled |

---

## Task 2.4: Cancel with Cleanup

### What We're Building

Proper **cancellation handling** that stops jobs cleanly and optionally cleans up partial outputs.

### Design Decisions

#### Cancellation is Cooperative Too

Like pause, cancellation is cooperative:
1. Request sets cancellation token
2. Pipeline checks token at next checkpoint
3. OperationCanceledException propagates up
4. Job transitions to `cancelled` state

#### What Gets Cleaned Up?

On cancellation, we have choices:

| Strategy | Pros | Cons |
|----------|------|------|
| Keep partial results | User sees some progress | Inconsistent state |
| Delete partial results | Clean slate | Lost work |
| Keep, mark incomplete | Both | Complexity |

**Decision: Keep partial results by default.**

Rationale:
- Users might want the files already processed
- Reset Outputs provides explicit cleanup option
- Avoids data loss accidents

The job record shows `cancelled` state, making it clear import was incomplete.

#### Cancellation Flow

```
User clicks Cancel
    → Confirmation dialog (if > 10% complete)
    → UI calls cancelJob(jobId)
    → Backend:
        1. Set cancellation token
        2. If paused, unblock pause signal with cancellation
        3. Wait for pipeline to notice (short timeout)
        4. Update DB: state = 'cancelled', completed_at = now
        5. Emit TaskCompletedEvent (with cancelled=true)
    → UI shows cancelled state
```

#### Timeout Handling

If pipeline doesn't respond to cancellation within 5 seconds:
- Force-mark as cancelled in DB
- Log warning about unclean shutdown
- On next app start, detect orphaned running jobs

### Partial Output Handling

When cancelled mid-import:

| What exists | State |
|-------------|-------|
| Discovered files | Asset records exist |
| Fingerprinted files | Hashes computed |
| Duplicate groups | Partial (may be incomplete) |
| Metadata | Partial extraction |
| VirtualMedia | Some items exist |
| Thumbnails | Some generated |

The library shows only the VirtualMedia items that were fully created. Partial data stays in DB but isn't visible.

### User Communication

After cancellation:
- Toast: "Import cancelled. 423 of 1,012 files processed."
- Job row shows cancelled state
- "Reset Outputs" button available to clean up

---

## Task 2.5: Reset Outputs Functionality

### What We're Building

The ability to **delete all outputs from a job** and optionally restart with new settings.

### Why Reset?

Users need to reset when:
- Import used wrong settings (e.g., wrong duplicate threshold)
- Want to try different modules
- Testing/development
- Corrupted data from crash

### What Gets Deleted

Reset removes **derived data**, not source information:

| Deleted | Kept |
|---------|------|
| VirtualMedia records | Job record (for history) |
| Duplicate groups and members | Job configuration |
| Metadata candidates | Source folder paths |
| Change records | |
| Thumbnails (files) | |
| Asset records | |

**Decision: Delete asset records too.**

Initially considered keeping assets (physical file info) since they're expensive to recompute. But:
- Asset records include job_id, creating foreign key issues
- Users expect "reset" to mean "start fresh"
- Re-fingerprinting is fast on modern hardware

### Reset Flow

```
User clicks "Reset Outputs"
    → Confirmation dialog:
        "This will delete 5,432 imported items from the library.
         Original files on disk will NOT be affected.
         [Cancel] [Reset]"
    → UI calls resetJobOutputs(jobId)
    → Backend:
        1. Delete from change_records (FK to virtual_media)
        2. Delete from virtual_media (FK to assets)
        3. Delete from group_members (FK to assets)
        4. Delete orphaned duplicate_groups
        5. Delete from metadata_candidates (FK to assets)
        6. Delete from thumb_cache (FK to assets)
        7. Delete thumbnail files from disk
        8. Delete from assets where job_id = jobId
        9. Update job: state = 'pending', clear progress
        10. Emit JobResetEvent, MediaClearedEvent
    → UI removes items from library
    → Job shows as "pending" (can restart)
```

### Database Transaction

The deletion must be **atomic**:
- All deletes in single transaction
- If any fails, rollback all
- Thumbnail file deletion after DB commit (can retry if fails)

### Library Update

After reset:
- Emit `MediaClearedEvent` with affected item IDs
- UI removes items from grid
- If grid becomes empty, show empty state

### Restart After Reset

Once reset, job state is `pending`. User can:
- **Edit config**: Open job settings, modify, restart
- **Restart as-is**: Use same settings
- **Delete job**: Remove job record entirely

---

## Task 2.6: Job Checkpointing

### What We're Building

The **persistence mechanism** that enables resume after app restart.

### Why Checkpointing?

Without checkpoints:
- App crash loses all progress
- Must reprocess from beginning
- Hours of work potentially lost

With checkpoints:
- Resume from last checkpoint
- Skip already-processed files
- Minimal reprocessing

### Checkpoint Strategy

#### When to Checkpoint

Save checkpoint:
- Every N files processed (default: 50)
- At step transitions
- On pause
- Periodically by time (every 30 seconds)

Not too frequent (performance overhead) or too rare (lost work on crash).

#### What to Save

Each checkpoint records:

```
Checkpoint {
  jobId: string
  stepName: string         // Current pipeline step
  lastProcessedId: string  // Last completed item ID
  lastProcessedPath: string // Last completed file path
  processedCount: number   // Total processed in step
  stepState: object        // Step-specific state (JSON)
  savedAt: DateTime
}
```

#### Step-Specific State

Different steps need different state:

| Step | State Needed |
|------|--------------|
| Discover | Last directory path |
| Fingerprint | — (uses lastProcessedPath) |
| Duplicate | czkawka progress (if streaming) |
| Metadata | exiftool batch progress |
| Merge | Last asset ID processed |
| Thumbnail | Last media ID processed |

### Resume Logic

On job resume (or app restart with paused job):

```
function resumeJob(jobId):
    checkpoint = loadCheckpoint(jobId)
    if not checkpoint:
        // No checkpoint, start from beginning
        startFromBeginning(jobId)
        return
    
    // Skip to checkpointed step
    skipToStep(checkpoint.stepName)
    
    // Within step, skip processed items
    for item in getItems():
        if item.id <= checkpoint.lastProcessedId:
            continue  // Skip
        
        process(item)
        updateCheckpoint(item)
```

### Database Table

```sql
CREATE TABLE job_checkpoints (
    job_id TEXT PRIMARY KEY,
    step_name TEXT NOT NULL,
    last_processed_id TEXT,
    last_processed_path TEXT,
    processed_count INTEGER DEFAULT 0,
    step_state TEXT,  -- JSON
    saved_at TEXT NOT NULL,
    
    FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
);
```

### App Restart Handling

When app starts:

```
function handleOrphanedJobs():
    orphaned = query("SELECT * FROM jobs WHERE state = 'running'")
    
    for job in orphaned:
        // Job was running when app crashed
        if hasCheckpoint(job.id):
            // Can resume
            updateState(job.id, 'paused')  // Mark paused, user can resume
            log("Job {job.id} can be resumed from checkpoint")
        else:
            // No checkpoint, mark as failed
            updateState(job.id, 'failed')
            setError(job.id, "App closed unexpectedly during processing")
```

---

## E2E Test: `job_pause_resume_cancel`

### What We're Testing

The complete pause/resume/cancel flow works correctly.

### Test Setup

Use `large-set` fixture with many files so the job runs long enough to interact with.

### Test Steps

```
1. Start import with large-set fixture (100+ files)
2. Wait for job to be running (some progress made)
3. Click pause button
4. Assert:
   - Job state shows "paused"
   - Tasks pill shows paused state
   - Progress stops (no new events)
5. Wait 2 seconds, verify progress unchanged
6. Click resume button
7. Assert:
   - Job state shows "running"
   - Progress events resume
   - New items appear in grid
8. Click cancel button
9. Assert:
   - Confirmation appears (if implemented)
   - Job state shows "cancelled"
   - Progress stops permanently
   - Grid stops growing
```

### Key Assertions

```typescript
// Pause actually stops progress
const progressBefore = await getProgress(jobId);
await pause();
await sleep(2000);
const progressAfter = await getProgress(jobId);
expect(progressAfter).toBe(progressBefore);  // No change

// Resume continues from same point
await resume();
await waitForProgress();  // Some increase
expect(await getProgress(jobId)).toBeGreaterThan(progressBefore);

// Cancel is permanent
await cancel();
const countBefore = await gridItems.count();
await sleep(2000);
const countAfter = await gridItems.count();
expect(countAfter).toBe(countBefore);  // No new items
```

### Why This Test Matters

Proves the **restartability contract works**:
- Pause actually pauses (not just UI illusion)
- Resume continues correctly (no data corruption)
- Cancel stops permanently (job won't restart on its own)

---

## E2E Test: `reset_outputs_clears_library_for_run`

### What We're Testing

Reset outputs properly removes all derived data.

### Test Steps

```
1. Complete an import (wait for idle)
2. Verify items in grid (count > 0)
3. Open tasks panel
4. Find completed job
5. Click "Reset Outputs"
6. Confirm dialog
7. Assert:
   - Grid becomes empty
   - Job state changes to "pending"
   - Can restart job
```

### Key Assertions

```typescript
// Before reset: items exist
expect(await gridItems.count()).toBeGreaterThan(0);

// After reset: empty
await resetOutputs(jobId);
expect(await gridItems.count()).toBe(0);

// Job is restartable
expect(await getJobState(jobId)).toBe('pending');
```

### Database Verification

Use `__memexTest.queryDb()` to verify:

```typescript
// All tables cleared
expect(await queryDb('SELECT COUNT(*) FROM virtual_media WHERE ...'))
  .toEqual([{ count: 0 }]);
expect(await queryDb('SELECT COUNT(*) FROM assets WHERE job_id = ?', [jobId]))
  .toEqual([{ count: 0 }]);
```

### Why This Test Matters

Proves reset is **complete and correct**:
- All derived data removed
- No orphaned records
- Job can be restarted cleanly

---

## Fixture Requirements

### `e2e/fixtures/large-set/`

For pause/resume testing, need enough files that job runs > 5 seconds:

- 100+ media files
- Mix of images and videos
- Various sizes (some large for slower processing)

Structure:
```
large-set/
├── photos/
│   ├── batch1/  (30 files)
│   ├── batch2/  (30 files)
│   ├── batch3/  (30 files)
│   └── batch4/  (20 files)
├── manifest.json
└── expected.json
```

---

## Acceptance Criteria

### Task 2.1: Tasks Popover
- [ ] Pill shows correct aggregate state
- [ ] Popover opens on click
- [ ] Shows top 5 active jobs
- [ ] Progress bars update in real-time
- [ ] Quick actions work (pause/resume/cancel)
- [ ] "View all" navigates to panel

### Task 2.2: Tasks Panel
- [ ] Shows all jobs (not just active)
- [ ] Filters work (all/active/completed/failed)
- [ ] Expanded view shows step details
- [ ] Errors displayed with context
- [ ] All actions available per state

### Task 2.3: Pause/Resume
- [ ] Pause stops processing within 1 second
- [ ] Progress events stop when paused
- [ ] Resume continues from checkpoint
- [ ] No duplicate processing after resume
- [ ] State persists across app restart

### Task 2.4: Cancel
- [ ] Cancel stops job permanently
- [ ] Partial results retained (unless reset)
- [ ] Job can't accidentally restart
- [ ] Confirmation for significant progress

### Task 2.5: Reset Outputs
- [ ] Confirmation required
- [ ] All derived data deleted
- [ ] Original files untouched
- [ ] Thumbnail files deleted
- [ ] Job becomes restartable
- [ ] Library updates immediately

### Task 2.6: Checkpointing
- [ ] Checkpoint saved every 50 items
- [ ] Resume skips processed items
- [ ] Orphaned jobs detected on startup
- [ ] No data corruption on crash

### E2E Tests
- [ ] `job_pause_resume_cancel` passes
- [ ] `reset_outputs_clears_library_for_run` passes
