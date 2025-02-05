import { ConnectionConfig, Pool, PoolClient, PoolConfig } from "pg";
import fs from "fs";
import path from "path";
import csv from "csv-parser";
import { stringify } from "csv";
import { from as copyFrom } from "pg-copy-streams";
import { format } from "util";
import { pipeline } from "node:stream/promises";
import { Transform } from "stream";
import { ColumnParserTransformer } from "./columnParserTransformer";
import { globSync } from "glob";

type Index = {
  name: string;
  definition: string;
  tableName: string;
};

type Constraint = {
  constraintName: string;
  definition: string;
  tableName: string;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Row = { [column: string]: any };

export interface PGBulkConfig {
  strategy?: "csv";
  csvConfig?: csv.Options;
  /**
   * This option will temporarily delete all *foreign keys* constraints on the defined tables.
   * This option can cause loss of error checking while the constraints is missing, but, it will increase data load speed.
   *
   * See [PostgreSQL Populate documentation](https://www.postgresql.org/docs/current/populate.html#POPULATE-RM-FKEYS) to see more.
   * @default false
   * */
  allowDisableForeignKeys?: boolean;

  /**
   * This option will temporarily delete all *indexes* (this will not delete unique indexes) on the defined tables.
   * This option can cause performance loss for other users during the time the indexes if missing, but, it will increase data load speed.
   *
   * See [PostgreSQL Populate documentation](https://www.postgresql.org/docs/current/populate.html#POPULATE-RM-INDEXES) to see more.
   * @default false
   * */
  allowDisableIndexes?: boolean;

  /**
   * Quiet mode
   *
   * @default false
   */
  quiet?: boolean;

  /**
   * PostgreSQL Client config
   *
   * See [pg documentation](https://node-postgres.com/apis/client#new-client)
   */
  connection: PoolConfig;
  schema?: string;
  /**
   * Set temporary table name
   *
   * @default "staging_pgbulk"
   */
  temporaryTableName?: string;
  /**
   * Define all tables to bulk insert
   */
  tables: {
    [tableName: string]: {
      databaseColumn: string;
      csvColumn?: string;
      type: string;
      ref?: string;
      unnest?: boolean;
      castType?: string;
    }[];
  };
}

export class PGBulk {
  readonly config: PGBulkConfig;
  readonly usingTemporaryTableStrategy: boolean;

  protected pool?: Pool;
  protected temporaryTableName;

  files: string[] = [];

  constructor(config: PGBulkConfig) {
    this.config = config;
    this.temporaryTableName = config.temporaryTableName || "staging_pgbulk";
    this.usingTemporaryTableStrategy = this.canUseTemporaryTableStrategy();

    const pool = new Pool({
      ...this.config.connection,
      allowExitOnIdle: true,
      max: 30,
    });

    this.pool = pool;
  }

  register(basePath: string, globPattern?: string) {
    const files = globSync(globPattern || "*", {
      cwd: path.resolve(basePath),
    });

    this.files = [
      ...this.files,
      ...files.map((file) => path.resolve(basePath, file)),
    ];
  }

  async start() {
    if (this.files.length === 0) throw new Error("No files registred.");

    const client = await this.pool!.connect();

    await client.query("BEGIN");

    if (this.usingTemporaryTableStrategy)
      await this.createTemporaryTable(client);

    let indexes: Index[] = [];
    let constraints: Constraint[] = [];

    if (this.config.allowDisableIndexes) {
      const tables = this.getAllDefinedTables();

      for (const table of tables) {
        const newIndexes = await this.getIndexesFromTable(client, table);

        indexes = [...indexes, ...newIndexes];
      }
    }

    if (this.config.allowDisableForeignKeys) {
      const tables = this.getAllDefinedTables();

      for (const table of tables) {
        const newConstraints = await this.getConstraintsFromTable(
          client,
          table
        );

        constraints = [...constraints, ...newConstraints];
      }
    }

    const copyStream = client.query(copyFrom(this.buildCopyQuery()));

    const tasks = this.files.map(async (file) => {
      await pipeline(
        this.streamFile(file)
          .pipe(
            new Transform({
              objectMode: true,
              transform: async (chunk, enc, callback) =>
                callback(null, await this.parse(chunk)),
            })
          )
          .pipe(new ColumnParserTransformer(this.config.tables))
          .pipe(
            stringify({
              columns: this.getTemporaryTableColumns(),
            })
          ),
        copyStream
      );
    });

    await Promise.all(tasks);

    if (this.usingTemporaryTableStrategy)
      await client.query(`ANALYZE "${this.temporaryTableName}"`);

    // remove indexes and constraints
    // see: https://www.postgresql.org/docs/current/populate.html#POPULATE-RM-INDEXES
    // If indexes or constraints is empty nothing will happen lol xd
    await Promise.all([
      this.removeAllIndexes(client, indexes),
      this.removeAllForeignConstraints(client, constraints),
    ]);

    // populate to actual tables
    if (this.usingTemporaryTableStrategy) await this.pushToTable(client);

    // recreate all indexes and contraints
    await Promise.all([
      this.recreateAllIndexes(client, indexes),
      this.recreateAllConstraints(client, constraints),
    ]);

    await Promise.all([
      async () => {
        if (this.config.allowDisableIndexes)
          await this.checkIfIndexesMatches(client, indexes);
      },

      async () => {
        if (this.config.allowDisableForeignKeys)
          await this.checkIfConstraintsMatches(client, constraints);
      },
    ]);

    // analyze tables to update the planner
    for (const table of this.getAllDefinedTables()) {
      await client.query(`ANALYZE "${table}"`);
    }

    await this.onFinish();

    await client.query("COMMIT");

    client.release();
  }

  static async startAll(bulks: PGBulk[]) {
    const tasks = bulks.map(async (bulk) => {
      return await bulk.start();
    });

    await Promise.all(tasks);
  }

  async end() {
    await this.pool!.end();
  }

  // callbacks
  async onFinish() {}

  async parse(row: Row): Promise<Row> {
    return row;
  }

  private streamFile(filePath: string) {
    return fs.createReadStream(filePath).pipe(csv(this.config.csvConfig));
  }

  private async pushToTable(client: PoolClient) {
    const selects = this.getAllDefinedTables().flatMap((tableName) => {
      const columns = this.config.tables[tableName];

      return columns
        .map(({ databaseColumn, unnest, castType }) => {
          const cast = `${castType ? `::${castType}` : ""}`;
          const tempRow = `"${tableName}_${databaseColumn}"`;

          return `${
            unnest ? `unnest(${tempRow})` : tempRow
          }${cast} AS "${databaseColumn}"`;
        })
        .join(", ");
    });

    const query = this.getAllDefinedTables()
      .map(
        (tableName, index) =>
          `INSERT INTO "${tableName}" SELECT ${selects[index]} FROM "${this.temporaryTableName}" ON CONFLICT DO NOTHING;`
      )
      .join(" ");

    await client.query(query);
  }

  private async createTemporaryTable(client: PoolClient) {
    const columns = Object.values(this.config.tables).flatMap((fields, index) =>
      fields.map(({ databaseColumn, type }) => ({
        databaseColumn,
        type,
        tableName: Object.keys(this.config.tables)[index],
      }))
    );

    const columnsQuery = columns
      .map(
        ({ databaseColumn, type, tableName }) =>
          `"${tableName}_${databaseColumn}" ${type}`
      )
      .join(", ");

    const query = format(
      `CREATE TEMPORARY TABLE "%s" (%s)`,
      this.temporaryTableName,
      columnsQuery
    );

    await client.query(query);
  }

  private buildCopyQuery() {
    const columns = this.usingTemporaryTableStrategy
      ? this.getTemporaryTableColumns()
          .map((column) => `"${column}"`)
          .join(", ")
      : this.getAllDefinedColumns()
          .map((column) => `"${column.databaseColumn}"`)
          .join(", ");

    const table = this.usingTemporaryTableStrategy
      ? this.temporaryTableName
      : this.getAllDefinedTables()[0];

    return `COPY "${table}"(${columns}) FROM STDIN (FORMAT CSV)`;
  }

  private async getConstraintsFromTable(
    client: PoolClient,
    tableName: string
  ): Promise<Constraint[]> {
    return (
      await client.query(
        `SELECT 
          con.conname AS "constraintName",
          pg_get_constraintdef(con.oid, true) AS definition,
          $1::text AS "tableName"
        FROM
          pg_constraint con
          JOIN pg_class cl ON con.conrelid = cl.oid
          JOIN pg_namespace ns ON cl.relnamespace = ns.oid
        WHERE
          cl.relname = $1
        AND con.contype <> 'p'`,
        [tableName]
      )
    ).rows;
  }

  private async getIndexesFromTable(
    client: PoolClient,
    tableName: string
  ): Promise<Index[]> {
    return (
      await client.query(
        `SELECT 
          indexname AS name, 
          indexdef AS definition,
          $1::text AS "tableName"
        FROM pg_indexes 
        WHERE tablename = $1
        AND indexdef NOT ILIKE 'CREATE UNIQUE INDEX%'`,
        [tableName]
      )
    ).rows;
  }

  private async removeAllIndexes(client: PoolClient, indexes: Index[]) {
    if (indexes.length === 0) return;

    const indexesName = indexes.map(({ name }) => `"${name}"`).join(", ");

    await client.query(format(`DROP INDEX IF EXISTS %s RESTRICT`, indexesName));
  }

  private async removeAllForeignConstraints(
    client: PoolClient,
    constraints: Constraint[]
  ) {
    if (constraints.length === 0) return;

    const query = constraints
      .map(
        ({ tableName, constraintName }) =>
          `ALTER TABLE "${tableName}" DROP CONSTRAINT "${constraintName}"`
      )
      .join("; ");

    await client.query(query);
  }

  private async recreateAllIndexes(client: PoolClient, indexes: Index[]) {
    if (indexes.length === 0) return;

    const query = indexes.map(({ definition }) => definition).join("; ");

    await client.query(query);
  }

  private async recreateAllConstraints(
    client: PoolClient,
    constraints: Constraint[]
  ) {
    if (constraints.length === 0) return;

    const query = constraints
      .map(
        ({ tableName, definition, constraintName }) =>
          `ALTER TABLE "${tableName}" ADD CONSTRAINT "${constraintName}" ${definition}`
      )
      .join("; ");

    await client.query(query);
  }

  private async checkIfIndexesMatches(client: PoolClient, indexes: Index[]) {
    let foundIndexes: string[] = [];

    if (this.config.allowDisableForeignKeys) {
      const tables = this.getAllDefinedTables();

      for (const table of tables) {
        const newIndexes = await this.getIndexesFromTable(client, table);

        foundIndexes = [
          ...foundIndexes,
          ...newIndexes.map((c) => `${c.name}_${c.definition}`),
        ];
      }
    }

    const matches = indexes
      .map((c) => `${c.name}_${c.definition}`)
      .every((key) => foundIndexes.includes(key));

    if (!matches) throw new Error("Indexes does not match. Rolled back");
  }

  private async checkIfConstraintsMatches(
    client: PoolClient,
    constraints: Constraint[]
  ) {
    let foundConstraints: string[] = [];

    if (this.config.allowDisableForeignKeys) {
      const tables = this.getAllDefinedTables();

      for (const table of tables) {
        const newConstraints = await this.getConstraintsFromTable(
          client,
          table
        );

        foundConstraints = [
          ...foundConstraints,
          ...newConstraints.map((c) => `${c.constraintName}_${c.definition}`),
        ];
      }
    }

    const matches = constraints
      .map((c) => `${c.constraintName}_${c.definition}`)
      .every((key) => foundConstraints.includes(key));

    if (!matches) throw new Error("Constraints does not match. Rolled back");
  }

  private getAllDefinedColumns() {
    const columns = Object.values(this.config.tables).flatMap((fields, index) =>
      fields.map(({ databaseColumn, type }) => ({
        databaseColumn,
        type,
        tableName: Object.keys(this.config.tables)[index],
      }))
    );

    return columns;
  }

  private getTemporaryTableColumns() {
    const columns = this.getAllDefinedColumns();

    return columns.map(
      ({ databaseColumn, tableName }) => `${tableName}_${databaseColumn}`
    );
  }

  private getAllDefinedTables() {
    return Object.keys(this.config.tables);
  }

  private canUseTemporaryTableStrategy() {
    const definedTables = this.getAllDefinedTables();

    const hasCastingOrUnnest = Object.values(this.config.tables).some(
      (columns) => columns.some((column) => column.castType || column.unnest)
    );

    return definedTables.length > 1 || hasCastingOrUnnest;
  }
}

export { ConnectionConfig };
