import { describe, expect, it } from 'vitest';
import { localPostgresConnection } from '../scripts/backend/local-postgres-url.ts';

describe('local PostgreSQL connection URLs', () => {
  it.each(['localhost', '127.0.0.1', '[::1]'])(
    'accepts loopback host %s',
    (host) => {
      const connection = localPostgresConnection(
        `postgres://user:pass@${host}:55432/code-thread?sslmode=disable`,
        'Backup source',
      );
      expect(connection.env).toMatchObject({
        PGHOST: host === '[::1]' ? '::1' : host,
        PGPORT: '55432',
        PGUSER: 'user',
        PGPASSWORD: 'pass',
        PGDATABASE: 'code-thread',
        PGSSLMODE: 'disable',
      });
    },
  );

  it('rejects a remote backup source before it can be queried', () => {
    expect(() =>
      localPostgresConnection(
        'postgres://user:pass@remote.invalid:5432/source',
        'Backup source',
      ),
    ).toThrow('Backup source must use a loopback PostgreSQL host');
  });

  it('removes inherited libpq routing overrides from native tool env', () => {
    const names = ['PGHOSTADDR', 'PGSERVICE', 'PGSERVICEFILE', 'PGSYSCONFDIR'],
      previous = new Map(names.map((name) => [name, process.env[name]]));
    process.env.PGHOSTADDR = '203.0.113.9';
    process.env.PGSERVICE = 'remote-service';
    process.env.PGSERVICEFILE = 'C:\\remote-service.conf';
    process.env.PGSYSCONFDIR = 'C:\\postgresql';
    try {
      const connection = localPostgresConnection(
        'postgres://user:pass@127.0.0.1:5432/source',
        'Backup source',
      );
      expect(
        Object.keys(connection.env)
          .filter((name) => /^PG/i.test(name))
          .sort(),
      ).toEqual([
        'PGDATABASE',
        'PGHOST',
        'PGPASSWORD',
        'PGPORT',
        'PGSSLMODE',
        'PGUSER',
      ]);
    } finally {
      for (const [name, value] of previous) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it('rejects non-PostgreSQL URLs and missing databases', () => {
    expect(() =>
      localPostgresConnection('https://localhost/db', 'Restore target'),
    ).toThrow('Restore target must be a PostgreSQL URL');
    expect(() =>
      localPostgresConnection('postgres://localhost', 'Restore target'),
    ).toThrow('Restore target database name is missing');
  });
});
