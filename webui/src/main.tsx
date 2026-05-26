import React from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient } from '@tanstack/react-query';
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import { createSyncStoragePersister } from '@tanstack/query-sync-storage-persister';
import { App } from './App';
import './index.css';

const queryClient = new QueryClient({
  defaultOptions: {
    // staleTime: data is reused without refetch for 60s. Most server state in
    // this app (refs, types, node detail) changes only when an indexer job
    // runs — drilling into a node and backing out should feel instant.
    queries: {
      staleTime: 60_000,
      refetchOnWindowFocus: false,
      // gcTime must outlive the persister window or the cache evicts
      // entries before they can be restored on next page load.
      gcTime: 24 * 60 * 60_000, // 24h
    },
  },
});

const persister = createSyncStoragePersister({
  storage: window.localStorage,
  key: 'coffeectx.queryCache.v1',
  // Compact JSON — no need for pretty-printing.
});

const root = document.getElementById('root');
if (!root) throw new Error('#root not found');
createRoot(root).render(
  <React.StrictMode>
    <PersistQueryClientProvider
      client={queryClient}
      persistOptions={{
        persister,
        // Bump on shape-breaking changes so old caches are dropped, not
        // restored against a newer API client.
        buster: 'v1',
        maxAge: 24 * 60 * 60_000,
        // Don't persist the live agent stream / sessions list — those need
        // to be fresh on reload (the SSE connection is the source of truth
        // for the active session and the list reflects what's on disk).
        dehydrateOptions: {
          shouldDehydrateQuery: ({ queryKey }) => {
            const k = String(queryKey[0] ?? '');
            // `debug` is a one-shot bootstrap fetch — re-fetch on each
            // load so flipping the server-side flag takes effect on the
            // next page open without manually clearing storage.
            return k !== 'agent-sessions' && k !== 'cite' && k !== 'debug';
          },
        },
      }}
    >
      <App />
    </PersistQueryClientProvider>
  </React.StrictMode>,
);
