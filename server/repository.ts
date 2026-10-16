import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type {
  Customer,
  Opportunity,
  Conversation,
  Message,
  Evaluation,
  Event,
  Task,
  Rules,
} from "../shared/domain.js";

interface Entities {
  customers: Customer;
  opportunities: Opportunity;
  conversations: Conversation;
  messages: Message;
  evaluations: Evaluation;
  events: Event;
  tasks: Task;
  rules: Rules;
}

type Table = keyof Entities;

const tables: Table[] = [
  "customers",
  "opportunities",
  "conversations",
  "messages",
  "evaluations",
  "events",
  "tasks",
  "rules",
];

export class SqliteRepository {
  private db: DatabaseSync;

  constructor(path = "data/pasa.sqlite") {
    const file = path === ":memory:" ? path : resolve(path);

    if (file !== ":memory:") {
      mkdirSync(dirname(file), { recursive: true });
    }

    this.db = new DatabaseSync(file);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS documents (
        entity TEXT NOT NULL,
        id TEXT NOT NULL,
        body TEXT NOT NULL CHECK (json_valid(body)),
        PRIMARY KEY (entity, id)
      );

      CREATE UNIQUE INDEX IF NOT EXISTS customer_phone
      ON documents(json_extract(body, '$.phone'))
      WHERE entity = 'customers';

      CREATE UNIQUE INDEX IF NOT EXISTS customer_email
      ON documents(json_extract(body, '$.email'))
      WHERE entity = 'customers';

      CREATE UNIQUE INDEX IF NOT EXISTS opportunity_conversation
      ON documents(json_extract(body, '$.opportunityId'))
      WHERE entity = 'conversations';
    `);
  }

  get<K extends Table>(
    table: K,
    id: string,
  ): Entities[K] | undefined {
    this.checkTable(table);

    const row = this.db
      .prepare("SELECT body FROM documents WHERE entity = ? AND id = ?")
      .get(table, id);

    if (!row) return undefined;

    return JSON.parse(String(row.body)) as Entities[K];
  }

  all<K extends Table>(table: K): Entities[K][] {
    this.checkTable(table);

    const rows = this.db
      .prepare("SELECT body FROM documents WHERE entity = ? ORDER BY rowid")
      .all(table);

    return rows.map(
      (row) => JSON.parse(String(row.body)) as Entities[K],
    );
  }

  put<K extends Table>(table: K, item: Entities[K]): void {
    this.checkTable(table);

    this.db
      .prepare(`
        INSERT INTO documents (entity, id, body)
        VALUES (?, ?, ?)
        ON CONFLICT (entity, id)
        DO UPDATE SET body = excluded.body
      `)
      .run(table, item.id, JSON.stringify(item));
  }

  transaction<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");

    try {
      const result = operation();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }

  private checkTable(table: Table): void {
    if (!tables.includes(table)) {
      throw new Error("Entidad no permitida.");
    }
  }
}