import 'dotenv/config';
import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { createSupabaseRepository } from './supabase-repository.js';

// Run with the API stopped. Read-only SQLite; a conflict aborts the entire import.
const source = new DatabaseSync(resolve(process.env.DATABASE_PATH || 'data/pasa.sqlite'), { readOnly: true });
const target = createSupabaseRepository();
try {
  await target.verify();
  const documents = source.prepare('SELECT entity,id,body FROM documents ORDER BY rowid').all();
  const hasOutbox = source.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='lead_sync_outbox'").get();
  const outbox = hasOutbox ? source.prepare('SELECT * FROM lead_sync_outbox ORDER BY opportunity_id').all() : [];
  await target.transaction(async () => {
    for (const row of documents) {
      await target.importDocument(String(row.entity), String(row.id), String(row.body));
    }
    for (const row of outbox) await target.importOutbox(row);
  });
  console.log('Importación completada', { documents: documents.length, outbox: outbox.length });
} catch (error) {
  console.error('Importación cancelada; no se aplicaron cambios parciales.', {
    category: error instanceof Error ? error.name : 'UnknownError',
  });
  process.exitCode = 1;
} finally {
  source.close();
  await target.close();
}
