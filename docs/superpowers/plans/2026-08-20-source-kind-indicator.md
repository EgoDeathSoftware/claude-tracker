# Source Kind Indicator Dots Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add colored source-kind indicator dots to the project list (far right) and session list (alongside source badge) to show which sources are represented.

**Architecture:** Create a reusable `SourceKindDots` component that renders colored dots (orange for claude-code, blue for opencode). ProjectList computes kinds present in each project by filtering sessions and deduplicating by kind. SessionList uses the component alongside the existing source badge. Both components use the existing `useSources` hook to map sourceId → kind.

**Tech Stack:** React, TypeScript, Tailwind CSS

---

### Task 1: Create SourceKindDots component

**Files:**
- Create: `client/src/components/SourceKindDots.tsx`

- [ ] **Step 1: Write the new component file**

```typescript
import type { SourceKind } from '@/hooks/useSources.ts';

interface Props {
  kinds: SourceKind[];
}

export function SourceKindDots({ kinds }: Props) {
  const uniqueKinds = Array.from(new Set(kinds));

  const kindColors: Record<SourceKind, string> = {
    'claude-code': 'text-orange-500',
    'opencode': 'text-blue-500',
  };

  return (
    <div className="flex gap-1 items-center">
      {uniqueKinds.map(kind => (
        <span key={kind} className={`text-sm ${kindColors[kind]}`}>
          ●
        </span>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Verify component syntax**

Check that the file has no TypeScript errors by opening it in your editor or running type check.

---

### Task 2: Update ProjectList to compute and display kinds

**Files:**
- Modify: `client/src/components/ProjectList.tsx`

- [ ] **Step 1: Import SourceKindDots and useSources**

At the top of the file, add these imports after existing imports:

```typescript
import { SourceKindDots } from '@/components/SourceKindDots.tsx';
import { useSources } from '@/hooks/useSources.ts';
import type { Session } from '@/types.ts';
```

- [ ] **Step 2: Add sessions to Props interface**

Update the `Props` interface to include sessions:

```typescript
interface Props {
  projects: Project[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  allKinds: SourceKind[];
  enabledKinds: SourceKind[];
  onToggleKind: (kind: SourceKind) => void;
  configOpen: boolean;
  onOpenConfig: () => void;
  sessions: Session[];
}
```

- [ ] **Step 3: Add sessions to function parameters**

Update the destructuring in the function signature:

```typescript
export function ProjectList({
  projects, selectedId, onSelect,
  allKinds, enabledKinds, onToggleKind,
  configOpen, onOpenConfig,
  sessions,
}: Props) {
```

- [ ] **Step 4: Get source kinds inside the component**

Add this after the function signature, before the return statement:

```typescript
  const sources = useSources();
  const sourceKindById = new Map(sources.map(s => [s.id, s.kind]));

  const getProjectKinds = (projectId: string): SourceKind[] => {
    const projectSessions = sessions.filter(
      s => s.projectId === projectId,
    );
    const kinds = projectSessions.map(
      s => sourceKindById.get(s.sourceId),
    ).filter((k): k is SourceKind => k !== undefined);
    return Array.from(new Set(kinds));
  };
```

- [ ] **Step 5: Update project button to show dots on far right**

Find the project button section (around line 86-102) and update the sub-text div. Replace:

```typescript
            <div className="text-[11px] text-gray-400 mt-0.5 flex items-center gap-1.5">
              {p.liveCount > 0 && (
                <span className="bg-blue-100 text-blue-700 px-1.5 rounded-full">{p.liveCount} live</span>
              )}
              <span>· {p.sessionCount} sessions</span>
            </div>
```

With:

```typescript
            <div className="text-[11px] text-gray-400 mt-0.5 flex items-center justify-between">
              <div className="flex items-center gap-1.5">
                {p.liveCount > 0 && (
                  <span className="bg-blue-100 text-blue-700 px-1.5 rounded-full">{p.liveCount} live</span>
                )}
                <span>· {p.sessionCount} sessions</span>
              </div>
              <SourceKindDots kinds={getProjectKinds(p.id)} />
            </div>
```

- [ ] **Step 6: Verify the component renders**

Make sure ProjectList compiles and there are no TypeScript errors.

---

### Task 3: Update SessionList to display dots alongside source badge

**Files:**
- Modify: `client/src/components/SessionList.tsx`

- [ ] **Step 1: Import SourceKindDots**

Add this import near the top with the other component imports:

```typescript
import { SourceKindDots } from '@/components/SourceKindDots.tsx';
```

- [ ] **Step 2: Update source badge section in the session list**

Find the section that renders the source badge (around lines 116-129). Replace:

```typescript
                {sources.length > 1 && sourceNameById.has(s.sourceId) && (
                  <span className="px-1.5 py-0.5 rounded text-[9px]
                    font-medium bg-gray-100 text-gray-600 uppercase
                    tracking-wide flex items-center gap-1">
                    <span className={
                      sourceKindById.get(s.sourceId) === 'opencode'
                        ? 'text-emerald-600'
                        : 'text-indigo-600'
                    }>
                      ●
                    </span>
                    {sourceNameById.get(s.sourceId)}
                  </span>
                )}
```

With:

```typescript
                {sources.length > 1 && sourceNameById.has(s.sourceId) && (
                  <div className="flex items-center gap-1.5">
                    <SourceKindDots kinds={sourceKindById.get(s.sourceId) ? [sourceKindById.get(s.sourceId)!] : []} />
                    <span className="px-1.5 py-0.5 rounded text-[9px]
                      font-medium bg-gray-100 text-gray-600 uppercase
                      tracking-wide">
                      {sourceNameById.get(s.sourceId)}
                    </span>
                  </div>
                )}
```

- [ ] **Step 3: Verify the component renders**

Make sure SessionList compiles and the dots appear next to session source names.

---

### Task 4: Update App.tsx to pass sessions to ProjectList

**Files:**
- Modify: `client/src/App.tsx`

- [ ] **Step 1: Find ProjectList usage in App.tsx**

Search for `<ProjectList` in the file to locate where it's rendered.

- [ ] **Step 2: Add sessions prop**

Add `sessions={sessions}` to the ProjectList component props. The full prop list should look something like:

```typescript
<ProjectList
  projects={projects}
  selectedId={selectedProjectId}
  onSelect={setSelectedProjectId}
  allKinds={allKinds}
  enabledKinds={enabledKinds}
  onToggleKind={handleToggleKind}
  configOpen={configOpen}
  onOpenConfig={handleOpenConfig}
  sessions={sessions}
/>
```

(Adjust variable names if different in your App.tsx)

- [ ] **Step 3: Verify App.tsx compiles**

Check that App.tsx has no TypeScript errors.

---

### Task 5: Test the feature end-to-end

**Files:**
- No files modified

- [ ] **Step 1: Start the dev server**

Run: `pnpm dev`

Expected: Both server (:3001) and client (:5173) start without errors.

- [ ] **Step 2: Open the app in browser**

Navigate to `http://localhost:5173` and verify the app loads.

- [ ] **Step 3: Verify project indicators**

Check that each project in the left sidebar shows colored dots on the far right:
- Orange dots for projects with claude-code sessions
- Blue dots for projects with opencode sessions
- Both dots for projects with mixed sources

- [ ] **Step 4: Verify session indicators**

Click on a project to view its sessions. Check that each session shows the colored dot next to the source name badge.

- [ ] **Step 5: Test with single source**

If you have a setup with only one source kind configured, verify dots still appear (they should).

---

### Task 6: Commit the changes

**Files:**
- `client/src/components/SourceKindDots.tsx`
- `client/src/components/ProjectList.tsx`
- `client/src/components/SessionList.tsx`
- `client/src/App.tsx`

- [ ] **Step 1: Stage and commit**

```bash
git add client/src/components/SourceKindDots.tsx \
  client/src/components/ProjectList.tsx \
  client/src/components/SessionList.tsx \
  client/src/App.tsx
git commit -m "feat: add source kind indicator dots to projects and sessions"
```

Expected: Commit succeeds with 4 files changed.
