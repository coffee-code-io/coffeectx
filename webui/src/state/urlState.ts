/**
 * URL ↔ zustand store bridge.
 *
 * Why: the SPA previously kept all navigation state in zustand only, so
 * the browser's back/forward arrows navigated off the app entirely.
 * Mirroring a small "navigation slice" (`tab`, `selectedNodeId`,
 * `filter.{mode,q,types}`) into `location.search` and pushing a history
 * entry on each change makes back/forward step through views.
 *
 * Skipped on purpose:
 *   - `project` — the project selector already persists in localStorage
 *     and rarely changes; not really a navigation step.
 *   - `viewMode`, `filter.includeHidden`, `filter.depth` — view-preference
 *     toggles, not navigation. Putting them in history would clutter the
 *     back stack.
 *
 * `pushUrlState` short-circuits when the encoded value equals the
 * current `location.search`, so React-driven state echoes during a
 * normal render don't churn history.
 */

import type { FilterMode } from '../api/client';
import type { useUi } from './store';

type Store = typeof useUi;
type UiState = ReturnType<Store['getState']>;

/** Serialise the navigation slice into URLSearchParams. Defaults are
 *  omitted so URLs stay short for the common case (just `?node=…`). */
export function encodeUrlState(state: UiState): URLSearchParams {
  const sp = new URLSearchParams();
  if (state.tab !== 'graph') sp.set('tab', state.tab);
  if (state.selectedNodeId) sp.set('node', state.selectedNodeId);
  if (state.filter.mode !== 'query') sp.set('mode', state.filter.mode);
  if (state.filter.q) sp.set('q', state.filter.q);
  if (state.filter.types.length > 0) sp.set('types', state.filter.types.join(','));
  return sp;
}

/** Decode a `URLSearchParams` into the partial zustand state slice the
 *  popstate / hydrate bridges hand to `setState`. Tolerant of missing
 *  keys — anything absent stays at its current value. */
export function decodeUrlState(sp: URLSearchParams): Partial<UiState> {
  const out: Partial<UiState> = {};
  const tab = sp.get('tab');
  if (tab === 'graph' || tab === 'runs' || tab === 'scheduler' || tab === 'skills') {
    out.tab = tab;
  } else if (tab === null) {
    out.tab = 'graph';
  }
  out.selectedNodeId = sp.get('node');
  const filter: Partial<UiState['filter']> = {};
  const mode = sp.get('mode');
  if (mode === 'query' || mode === 'search' || mode === 'regex' || mode === 'exact') {
    filter.mode = mode as FilterMode;
  } else if (mode === null) {
    filter.mode = 'query';
  }
  filter.q = sp.get('q') ?? '';
  const types = sp.get('types');
  filter.types = types ? types.split(',').filter(t => t.length > 0) : [];
  out.filter = { ...defaultFilterTail(), ...filter };
  return out;
}

/** The non-URL filter fields keep their defaults when hydrating from
 *  URL — they're not in the URL so we can't reconstruct them, and we
 *  don't want to leak them either. */
function defaultFilterTail(): UiState['filter'] {
  return { mode: 'query', q: '', types: [], depth: 0, includeHidden: false };
}

/**
 * Push the current state into `history` iff the encoded URL changed.
 * The equality check guards against React-driven state echoes — every
 * `setState(stateAlreadyEqualToCurrent)` would otherwise add a noop
 * history entry.
 */
export function pushUrlState(state: UiState): void {
  const sp = encodeUrlState(state);
  const next = sp.toString();
  const current = window.location.search.replace(/^\?/, '');
  if (next === current) return;
  const url = next ? `${window.location.pathname}?${next}` : window.location.pathname;
  window.history.pushState({}, '', url);
}

/**
 * Listen for browser back/forward and apply the URL's encoded state
 * back into zustand. Idempotent — same `decodeUrlState` shape is what
 * `pushUrlState` mirrored on the way out, so the echo is cheap.
 */
export function installPopStateBridge(store: Store): void {
  window.addEventListener('popstate', () => {
    const decoded = decodeUrlState(new URLSearchParams(window.location.search));
    // Merge the decoded slice on top of current state so we don't clobber
    // non-navigation fields (project, viewMode, etc.).
    const current = store.getState();
    store.setState({
      ...current,
      ...decoded,
      filter: { ...current.filter, ...(decoded.filter ?? {}) },
    });
  });
}

/**
 * Replace (not push) the current URL with whatever zustand has now.
 * Used on app mount AFTER hydrating from the URL — keeps the URL and
 * store consistent without growing the history stack.
 */
export function replaceUrlState(state: UiState): void {
  const sp = encodeUrlState(state);
  const url = sp.toString()
    ? `${window.location.pathname}?${sp}`
    : window.location.pathname;
  window.history.replaceState({}, '', url);
}
