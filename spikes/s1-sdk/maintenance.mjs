// Maintenance snapshot: npm release history, weekly downloads, GitHub repo status and 90-day commit authors.
// Needs network and an authenticated `gh`. Writes results/maintenance.json (raw values plus the query date).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
const since = new Date(Date.now() - 90 * 864e5).toISOString();
const packages = ['@meshsdk/core', '@evolution-sdk/evolution', '@blaze-cardano/sdk', '@blaze-cardano/core', '@noble/hashes', '@noble/curves'];
const repos = ['MeshJS/mesh', 'IntersectMBO/evolution-sdk', 'butaneprotocol/blaze-cardano', 'paulmillr/noble-hashes', 'paulmillr/noble-curves'];
const gh = path => JSON.parse(execFileSync('gh', ['api', '--paginate', '--slurp', path], { encoding: 'utf8', maxBuffer: 64 << 20 })).flat();
const out = { queried: new Date().toISOString(), since, npm: {}, github: {} };
for (const p of packages) {
  const meta = await (await fetch(`https://registry.npmjs.org/${p.replace('/', '%2F')}`)).json();
  const versions = Object.entries(meta.time).filter(([k]) => k !== 'created' && k !== 'modified');
  const dl = await (await fetch(`https://api.npmjs.org/downloads/point/last-week/${p}`)).json();
  out.npm[p] = { created: meta.time.created, distTags: meta['dist-tags'], versions: versions.length,
    versionsSince: versions.filter(([, t]) => t >= since).length, latestPublished: meta.time[meta['dist-tags'].latest],
    weeklyDownloads: dl.downloads, downloadWindow: [dl.start, dl.end] };
}
for (const r of repos) {
  const [repo] = gh(`repos/${r}`);
  const authors = new Set(gh(`repos/${r}/commits?since=${since}&per_page=100`).map(c => c.author?.login).filter(a => a && !a.endsWith('[bot]')));
  out.github[r] = { stars: repo.stargazers_count, openIssuesAndPrs: repo.open_issues_count, pushedAt: repo.pushed_at, archived: repo.archived,
    license: repo.license?.spdx_id, commitAuthorsSince: authors.size };
}
fs.writeFileSync(new URL('results/maintenance.json', import.meta.url), JSON.stringify(out, null, 1));
console.log(JSON.stringify(out, null, 1));
