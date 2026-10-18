import { runAll } from 'RT';
runAll().then(r => { window.__result = r; }, e => { window.__result = { fatal: String(e?.stack ?? e) }; });
