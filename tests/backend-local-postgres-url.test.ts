import { describe, expect, it } from 'vitest';
import { serviceConfig } from '../scripts/backend/config.ts';
import { localPostgresConnection } from '../scripts/backend/local-postgres-url.ts';
import { containerEnvironment } from '../scripts/backend/postgres-tools.ts';
import {
  assertRoleGrants,
  type RoleGrantAudit,
} from '../scripts/backend/restore-verify.ts';

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

  it('falls back to postgres user in Docker mode when URL omits username', () => {
    const connection = localPostgresConnection(
      'postgres://127.0.0.1:5432/codethread',
      'Backup source',
    );
    expect(connection.env.PGUSER).toBe('');
    expect(containerEnvironment(connection.env)).toContain('PGUSER=postgres');
  });

  it('validates CODETHREAD_API_PORT and post-restore role grant invariants', () => {
    const prev = {
      CODETHREAD_DATABASE_URL: process.env.CODETHREAD_DATABASE_URL,
      CODETHREAD_API_TOKEN: process.env.CODETHREAD_API_TOKEN,
      CODETHREAD_ALLOWED_REPO_ROOT: process.env.CODETHREAD_ALLOWED_REPO_ROOT,
      CODETHREAD_API_PORT: process.env.CODETHREAD_API_PORT,
    };
    process.env.CODETHREAD_DATABASE_URL = 'postgres://127.0.0.1:5432/db';
    process.env.CODETHREAD_API_TOKEN = 'a'.repeat(32);
    process.env.CODETHREAD_ALLOWED_REPO_ROOT = process.cwd();
    try {
      delete process.env.CODETHREAD_API_PORT;
      expect(serviceConfig().port).toBe(8765);
      process.env.CODETHREAD_API_PORT = '9876';
      expect(serviceConfig().port).toBe(9876);
      process.env.CODETHREAD_API_PORT = '99999';
      expect(() => serviceConfig()).toThrow('outside the valid range');
    } finally {
      for (const [key, value] of Object.entries(prev)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }

    const safeGrants: RoleGrantAudit = {
      runtime_can_read: true,
      runtime_can_delete: false,
      runtime_can_create: false,
      runtime_can_prune: false,
      retention_can_prune: true,
      public_can_use_schema: false,
      public_can_create_schema: false,
      public_can_prune: false,
      runtime_can_write_migrations: false,
    };
    expect(() => assertRoleGrants(safeGrants)).not.toThrow();
    expect(() =>
      assertRoleGrants({ ...safeGrants, public_can_prune: true }),
    ).toThrow('unsafe');
    expect(() =>
      assertRoleGrants({ ...safeGrants, runtime_can_write_migrations: true }),
    ).toThrow('unsafe');
    expect(() =>
      assertRoleGrants({ ...safeGrants, public_can_use_schema: true }),
    ).toThrow('unsafe');
  });
});
