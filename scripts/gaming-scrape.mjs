// 가이드컴 게임별 추천 데이터를 모아 gaming.json(예비 데이터)으로 저장. 사용: node scripts/gaming-scrape.mjs [출력=gaming.json]
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { BASE, req, games, parseLoader, bestFor, parts, pool } from './guidecom-lib.mjs';
const OUT = process.argv[2] || 'gaming.json';
const t0 = Date.now();
const { list: gameList, popular } = await games();
console.log(`게임 ${gameList.length}개`);
const rec = {};
await pool(gameList, 3, async (g) => {
  try {
    const r = await req('/pc/gaming_loader.php', new URLSearchParams({ id: g.id }).toString());
    rec[g.id] = parseLoader(JSON.parse(r).content || '');
  } catch (e) { console.warn('게임', g.id, g.name, e.message); }
});
const specs = new Map();
for (const rs of Object.values(rec)) for (const r of rs) for (const o of r.opts) for (const c of ['intel', 'amd']) if (o[c] && !specs.has(o[c].spec)) specs.set(o[c].spec, o[c].label);
console.log(`사양 ${specs.size}개`);
const specData = {};
await pool([...specs.keys()], 3, async (s) => {
  try { specData[s] = await bestFor(s, specs.get(s)); } catch (e) { console.warn('사양', s, e.message); specData[s] = { relaxed: '', items: [] }; }
});
const gids = new Set(); for (const v of Object.values(specData)) for (const it of v.items) gids.add(it.gid);
console.log(`상품 ${gids.size}개`);
const goods = {};
await pool([...gids], 3, async (gid) => { try { goods[gid] = await parts(gid); } catch (e) { console.warn('상품', gid, e.message); } });
for (const v of Object.values(specData)) for (const it of v.items) it.parts = goods[it.gid] || [];

const okGames = gameList.filter((g) => rec[g.id]?.length);
if (okGames.length < gameList.length / 2 || !Object.values(specData).some((v) => v.items.length)) {
  console.error('수집된 데이터가 너무 적어서 저장하지 않아요');
  process.exit(1);
}
const data = { source: BASE + '/pc/index.html', updatedAt: new Date().toISOString(), games: okGames, popular: popular.filter((id) => rec[id]?.length), rec, specs: specData };
const json = JSON.stringify(data);
const prev = existsSync(OUT) ? readFileSync(OUT, 'utf8') : '';
const strip2 = (s) => s.replace(/"updatedAt":"[^"]*"/, '');
if (prev && strip2(prev) === strip2(json)) console.log('변경 없음');
else { writeFileSync(OUT, json); console.log(`저장: ${OUT} (${(json.length / 1024).toFixed(0)}KB)`); }
console.log(`완료 ${((Date.now() - t0) / 1000).toFixed(0)}초`);
