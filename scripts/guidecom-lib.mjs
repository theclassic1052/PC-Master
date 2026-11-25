// 가이드컴 > 조립PC > 게임별 추천 컴퓨터 읽기 (공용 모듈)
// - Node: scripts/gaming-scrape.mjs 가 import (매일 gaming.json 생성, 실시간 실패 시 예비 데이터)
// - Cloudflare Worker(guidecom-search): 이 파일을 gq.js 로 넣고 handleGq 를 /gq 경로에 연결 → 앱이 실시간으로 읽음
export const BASE = 'https://www.guidecom.co.kr';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36';
export const TOP = 3; // 사양별 추천 상품 수
const euc = new TextDecoder('euc-kr');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function req(path, body, tries = 3) {
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
export const unent = (s) => String(s || '').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
export const strip = (s) => unent(String(s || '').replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
const num = (s) => Number(String(s || '').replace(/[^\d]/g, '')) || 0;

// 1) 게임 목록 (+ 인기게임 순서)
export async function games() {
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
export function parseLoader(html) {
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
export function parseList(html) {
  const out = [];
  for (const blk of html.split('class="goods-item"').slice(1)) {
    const gid = (blk.match(/detail\.html\?gid=(\d+)/) || [])[1];
    const name = strip((blk.match(/<h4 class="title">[\s\S]*?title="([^"]*)"/) || [])[1]).replace(/^\[\d+\]\s*/, '');
    const price = num((blk.match(/price-large[^>]*>\s*<span>([\d,]+)/) || [])[1]);
    if (gid && name && !out.some((x) => x.gid === gid)) out.push({ gid, name, price });
  }
  return out;
}
export async function list(spec) {
  const body = new URLSearchParams({ expanded: '1', spec, spec_expanded: '1', order: 'reco_goods', lpp: '12', page: '1' }).toString();
  return parseList(await req('/pc/list.php', body));
}

// 4) 상품 상세: 부품별 이름 · 가격
export async function parts(gid) {
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

export async function pool(items, n, fn) {
  const res = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; res[k] = await fn(items[k], k); await sleep(250); } }));
  return res;
}

export const CPU_GROUPS = new Set(['4548.0', '4562.0']); // 가이드컴 필터: CPU(인텔)·CPU(AMD)
// 조건을 줄여 찾은 경우: 빠진 부품(CPU 또는 그래픽카드) 모델 번호가 이름에 있는 상품 → 낮은 가격 순
export function rank(items, label, relaxed) {
  const [cpu = '', vga = ''] = String(label || '').split('+').map((x) => x.trim());
  const want = (relaxed === 'vga' ? cpu : vga).match(/\d{4,5}[A-Z]{0,3}/i);
  const key = want ? want[0].replace(/[A-Z]+$/i, '') : '';
  return items.slice().sort((a, b) => (key ? (b.name.includes(key) - a.name.includes(key)) : 0) || ((a.price || 9e9) - (b.price || 9e9)));
}
// 그래픽카드 모델 읽기 + 대략적인 성능 점수(같은 사양이 없을 때 '비슷하거나 더 좋은' 카드 고르기용)
const GPU_SCORE = {
  'GT1030': 5, 'GTX1650': 20, 'GTX1660': 26, 'GTX1660SUPER': 30, 'RTX3050': 28, 'RTX3060': 40, 'RTX3060TI': 48, 'RTX3070': 55, 'RTX3080': 68,
  'RTX4060': 50, 'RTX4060TI': 58, 'RTX4070': 70, 'RTX4070SUPER': 78, 'RTX4070TI': 80, 'RTX4070TISUPER': 86, 'RTX4080': 98, 'RTX4080SUPER': 100, 'RTX4090': 125,
  'RTX5050': 45, 'RTX5060': 56, 'RTX5060TI': 64, 'RTX5070': 80, 'RTX5070TI': 94, 'RTX5080': 108, 'RTX5090': 150,
  'RX6500XT': 18, 'RX6600': 38, 'RX6650XT': 44, 'RX7600': 48, 'RX7600XT': 50, 'RX7700XT': 66, 'RX7800XT': 76, 'RX7900XT': 95, 'RX7900XTX': 105,
  'RX9060': 54, 'RX9060XT': 62, 'RX9070': 86, 'RX9070XT': 96,
};
export function gpuOf(text) {
  const m = String(text || '').toUpperCase().replace(/지포스|라데온/g, ' ').match(/\b(RTX|GTX|RX|GT)\s*-?\s*(\d{3,4})\s*(TI\s*SUPER|TIS|TI|SUPER|XTX|XT|S)?(?![A-Z0-9])/);
  if (!m) return null;
  let suf = (m[3] || '').replace(/\s+/g, '');
  if (suf === 'TIS') suf = 'TISUPER'; if (suf === 'S') suf = 'SUPER';
  const key = m[1] + m[2] + suf;
  return { key, score: GPU_SCORE[key] ?? null };
}
export async function bestFor(spec, label) {
  // 1) 가이드컴 추천표 사양 그대로의 조립PC 목록(가이드컴 추천순).
  // 2) 사양 중 재고(상품)가 없는 부품이 있으면: 나머지 부품이 같은 가이드컴 PC 하나를 골라
  //    그 PC의 부품 구성으로 견적을 만들고, 없는 부품만 비슷한 것으로 채운다(sub 표시).
  //    가이드컴은 상품이 없는 조건을 무시하므로 조건 하나씩 상품 유무를 먼저 확인한다.
  const pairs = spec.split(',').filter(Boolean);
  const [cpuLabel = '', vgaLabel = ''] = String(label || '').split('+').map((x) => x.trim());
  const want = gpuOf(vgaLabel);
  const missing = [];
  if (pairs.length > 1) for (const p of pairs) if (!(await list(p)).length) missing.push(p);
  if (!missing.length) {
    let items = await list(spec);
    if (want) items = items.filter((it) => { const g = gpuOf(it.name); return !g || g.key === want.key; });
    if (items.length || pairs.length < 2) return { relaxed: '', items: items.slice(0, TOP), none: !items.length };
    // CPU·그래픽카드 각각은 있지만 둘을 같이 쓴 PC가 없음 → CPU 는 그대로, 그래픽카드만 대체
    missing.push(...pairs.filter((p) => !CPU_GROUPS.has(p.split('|')[0])));
  }
  if (missing.length >= pairs.length) return { relaxed: '', items: [], none: true };
  const have = pairs.find((p) => !missing.includes(p));
  const pool = await list(have);
  if (!pool.length) return { relaxed: '', items: [], none: true };
  const vgaMissing = !CPU_GROUPS.has(have.split('|')[0]); // 남은 조건이 CPU 가 아니면 → 그래픽카드가 남음 = CPU 가 없는 것
  let pick;
  if (!vgaMissing) {
    // CPU 는 있고 그래픽카드가 없음 → 같은 CPU PC 중 추천 카드와 같거나 더 좋은 것 중 가장 가까운 카드, 없으면 바로 아래 카드
    const ws = want?.score ?? 0;
    const t = pool.map((it) => ({ it, g: gpuOf(it.name) }));
    const cls = (x) => (x.g?.score == null ? 2 : x.g.score >= ws ? 0 : 1);
    t.sort((a, b) => cls(a) - cls(b) || (cls(a) === 0 ? a.g.score - b.g.score : cls(a) === 1 ? b.g.score - a.g.score : 0) || ((a.it.price || 9e9) - (b.it.price || 9e9)));
    pick = t[0].it;
    return { relaxed: 'sub', none: false, items: [{ ...pick, sub: { cate: 'VGA', from: vgaLabel } }] };
  }
  // 그래픽카드는 있고 CPU 가 없음 → 같은 회사(인텔/AMD) CPU PC 중 가장 싼 것
  const amd = /라이젠|ryzen|amd|^r\d/i.test(cpuLabel);
  const same = pool.filter((it) => (amd ? /라이젠|ryzen|amd|\bR[3579]\b/i.test(it.name) : /인텔|intel|\bi[3579]\b|\d{5}[FK]|울트라|ultra/i.test(it.name)));
  pick = (same.length ? same : pool).slice().sort((a, b) => (a.price || 9e9) - (b.price || 9e9))[0];
  return { relaxed: 'sub', none: false, items: [{ ...pick, sub: { cate: 'CPU', from: cpuLabel } }] };
}


// ---------- Worker 용: GET /gq?game=ID  |  /gq?spec=…&label=…  |  /gq?gid=… ----------
const memo = new Map(); // 같은 Worker 인스턴스 안 짧은 캐시(60초)
async function cached(key, fn) {
  const hit = memo.get(key);
  if (hit && Date.now() - hit.t < 60000) return hit.v;
  const v = await fn(); memo.set(key, { t: Date.now(), v });
  if (memo.size > 300) memo.delete(memo.keys().next().value);
  return v;
}
export async function handleGq(url) {
  const H = { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' };
  const q = url.searchParams;
  try {
    let out;
    if (q.get('game')) {
      const id = q.get('game');
      if (!/^\d{1,3}$/.test(id)) throw new Error('bad game');
      out = await cached('g' + id, async () => {
        const r = await req('/pc/gaming_loader.php', new URLSearchParams({ id }).toString());
        return { game: id, rec: parseLoader(JSON.parse(r).content || '') };
      });
    } else if (q.get('spec')) {
      const spec = q.get('spec');
      if (!/^[\d.|,]{3,80}$/.test(spec)) throw new Error('bad spec');
      out = await cached('s' + spec, async () => {
        const v = await bestFor(spec, q.get('label') || '');
        await Promise.all(v.items.map(async (it) => { it.parts = await parts(it.gid).catch(() => []); }));
        return v;
      });
    } else if (q.get('gid')) {
      const gid = q.get('gid');
      if (!/^\d{1,9}$/.test(gid)) throw new Error('bad gid');
      out = { gid, parts: await cached('p' + gid, () => parts(gid)) };
    } else throw new Error('game, spec 또는 gid 가 필요해요');
    return new Response(JSON.stringify({ live: true, at: new Date().toISOString(), ...out }), { headers: H });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e.message || e) }), { status: 502, headers: H });
  }
}
