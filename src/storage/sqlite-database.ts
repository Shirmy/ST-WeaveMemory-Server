import sqlite3 from 'sqlite3';

export type DatabaseHealth = {
  available: boolean;
  journalMode: string;
  databasePath: string;
};

type SqliteRunResult = sqlite3.RunResult;

export class SqliteDatabase {
  private constructor(
    private readonly database: sqlite3.Database,
    private readonly databasePath: string,
    private readonly journalMode: string
  ) {}

  static async open(databasePath: string): Promise<SqliteDatabase> {
    const database = await new Promise<sqlite3.Database>((resolve, reject) => {
      const instance = new sqlite3.Database(databasePath, error => {
        if (error) reject(error);
        else resolve(instance);
      });
    });

    try {
      await run(database, 'PRAGMA busy_timeout = 5000');
      await run(database, 'PRAGMA foreign_keys = ON');
      const journalMode = await get<{ journal_mode: string }>(database, 'PRAGMA journal_mode = WAL');
      const mode = String(journalMode?.journal_mode ?? '').toLowerCase();
      if (mode !== 'wal') {
        throw new Error(`SQLite WAL could not be enabled; current journal mode is ${mode || 'unknown'}`);
      }
      return new SqliteDatabase(database, databasePath, mode);
    } catch (error) {
      await close(database);
      throw error;
    }
  }

  async health(): Promise<DatabaseHealth> {
    await get(this.database, 'SELECT 1 AS ok');
    return {
      available: true,
      journalMode: this.journalMode,
      databasePath: this.databasePath
    };
  }

  async close(): Promise<void> {
    await close(this.database);
  }

  async run(sql: string, params: unknown[] = []): Promise<SqliteRunResult> {
    return run(this.database, sql, params);
  }

  async get<T>(sql: string, params: unknown[] = []): Promise<T | undefined> {
    return get<T>(this.database, sql, params);
  }

  async all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    return all<T>(this.database, sql, params);
  }

  async exec(sql: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.database.exec(sql, error => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  async transaction<T>(work: () => Promise<T>): Promise<T> {
    await this.run('BEGIN IMMEDIATE');
    try {
      const result = await work();
      await this.run('COMMIT');
      return result;
    } catch (error) {
      try {
        await this.run('ROLLBACK');
      } catch {
        // Preserve the original failure. The connection will be checked on the next operation.
      }
      throw error;
    }
  }
}

function run(database: sqlite3.Database, sql: string, params: unknown[] = []): Promise<SqliteRunResult> {
  return new Promise((resolve, reject) => {
    database.run(sql, params, function onRun(error) {
      if (error) reject(error);
      else resolve(this);
    });
  });
}

function get<T>(database: sqlite3.Database, sql: string, params: unknown[] = []): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    database.get(sql, params, (error, row: T | undefined) => {
      if (error) reject(error);
      else resolve(row);
    });
  });
}

function all<T>(database: sqlite3.Database, sql: string, params: unknown[] = []): Promise<T[]> {
  return new Promise((resolve, reject) => {
    database.all(sql, params, (error, rows: T[]) => {
      if (error) reject(error);
      else resolve(rows);
    });
  });
}

function close(database: sqlite3.Database): Promise<void> {
  return new Promise((resolve, reject) => {
    database.close(error => {
      if (error) reject(error);
      else resolve();
    });
  });
}
