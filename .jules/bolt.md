## 2024-11-20 - React.memo Shallow Equality on Collections in Lists
**Learning:** React.memo's default shallow equality is ineffective for list items when complex collection props (like `Set`) are dynamically recreated on each parent render (e.g., streaming updates). It creates O(N) unnecessary re-renders despite memoization.
**Action:** Always provide a custom equality function for `React.memo` when a component relies on collection-based props (like `Set` or `Array`) to explicitly check for logical changes relevant only to the specific item.
