import { createContext, useContext, useRef, useSyncExternalStore } from 'react';

// Holds stable commands plus the canvas store; its value never changes, so it never re-renders a node by itself.
export const CanvasContext = createContext(null);
export const useCanvas = () => useContext(CanvasContext);

// Re-renders only when the selected slice changes (compared with `equal`).
export function useCanvasValue(selector, equal = Object.is) {
  const { store } = useContext(CanvasContext), memo = useRef(null);
  const snapshot = () => {
    const state = store.get(), last = memo.current;
    if (last && last.state === state && last.selector === selector) return last.value;
    const value = selector(state), kept = last && equal(last.value, value) ? last.value : value;
    memo.current = { state, selector, value: kept };
    return kept;
  };
  return useSyncExternalStore(store.subscribe, snapshot, snapshot);
}

// The zoom bucket chooses full or light cards. A node that is being focused, highlighted or renamed, or that holds
// the text cursor, keeps its controls so that focus, onboarding hints and edits work at any zoom.
export function useDetail(id) {
  const detail = useCanvasValue(state => state.focusId === id || state.renamingGroup === id || state.highlight?.startsWith(`${id}:`) ? 'full' : state.detail), element = document.activeElement;
  return detail !== 'full' && element?.matches?.('textarea,input') && element.closest('.react-flow__node')?.getAttribute('data-id') === id ? 'full' : detail;
}
