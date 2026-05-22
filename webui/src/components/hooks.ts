import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { useUi } from '../state/store';

const NODE_LIMIT = 80;

/** Run the current filter against /api/p/:p/nodes; shared by Graph and List views. */
export function useFilteredNodes() {
  const project = useUi(s => s.project);
  const filter = useUi(s => s.filter);

  const hasQuery = filter.q.length > 0;
  const hasTypes = filter.types.length > 0;
  const enabled = !!project && (hasQuery || hasTypes);

  const query = useQuery({
    queryKey: ['nodes', project, filter],
    queryFn: () =>
      project
        ? api.searchNodes(project, {
            mode: filter.mode,
            q: hasQuery ? filter.q : undefined,
            types: filter.types,
            depth: filter.depth,
            includeHidden: filter.includeHidden,
            limit: NODE_LIMIT,
          })
        : Promise.resolve(null),
    enabled,
  });

  const matches = query.data?.results ?? [];
  const total = query.data?.total ?? matches.length;
  const count = query.data?.count ?? matches.length;
  const depthForced = query.data?.depthForced ?? false;
  return { matches, total, count, depthForced, limit: NODE_LIMIT, query, enabled };
}
