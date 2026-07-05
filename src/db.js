import sqlite3 from 'sqlite3';
import { join } from 'path';

// Resolve database.db dynamically in the folder where the executable is launched
const dbPath = join(process.cwd(), 'database.db');

console.log(`[Database] Initializing SQLite database at: ${dbPath}`);

export const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('[Database] Failed to open SQLite database:', err.message);
  } else {
    console.log(`[Database] SQLite database successfully connected at: ${dbPath}`);
    // Create a message log table for persistence demonstration
    db.run(`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        phone TEXT,
        recipient TEXT,
        message TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `, (err) => {
      if (err) {
        console.error('[Database] Error creating messages table:', err.message);
      } else {
        console.log('[Database] messages table is ready');
      }
    });
  }
});
