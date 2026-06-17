# Architecture A3 — UI GPU Rendering

## Strategic Goal

Determine the optimal rendering strategy for Memex's photo grid and map views to maintain **60fps scrolling with 100,000+ items**. This document analyzes Chromium's built-in hardware acceleration versus explicit GPU APIs (WebGL/WebGPU), providing a decision framework and implementation guidance.

**Success looks like:** A user can scroll through their entire 1M photo library at 60fps, smoothly zoom into map clusters, and interact with the grid without frame drops—regardless of library size.

---

## Executive Summary

**Built-in Chromium hardware acceleration is sufficient for Memex's typical usage patterns.** The key insight is that virtualization means only visible items affect rendering performance—the total dataset size is handled by the data layer, not the rendering layer.

| Visible Elements | Recommended Approach |
|-----------------|---------------------|
| < 500 | DOM virtualization (current approach) |
| 500 - 5,000 | DOM with heavy optimization |
| 5,000+ simultaneous | WebGL (PixiJS) |

Since Memex's grid shows ~50-200 items at a time (typical thumbnail sizes), **optimized DOM virtualization is the correct default**. WebGL should only be considered if:
- Users need map-style zoomable grid with 5,000+ visible thumbnails
- Profiling shows frame drops despite DOM optimization
- MapLibre integration creates WebGL context sharing opportunities

---

## Must-Comply Constraints (Gate for Future Milestones)

The following milestones MUST embed these A3 constraints in their specs and implementations. These are gating requirements.

| Milestone | Must-Comply Constraints |
|----------|-------------------------|
| M25 Advanced Grid Navigation | Containment boundaries, no per-item layer promotion, pre-computed positions, lazy decode with placeholders. |
| M32 UI Modernization | UI patterns must remain performant; avoid heavy per-item effects; preserve stable `data-testid` hooks. |
| M21 Enhanced Import Job Views | Virtualized long lists; GPU-friendly progress animations (transform-only). |
| M30 Export Media | Virtualized lists for large exports; transform-only progress animations. |
| M18 GPS Routes / Map Overlays | Map hover throttling; avoid per-move layout or queries. |

**Spike gate:** WebGL/PixiJS is only allowed as an explicit spike with a11y parity requirements and opt-in gating.

---

## Chromium's Built-in Hardware Acceleration

### What's Automatically GPU-Accelerated

Electron inherits Chromium's compositor-based GPU acceleration. The following operations run on the GPU compositor thread, independent of JavaScript:

| Operation | GPU Accelerated | Notes |
|-----------|-----------------|-------|
| CSS `transform` (translate, scale, rotate) | ✅ Yes | During animations |
| CSS `opacity` animations | ✅ Yes | Compositor-only |
| CSS `filter` (blur, contrast, etc.) | ✅ Yes | Since Chrome 89 |
| Scroll containers | ✅ Yes | Visual updates first |
| Image rasterization | ✅ Conditional | With `--enable-gpu-rasterization` |
| WebGL/WebGPU | ✅ Yes | Always |

**What stays on CPU:**
- Layout/reflow calculations
- Style recalculation
- DOM manipulation
- `background-attachment: fixed` (forces CPU repaint every frame)

### How to Verify GPU Acceleration

**In Electron:**

```javascript
// main.js - Check GPU status
const { app } = require('electron');

app.whenReady().then(() => {
    const status = app.getGPUFeatureStatus();
    console.log('GPU Compositing:', status.gpu_compositing);
    console.log('Rasterization:', status.rasterization);
    console.log('WebGL:', status.webgl);
    console.log('WebGL2:', status.webgl2);
});
```

**In DevTools:**
1. Navigate to `chrome://gpu` in an Electron window
2. Check "Graphics Feature Status" section
3. Use DevTools Layers panel: `Ctrl+Shift+P` → "Show Layers"

### Optimal Electron Configuration

```javascript
// main.js - Set flags BEFORE app ready
const { app } = require('electron');

// Enable GPU rasterization (off by default)
app.commandLine.appendSwitch('enable-gpu-rasterization');

// Enable zero-copy for better memory efficiency
app.commandLine.appendSwitch('enable-zero-copy');

// Enable out-of-process canvas rasterization
app.commandLine.appendSwitch('enable-features', 'CanvasOopRasterization');

// CAUTION: Only if you've tested thoroughly
// app.commandLine.appendSwitch('ignore-gpu-blocklist');

// For debugging GPU issues
// app.commandLine.appendSwitch('enable-logging');
// app.commandLine.appendSwitch('v', '1');
```

**Gating requirement:** GPU diagnostic flags MUST be opt-in (behind settings), show clear warnings, and require restart. Defaults stay conservative to avoid broken GPU drivers.

---

## The Layer Explosion Problem

### How Compositing Layers Work

Chromium creates **GraphicsLayers** that receive dedicated GPU textures. Each layer consumes:

```
Memory per layer = width × height × 4 bytes (RGBA)
At 2× DPI: 800×600 image = 800 × 2 × 600 × 2 × 4 = ~7.6MB
```

### The Anti-Pattern: Per-Item Layer Promotion

**Wrong approach (causes layer explosion):**

```css
/* DON'T DO THIS */
.photo-item {
    will-change: transform;  /* Creates a new layer per item */
    transform: translateZ(0); /* Same effect, forces layer */
}
```

With 200 visible items: 200 × 7.6MB = **1.5GB GPU memory**

This exceeds GPU memory limits, triggering software fallback and destroying performance.

### The Correct Pattern: Container-Level Layers

**Right approach:**

```css
/* Promote only the scroll container */
.photo-grid-container {
    will-change: transform;
    contain: strict;
    overflow-y: auto;
}

/* Items use containment for repaint isolation, NOT layer promotion */
.photo-item {
    position: absolute;
    contain: layout paint;  /* Isolates repaints without new layer */
    transform: translate3d(var(--x), var(--y), 0);
    /* NO will-change here */
}
```

**Result:** 1 layer for the container, items repaint efficiently within it.

### CSS Containment Hierarchy

```css
/* Root container: full containment */
.library-view {
    contain: strict;  /* size + layout + paint + style */
}

/* Scroll container: transform layer */
.photo-grid-container {
    contain: strict;
    will-change: transform;
    overflow-y: auto;
}

/* Individual items: paint isolation only */
.photo-item {
    contain: layout paint;
    content-visibility: auto;  /* Skips rendering off-screen items */
}

/* Thumbnail images: size containment */
.photo-thumbnail {
    contain: size;
    aspect-ratio: 1;
}
```

---

## Performance Thresholds

### When DOM Virtualization Suffices

| Visible Elements | Performance | Notes |
|-----------------|-------------|-------|
| < 200 | 60fps stable | No optimization needed |
| 200 - 500 | 60fps | With containment + virtualization |
| 500 - 1,000 | 50-60fps | Needs careful optimization |
| 1,000 - 5,000 | 30-60fps | Heavy optimization required |
| 5,000+ | < 30fps | Consider WebGL |

**For Memex's typical grid (50-200 visible items):** DOM virtualization is appropriate.

### Real-World Comparisons

| Application | Items | Approach | Notes |
|-------------|-------|----------|-------|
| Google Photos | Millions | DOM virtualization | Segments into 200-300 batches |
| Figma | Thousands of objects | WebGL (custom) | Needs vector precision |
| VS Code | 10,000+ lines | DOM virtualization | Line-based virtualization |
| MapLibre | 100,000+ features | WebGL | Required for map rendering |

---

## Recommended Implementation: Optimized DOM Virtualization

### Library Choice: TanStack Virtual

**Why TanStack Virtual (formerly react-virtual):**
- Headless (no DOM opinions)
- ~3KB gzipped
- Excellent React integration
- Handles variable-size items
- Native scroll restoration

```typescript
import { useVirtualizer } from '@tanstack/react-virtual';

function PhotoGrid({ items }: { items: VirtualMedia[] }) {
    const parentRef = useRef<HTMLDivElement>(null);
    const columnCount = useResponsiveColumnCount();
    const rowCount = Math.ceil(items.length / columnCount);
    
    const rowVirtualizer = useVirtualizer({
        count: rowCount,
        getScrollElement: () => parentRef.current,
        estimateSize: () => THUMBNAIL_SIZE + GAP,
        overscan: 3,  // Render 3 extra rows above/below viewport
    });
    
    return (
        <div 
            ref={parentRef} 
            className="photo-grid-container"
            style={{ height: '100%', overflow: 'auto' }}
        >
            <div style={{ height: rowVirtualizer.getTotalSize() }}>
                {rowVirtualizer.getVirtualItems().map((virtualRow) => (
                    <PhotoRow
                        key={virtualRow.key}
                        rowIndex={virtualRow.index}
                        items={items.slice(
                            virtualRow.index * columnCount,
                            (virtualRow.index + 1) * columnCount
                        )}
                        style={{
                            position: 'absolute',
                            top: 0,
                            left: 0,
                            transform: `translateY(${virtualRow.start}px)`,
                        }}
                    />
                ))}
            </div>
        </div>
    );
}
```

### Critical Optimizations

**1. Pre-calculate positions on load, not during scroll:**

```typescript
// Calculate all positions once when items change
const positions = useMemo(() => {
    return items.map((_, index) => ({
        row: Math.floor(index / columnCount),
        col: index % columnCount,
        x: (index % columnCount) * (THUMBNAIL_SIZE + GAP),
        y: Math.floor(index / columnCount) * (THUMBNAIL_SIZE + GAP),
    }));
}, [items, columnCount]);
```

**2. Use `requestAnimationFrame` for scroll-triggered updates:**

```typescript
const handleScroll = useCallback(() => {
    // Never do work directly in scroll handler
    if (rafId.current) return;
    
    rafId.current = requestAnimationFrame(() => {
        rafId.current = null;
        // Update visible range, trigger virtualization
        updateVisibleRange();
    });
}, []);
```

**3. Debounce resize handlers:**

```typescript
const debouncedResize = useMemo(
    () => debounce(() => {
        setColumnCount(calculateColumnCount());
    }, 100),
    []
);
```

**4. Image loading optimization:**

```typescript
function PhotoThumbnail({ item, isVisible }: Props) {
    // Only load image when item is visible (or about to be)
    const [loaded, setLoaded] = useState(false);
    
    return (
        <div 
            className="photo-thumbnail"
            style={{ backgroundColor: item.dominantColor }}
        >
            {isVisible && (
                <img
                    src={`memex://thumb/${item.id}`}
                    loading="lazy"
                    decoding="async"
                    onLoad={() => setLoaded(true)}
                    style={{ opacity: loaded ? 1 : 0 }}
                />
            )}
        </div>
    );
}
```

---

## Map Hover Throttling (Required)

Map hover interactions must be throttled to avoid per-mousemove work on large datasets.

**Requirements:**
- Throttle hover updates to 16-50ms (requestAnimationFrame or timer)
- Disable hover updates while panning/zooming
- Never run DB queries directly from hover events; precompute or debounce

```typescript
let hoverRaf: number | null = null;

function onMapHover(evt: MapHoverEvent) {
    if (isPanningOrZooming) return;
    if (hoverRaf) return;
    hoverRaf = requestAnimationFrame(() => {
        hoverRaf = null;
        updateHoverTooltip(evt.featureId);
    });
}
```

---

## When to Consider WebGL

### Decision Criteria

Escalate to WebGL when you observe:

| Symptom | Threshold | Action |
|---------|-----------|--------|
| Frame drops during scroll | < 30fps with >500 visible | Profile, then consider WebGL |
| Map-style pan/zoom needed | Any zoom level | WebGL required |
| Complex visual effects | Filters, blending | WebGL advantageous |
| MapLibre already in use | N/A | Consider shared context |

**Gate:** Treat WebGL/PixiJS as a time-boxed spike with explicit a11y parity requirements. Do not ship as default without a formal performance/a11y review.

### WebGL Library: PixiJS

**Why PixiJS:**
- Automatic batching (up to 16 textures per draw call)
- Built-in culling (`cullable = true`)
- React integration via `@pixi/react`
- WebGPU-ready with automatic fallback
- Mature ecosystem, good documentation

**Performance characteristics:**

| Feature | DOM | PixiJS WebGL |
|---------|-----|--------------|
| 1,000 images | 60fps | 60fps |
| 10,000 images | 15-30fps | 60fps |
| 100,000 images | Unusable | 60fps |
| Memory per image | ~7.6MB (layer) | ~256KB (texture) |

### PixiJS Integration Example

```typescript
import { Application, extend } from '@pixi/react';
import { Container, Sprite, Texture } from 'pixi.js';

extend({ Container, Sprite });

function WebGLPhotoGrid({ items, viewportWidth, viewportHeight }) {
    const [textures, setTextures] = useState<Map<string, Texture>>(new Map());
    
    // Texture management with LRU eviction
    useEffect(() => {
        const textureCache = new LRUCache<string, Texture>({
            max: 500,  // Max 500 textures in GPU memory
            dispose: (texture) => texture.destroy(),
        });
        
        // Load visible textures
        const visibleIds = getVisibleItemIds(items, scrollPosition, viewportHeight);
        for (const id of visibleIds) {
            if (!textureCache.has(id)) {
                loadTexture(id).then(tex => textureCache.set(id, tex));
            }
        }
        
        setTextures(textureCache);
    }, [items, scrollPosition]);
    
    return (
        <Application width={viewportWidth} height={viewportHeight}>
            <pixiContainer>
                {visibleItems.map(item => (
                    <pixiSprite
                        key={item.id}
                        texture={textures.get(item.id) ?? Texture.WHITE}
                        x={item.position.x}
                        y={item.position.y - scrollPosition}
                        width={THUMBNAIL_SIZE}
                        height={THUMBNAIL_SIZE}
                        tint={textures.has(item.id) ? 0xFFFFFF : hexToInt(item.dominantColor)}
                    />
                ))}
            </pixiContainer>
        </Application>
    );
}
```

### MapLibre Context Sharing

Since MapLibre already uses WebGL, sharing the rendering context offers advantages:

```typescript
// Architecture with shared WebGL
┌─────────────────────────────────────────┐
│ React Application                        │
├─────────────────────────────────────────┤
│  DOM Layer (overlays, tooltips, UI)     │
│  A11y Layer (hidden buttons for focus)  │
├─────────────────────────────────────────┤
│  WebGL Canvas                           │
│   ├─ MapLibre (map rendering)           │
│   └─ PixiJS (photo grid overlay)        │
└─────────────────────────────────────────┘
```

**Benefits:**
- Avoids WebGL context limits (browsers restrict to 8-16 contexts)
- Shared texture resources possible
- Unified frame timing

---

## WebGPU Status (Deferred)

**Current status in Electron (as of 2025):**
- Requires `--enable-unsafe-webgpu` flag
- Works on Windows and macOS
- **Linux support fails** to discover GPU adapters
- Not suitable for broad distribution

**Recommendation:** Use PixiJS v8 which supports WebGPU with automatic WebGL fallback. When WebGPU stabilizes (expected 2026), applications gain compute shader capabilities without code changes.

---

## Accessibility Considerations

### DOM Virtualization: Accessible by Default

Screen readers understand DOM structure. Virtualized lists maintain accessibility:

```typescript
<div 
    role="grid"
    aria-label="Photo library"
    aria-rowcount={totalRows}
>
    {virtualRows.map(row => (
        <div 
            role="row" 
            aria-rowindex={row.index + 1}
            key={row.key}
        >
            {/* cells */}
        </div>
    ))}
</div>
```

### WebGL: Requires Parallel A11y Layer

WebGL canvas is a "black box" to assistive technologies. Mitigation requires maintaining a parallel hidden DOM:

```typescript
// Hidden accessibility layer
<div className="sr-only" role="grid" aria-label="Photo library">
    {items.map((item, index) => (
        <button
            key={item.id}
            role="gridcell"
            aria-label={`Photo ${item.displayName}, ${item.capturedAt}`}
            style={{
                position: 'absolute',
                left: positions[index].x,
                top: positions[index].y,
                width: THUMBNAIL_SIZE,
                height: THUMBNAIL_SIZE,
                opacity: 0,
            }}
            onFocus={() => scrollToItem(index)}
            onClick={() => selectItem(item.id)}
        />
    ))}
</div>

// Visual WebGL layer (positioned identically)
<PixiApplication>
    {/* Sprites at same positions */}
</PixiApplication>
```

**This doubles the implementation complexity** — a significant cost of WebGL rendering.

---

## Migration Complexity Assessment

| Migration Path | Effort | What Must Be Reimplemented |
|---------------|--------|---------------------------|
| DOM → Optimized DOM | 1-2 weeks | CSS containment, virtualization tuning |
| DOM → Canvas 2D | 2-4 weeks | Layout engine, hit testing, text, a11y layer |
| DOM → WebGL | 4-8 weeks | All above + shaders, texture pipeline, state management |

**Recommendation:** Exhaust DOM optimizations before considering WebGL. The complexity cost is significant.

---

## Implementation Roadmap

### Phase 1: Optimize Current DOM Virtualization (1-2 weeks)

| Task | Priority | Effort |
|------|----------|--------|
| Audit CSS containment | High | 2 days |
| Verify GPU acceleration active | High | 1 day |
| Implement position pre-calculation | High | 2 days |
| Add `requestAnimationFrame` scroll handling | High | 1 day |
| Profile with DevTools Performance panel | High | 2 days |
| Fix any identified bottlenecks | Medium | 3 days |

### Phase 2: Measure and Decide (1 week)

| Metric | Target | If Not Met |
|--------|--------|------------|
| Scroll FPS | ≥ 55fps | Investigate, don't escalate yet |
| Frame budget | < 16ms | Profile for specific bottleneck |
| GPU memory | < 500MB | Check for layer explosion |
| First contentful paint | < 1s | Check image loading strategy |

### Phase 3: WebGL (Only If Phase 2 Fails) (4-8 weeks)

| Task | Priority | Effort |
|------|----------|--------|
| PixiJS proof of concept | High | 1 week |
| Texture management system | High | 1 week |
| Scroll virtualization in WebGL | High | 1 week |
| React integration layer | Medium | 1 week |
| Accessibility layer | High | 2 weeks |
| MapLibre integration | Medium | 1 week |
| Performance tuning | Medium | 1 week |

---

## Performance Monitoring

### DevTools Profiling

```
1. Open DevTools → Performance tab
2. Enable "Screenshots" and "Web Vitals"
3. Start recording
4. Scroll through grid for 5 seconds
5. Stop recording
6. Analyze:
   - Frame rate (should be ~60fps)
   - Long tasks (should be < 50ms)
   - Layout shifts (should be minimal)
   - Compositor frame drops (should be 0)
```

### Runtime Metrics Collection

```typescript
// Collect frame timing during scroll
const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
        if (entry.name === 'frame') {
            const duration = entry.duration;
            if (duration > 16.67) {
                console.warn(`Frame drop: ${duration.toFixed(1)}ms`);
            }
        }
    }
});
observer.observe({ entryTypes: ['frame'] });

// Report to telemetry (opt-in)
function reportScrollPerformance(avgFps: number, droppedFrames: number) {
    if (settings.telemetryEnabled) {
        analytics.track('scroll_performance', { avgFps, droppedFrames });
    }
}
```

---

## Conclusion

**For Memex's photo grid with 100,000+ items but ~50-200 visible at a time, optimized DOM virtualization is the correct approach.** The key optimizations are:

1. **CSS containment** — `contain: strict` on container, `contain: layout paint` on items
2. **Single compositor layer** — Only promote the scroll container, not individual items
3. **Position pre-calculation** — Compute all positions on load, not during scroll
4. **Efficient virtualization** — Use TanStack Virtual with proper overscan
5. **Image loading strategy** — Placeholder colors, lazy loading, async decoding

WebGL (via PixiJS) should be reserved for scenarios where:
- More than 5,000 items must be visible simultaneously
- Map-style pan/zoom interaction is required
- Profiling proves DOM optimization insufficient

The migration cost to WebGL is substantial (4-8 weeks + ongoing a11y maintenance), so it should only be undertaken with clear evidence that DOM virtualization cannot meet performance targets.
