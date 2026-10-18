import { runAll } from 'RT';
export default { async fetch() { try { return Response.json(await runAll()); } catch (e) { return Response.json({ fatal: String(e?.stack ?? e) }); } } };
