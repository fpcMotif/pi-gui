## 2024-04-27 - React.memo on TimelineItem
**Learning:** Found a missing React.memo on the TimelineItem component. This component is part of a large virtualized list in the conversation timeline. Re-rendering large lists is an expensive operation and avoiding unnecessary renders is critical for frontend performance.
**Action:** When adding or optimizing items in large lists, verify that individual item components are memoized.
