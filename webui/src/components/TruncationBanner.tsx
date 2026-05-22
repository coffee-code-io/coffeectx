/**
 * Thin banner shown above list/graph results when the server returned fewer
 * matches than the total found (response.count < response.total) or when the
 * server forced depth=0 because no query was provided.
 *
 * Both conditions hint at the same underlying user action: narrow the filter.
 */

export interface TruncationBannerProps {
  total: number;
  count: number;
  limit: number;
  depthForced?: boolean;
}

export function TruncationBanner({ total, count, limit, depthForced }: TruncationBannerProps) {
  const clipped = count < total;
  if (!clipped && !depthForced) return null;

  return (
    <div className="px-4 py-2 bg-roast-medium/15 border-b border-roast-medium/30 text-sm text-roast-dark flex items-center gap-2">
      <span className="inline-block w-1.5 h-1.5 rounded-full bg-status-warning shrink-0" />
      <span className="flex-1 min-w-0 truncate">
        {clipped && (
          <>
            Showing first <span className="font-medium">{count}</span> of{' '}
            <span className="font-medium">{total.toLocaleString()}</span> matches
            {limit ? ` (cap ${limit})` : ''} — narrow the filter to see more.
          </>
        )}
        {!clipped && depthForced && (
          <>
            Depth expansion disabled — provide a query to expand from a smaller seed set.
          </>
        )}
        {clipped && depthForced && (
          <>
            {' '}Depth expansion also disabled — provide a query to enable it.
          </>
        )}
      </span>
    </div>
  );
}
