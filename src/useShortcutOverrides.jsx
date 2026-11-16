import { useSyncExternalStore } from 'react';
import { getShortcutOverrides, subscribeShortcutOverrides } from './shortcut-preferences.mjs';

// Re-renders a component when the person changes a shortcut, here or in another tab.
export const useShortcutOverrides = () => useSyncExternalStore(subscribeShortcutOverrides, getShortcutOverrides, getShortcutOverrides);
