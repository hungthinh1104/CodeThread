export function localPostgresConnection(raw: string, label: string) {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${label} must be a valid PostgreSQL URL`);
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol))
    throw new Error(`${label} must be a PostgreSQL URL`);
  const hostname = url.hostname.toLowerCase();
  if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(hostname))
    throw new Error(`${label} must use a loopback PostgreSQL host`);
  const database = decodeURIComponent(url.pathname.slice(1));
  if (!database) throw new Error(`${label} database name is missing`);
  return {
    url: url.toString(),
    env: {
      ...process.env,
      PGHOST: hostname.replace(/^\[|\]$/g, ''),
      PGPORT: url.port || '5432',
      PGUSER: decodeURIComponent(url.username),
      PGPASSWORD: decodeURIComponent(url.password),
      PGDATABASE: database,
      PGSSLMODE: url.searchParams.get('sslmode') ?? 'disable',
    },
  };
}
