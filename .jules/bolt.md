## 2024-04-27 - React.memo on TimelineItem
**Learning:** Found a missing React.memo on the TimelineItem component. This component is part of a large virtualized list in the conversation timeline. Re-rendering large lists is an expensive operation and avoiding unnecessary renders is critical for frontend performance.
**Action:** When adding or optimizing items in large lists, verify that individual item components are memoized.

## 2025-04-29 - Fixed broken React.memo in TimelineItem
**Learning:** Passing a new `Set` reference (like `expandedToolCallIds`) to a `React.memo` component breaks the memoization because shallow equality fails. In lists, this causes every list item to re-render when the Set changes.
**Action:** Use a custom equality function in `React.memo` to check only the specific values the component actually depends on (e.g., `prevSet.has(id) === nextSet.has(id)`).
