## 2024-11-20 - React.memo Shallow Equality on Collections in Lists
**Learning:** React.memo's default shallow equality is ineffective for list items when complex collection props (like `Set`) are dynamically recreated on each parent render (e.g., streaming updates). It creates O(N) unnecessary re-renders despite memoization.
**Action:** Always provide a custom equality function for `React.memo` when a component relies on collection-based props (like `Set` or `Array`) to explicitly check for logical changes relevant only to the specific item.
## 2024-11-20 - React.memo Equality on Discriminated Unions
**Learning:** When writing custom equality functions (`arePropsEqual`) for `React.memo` involving discriminated union types, TypeScript requires explicit narrowing of both `prevProps` and `nextProps`. Narrowing only `prevProps.item.kind` is insufficient and will cause property access errors (e.g., `callId does not exist on TranscriptMessage`) when accessing `nextProps.item`.
**Action:** Always narrow both sides of the comparison (e.g., `prevProps.item.kind === 'tool' && nextProps.item.kind === 'tool'`) before accessing properties specific to that union branch.
