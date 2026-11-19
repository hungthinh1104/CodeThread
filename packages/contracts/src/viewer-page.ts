export type ViewerPage = {
  offset: number;
  limit: number;
  total: number;
  nextOffset: number | null;
  items: readonly unknown[];
};

export function viewerPageConsistencyIssues(page: ViewerPage) {
  const end = page.offset + page.items.length,
    expectedItems = Math.min(page.limit, Math.max(0, page.total - page.offset)),
    expectedNext = page.total > end ? end : null,
    issues: { path: 'items' | 'nextOffset'; message: string }[] = [];
  if (page.items.length !== expectedItems)
    issues.push({
      path: 'items',
      message: 'Page item count is inconsistent with total and offset.',
    });
  if (page.nextOffset !== expectedNext)
    issues.push({
      path: 'nextOffset',
      message:
        'Page continuation is inconsistent with total and returned rows.',
    });
  return issues;
}
