// Fake history deps for tests: the history files live in a temp folder; zlib stands in for gzip, and the app's database,
// the open-file check and the ledger are injected. Nothing here runs gzip or lsof.
import fs from 'node:fs';
import zlib from 'node:zlib';
import { historyFile } from '../src/index.mjs';

export const NOW = Date.parse('2026-11-16T12:00:00Z');

export function fakeHistoryDeps(home, { sql = async () => [], openBy = async () => [], ledger = [] } = {}) {
  return {
    now: () => NOW,
    sleep: async () => {},
    sql,
    historyPath: (id) => historyFile(home, id),
    gzip: async (file) => {
      fs.writeFileSync(`${file}.gz`, zlib.gzipSync(fs.readFileSync(file)));
      fs.rmSync(file);
    },
    gunzip: async (gz) => {
      fs.writeFileSync(gz.slice(0, -3), zlib.gunzipSync(fs.readFileSync(gz)));
      fs.rmSync(gz);
    },
    openBy,
    ledger: (row) => { ledger.push(row); },
  };
}
