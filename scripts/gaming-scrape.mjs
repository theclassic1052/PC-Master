// 가이드컴 > 조립PC > 게임별 추천 컴퓨터 데이터를 모아 gaming.json 으로 저장한다.
// GitHub Actions(gaming.yml)가 하루 한 번 실행. 앱의 '게임견적' 팝업이 이 파일을 읽는다(같은 주소라 CORS 문제 없음).
// 사용: node scripts/gaming-scrape.mjs [출력파일=gaming.json]
import { writeFileSync, readFileSync, existsSync } from 'node:fs';

const BASE = 'https://www.guidecom.co.kr';
const OUT = process.argv[2] || 'gaming.json';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36';
const TOP = 3; // 사양별 추천 상품 수
const euc = new TextDecoder('euc-kr');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function req(path, body, tries = 3) {
  for (let i = 1; ; i++) {
    try {
      const r = await fetch(BASE + path, {
        method: body ? 'POST' : 'GET',
        headers: {
          'User-Agent': UA, 'Accept-Language': 'ko-KR,ko;q=0.9', Referer: BASE + '/pc/index.html',
          ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest' } : {}),
        },
        body,
        signal: AbortSignal.timeout(30000),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status} ${path}`);
      const buf = new Uint8Array(await r.arrayBuffer());
      const ct = r.headers.get('content-type') || '';
      return /utf-?8/i.test(ct) ? new TextDecoder().decode(buf) : euc.decode(buf);
    } catch (e) {
      if (i >= tries) throw e;
      await sleep(1500 * i);
    }
  }
}
const unent = (s) => String(s || '').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
const strip = (s) => unent(String(s || '').replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
const num = (s) => Number(String(s || '').replace(/[^\d]/g, '')) || 0;

// 1) 게임 목록 (+ 인기게임 순서)
async function games() {
  const h = await req('/pc/gaming.html?id=01');
  const tag = h.slice(h.indexOf('<gaming-navigator'), h.indexOf('>', h.indexOf('<gaming-navigator')) + 1);
  const items = unent((tag.match(/:data-items="([^"]*)"/) || [])[1] || '');
  const list = [];
  for (const m of items.matchAll(/"id":"(\d+)","name":"((?:[^"\\]|\\.)*)"/g)) {
    const name = JSON.parse(`"${m[2]}"`).trim();
    if (name && !list.some((g) => g.id === m[1])) list.push({ id: m[1], name });
  }
  const best = unent((tag.match(/:data-best-items="([^"]*)"/) || [])[1] || '[]');
  let popular = [];
  try { popular = JSON.parse(best).map((b) => b.ref).filter((id) => list.some((g) => g.id === id)); } catch {}
  if (!list.length) throw new Error('게임 목록을 읽지 못했어요');
  list.sort((a, b) => a.name.localeCompare(b.name, 'ko'));
  return { list, popular };
}

// 2) 게임별 해상도 · 옵션 · 인텔/AMD 추천 사양
function parseLoader(html) {
  const res = [];
  for (const blk of html.split('<div class="gaming-resolution">').slice(1)) {
    const title = strip((blk.match(/<h2>[\s\S]*?<span>([\s\S]*?)<\/span>/) || [])[1]);
    const sub = strip((blk.match(/<small>([\s\S]*?)<\/small>/) || [])[1]);
    const tabs = [...blk.matchAll(/<button class="tab[^"]*"[^>]*data-item="(\d+)"[^>]*>([\s\S]*?)<\/button>/g)].map((m) => ({ k: m[1], name: strip(m[2]) }));
    const opts = [];
    for (const t of tabs) {
      const re = new RegExp(`<div class="item[^"]*" data-row="\\d+" data-item="${t.k}">([\\s\\S]*?)(?=<div class="item|$)`);
      const body = (blk.match(re) || [])[1] || '';
      const o = { name: t.name };
      for (const dl of body.split('<dl>').slice(1)) {
        const cpu = /cpu amd/.test(dl) ? 'amd' : /cpu intel/.test(dl) ? 'intel' : null;
        const href = unent((dl.match(/href="([^"]+)"/) || [])[1] || '');
        const spec = decodeURIComponent((href.match(/[?&]spec=([^&]+)/) || [])[1] || '');
        const label = strip((dl.match(/title="([^"]*)"/) || [])[1]);
        if (cpu && spec) o[cpu] = { label, spec };
      }
      if (o.intel || o.amd) opts.push(o);
    }
    if (title && opts.length) res.push({ title, sub, opts });
  }
  return res;
}

// 3) 사양(spec)에 맞는 조립PC 목록 (가이드컴 추천순)
function parseList(html) {
  const out = [];
  for (const blk of html.split('class="goods-item"').slice(1)) {
    const gid = (blk.match(/detail\.html\?gid=(\d+)/) || [])[1];
    const name = strip((blk.match(/<h4 class="title">[\s\S]*?title="([^"]*)"/) || [])[1]).replace(/^\[\d+\]\s*/, '');
    const price = num((blk.match(/price-large[^>]*>\s*<span>([\d,]+)/) || [])[1]);
    if (gid && name && !out.some((x) => x.gid === gid)) out.push({ gid, name, price });
  }
  return out;
}
async function list(spec) {
  const body = new URLSearchParams({ expanded: '1', spec, spec_expanded: '1', order: 'reco_goods', lpp: '12', page: '1' }).toString();
  return parseList(await req('/pc/list.php', body));
}

// 4) 상품 상세: 부품별 이름 · 가격
async function parts(gid) {
  const h = await req(`/pc/detail.html?gid=${gid}`);
  const m = h.match(/:data-parts="([^"]*)"/);
  if (!m) return [];
  const groups = JSON.parse(unent(m[1]));
  const out = [];
  for (const g of groups) {
    for (const p of g.parts || []) {
      if (!p.part_selected) continue;
      out.push({ cate: g.cate_name_brief || g.cate_name, name: (p.part_name_brief || p.part_name || '').trim(), price: Number(p.part_price) || 0, qty: Number(p.part_qty) || 1 });
    }
  }
  return out;
}

async function pool(items, n, fn) {
  const res = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; res[k] = await fn(items[k], k); await sleep(250); } }));
  return res;
}

const CPU_GROUPS = new Set(['4548.0', '4562.0']); // 가이드컴 필터: CPU(인텔)·CPU(AMD)
async function bestFor(spec) {
  let items = await list(spec), relaxed = '';
  if (!items.length) { // 딱 맞는 상품이 없으면 그래픽카드 → CPU 조건 하나만으로 다시 찾기
    const pairs = spec.split(',');
    const order = [...pairs.filter((p) => !CPU_GROUPS.has(p.split('|')[0])), ...pairs.filter((p) => CPU_GROUPS.has(p.split('|')[0]))];
    for (const p of order) {
      if (pairs.length < 2) break;
      items = await list(p);
      if (items.length) { relaxed = CPU_GROUPS.has(p.split('|')[0]) ? 'cpu' : 'vga'; break; }
    }
  }
  return { relaxed, items: items.slice(0, TOP) };
}

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
const specs = new Set();
for (const rs of Object.values(rec)) for (const r of rs) for (const o of r.opts) for (const c of ['intel', 'amd']) if (o[c]) specs.add(o[c].spec);
console.log(`사양 ${specs.size}개`);
const specData = {};
await pool([...specs], 3, async (s) => {
  try { specData[s] = await bestFor(s); } catch (e) { console.warn('사양', s, e.message); specData[s] = { relaxed: '', items: [] }; }
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
