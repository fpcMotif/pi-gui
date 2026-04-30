## 2024-04-27 - React.memo on TimelineItem
**Learning:** Found a missing React.memo on the TimelineItem component. This component is part of a large virtualized list in the conversation timeline. Re-rendering large lists is an expensive operation and avoiding unnecessary renders is critical for frontend performance.
**Action:** When adding or optimizing items in large lists, verify that individual item components are memoized.

## 2024-05-18 - React.memo custom equality for Set references
**Learning:** The previous React.memo on TimelineItem was defeating itself because the `expandedToolCallIds` prop is a Set. Toggling any tool call created a new Set reference in the parent state, which caused a shallow equality mismatch. This forced every item in the large virtualized list to re-render, creating an O(N) performance bottleneck when toggling tool calls.
**Action:** When memoizing list components that receive collection references (like Set or Array) from parent state, implement a custom equality function. Compare only the specific item's state within the collection rather than relying on shallow comparison of the collection reference itself.
