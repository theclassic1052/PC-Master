// ---- 네이버 메일(IMAP)에서 국세청 세금계산서 메일 가져오기 ----
// POST /nts?key=...  body: {"id":"네이버아이디","pw":"애플리케이션 비밀번호","days":7}            → [{uid, date, subject}]
// POST /nts?key=...  body: {"id":..,"pw":..,"uids":[123,124]}                                   → [{uid, date, subject, b64}]
// 첨부(NTS_eTaxInvoice.html)는 암호화된 그대로(base64) 돌려주고, 해독은 앱(기기 안)에서 해요.

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export class Imap {
  constructor(sock) {
    this.reader = sock.readable.getReader();
    this.writer = sock.writable.getWriter();
    this.buf = '';
    this.n = 0;
    this.enc = new TextEncoder();
  }
  async fill() {
    const { value, done } = await this.reader.read();
    if (done) throw new Error('메일 서버 연결이 끊겼어요');
    let s = '';
    for (let i = 0; i < value.length; i += 0x8000) s += String.fromCharCode.apply(null, value.subarray(i, i + 0x8000));
    this.buf += s;
  }
  async line() {
    let i;
    while ((i = this.buf.indexOf('\r\n')) < 0) await this.fill();
    const l = this.buf.slice(0, i);
    this.buf = this.buf.slice(i + 2);
    return l;
  }
  async bytes(n) {
    while (this.buf.length < n) await this.fill();
    const b = this.buf.slice(0, n);
    this.buf = this.buf.slice(n);
    return b;
  }
  // 응답 전체(리터럴 포함)를 모아서 돌려줌
  async cmd(c) {
    const tag = 'a' + (++this.n);
    await this.writer.write(this.enc.encode(tag + ' ' + c + '\r\n'));
    let out = '';
    for (;;) {
      const l = await this.line();
      if (l.startsWith(tag + ' ')) {
        if (!/^\S+ OK/i.test(l)) throw new Error(l.slice(tag.length + 1).slice(0, 120));
        return out;
      }
      out += l + '\r\n';
      const m = l.match(/\{(\d+)\}$/);
      if (m) out += await this.bytes(parseInt(m[1], 10));
    }
  }
  async greet() { const l = await this.line(); if (!/^\* OK/i.test(l)) throw new Error('메일 서버 응답 이상: ' + l.slice(0, 80)); }
}

const q = (s) => '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';

function sinceDate(days) {
  const d = new Date(Date.now() - days * 864e5);
  return d.getUTCDate() + '-' + MON[d.getUTCMonth()] + '-' + d.getUTCFullYear();
}

// 인코딩된 제목(=?UTF-8?B?...?=) 풀기 (UTF-8만)
function decodeWords(s) {
  return s.replace(/=\?utf-8\?([bq])\?([^?]*)\?=/gi, (_, e, t) => {
    try {
      let bin;
      if (e.toLowerCase() === 'b') bin = atob(t);
      else bin = t.replace(/_/g, ' ').replace(/=([0-9a-f]{2})/gi, (x, h) => String.fromCharCode(parseInt(h, 16)));
      return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
    } catch { return t; }
  }).replace(/\?=\s+=\?/g, '');
}

// 원본 메일에서 NTS 첨부의 base64만 잘라냄
export function extractAttachment(raw, depth = 0) {
  const m = raw.match(/boundary="?([^"\r\n;]+)"?/i);
  if (!m || depth > 3) return '';
  const parts = raw.split('--' + m[1]).slice(1);
  for (const p of parts) {
    const hEnd = p.indexOf('\r\n\r\n');
    if (hEnd < 0) continue;
    const head = p.slice(0, hEnd);
    if (/NTS_eTaxInvoice|name="?[^"\r\n]*\.html?/i.test(head) && /base64/i.test(head)) {
      return p.slice(hEnd + 4).replace(/[^A-Za-z0-9+/=]/g, '');
    }
    // 중첩 multipart
    if (/multipart\//i.test(head) && !head.includes(m[1])) { const inner = extractAttachment(p, depth + 1); if (inner) return inner; }
  }
  return '';
}

export async function ntsRoute(req, connect) {
  let body;
  try { body = await req.json(); } catch { return json({ error: '요청 형식 오류' }, 400); }
  const { id, pw } = body || {};
  if (!id || !pw) return json({ error: '네이버 아이디와 비밀번호가 필요해요' }, 400);
  const sock = connect({ hostname: 'imap.naver.com', port: 993 }, { secureTransport: 'on' });
  const im = new Imap(sock);
  try {
    await im.greet();
    try { await im.cmd('LOGIN ' + q(id) + ' ' + q(pw)); } catch (e) { return json({ error: '네이버 로그인 실패 (IMAP 사용 설정과 비밀번호를 확인하세요): ' + e.message }, 401); }
    await im.cmd('SELECT INBOX');
    if (Array.isArray(body.uids) && body.uids.length) {
      const out = [];
      for (const uid of body.uids.slice(0, 3).map((u) => parseInt(u, 10)).filter(Boolean)) {
        const r = await im.cmd('UID FETCH ' + uid + ' (INTERNALDATE BODY.PEEK[])');
        const dm = r.match(/INTERNALDATE "([^"]+)"/);
        const sm = r.match(/\r\nSubject:\s*([^\r\n]*(?:\r\n[ \t][^\r\n]*)*)/i);
        out.push({ uid, date: dm ? dm[1] : '', subject: sm ? decodeWords(sm[1].replace(/\r\n[ \t]/g, ' ')) : '', b64: extractAttachment(r) });
      }
      return json(out);
    }
    const days = Math.min(Math.max(parseInt(body.days, 10) || 7, 1), 400);
    const s = await im.cmd('UID SEARCH SINCE ' + sinceDate(days) + ' FROM "hometax.go.kr"');
    const uids = ((s.match(/\* SEARCH([\d ]*)/) || [])[1] || '').trim().split(/\s+/).filter(Boolean).map(Number);
    if (!uids.length) return json([]);
    const h = await im.cmd('UID FETCH ' + uids.join(',') + ' (INTERNALDATE BODY.PEEK[HEADER.FIELDS (SUBJECT)])');
    const list = [];
    for (const blk of h.split(/\r\n(?=\* \d+ FETCH)/)) {
      const um = blk.match(/UID (\d+)/); if (!um) continue;
      const dm = blk.match(/INTERNALDATE "([^"]+)"/);
      const sm = blk.match(/Subject:\s*([^\r\n]*(?:\r\n[ \t][^\r\n]*)*)/i);
      list.push({ uid: Number(um[1]), date: dm ? dm[1] : '', subject: sm ? decodeWords(sm[1].replace(/\r\n[ \t]/g, ' ')) : '' });
    }
    return json(list);
  } catch (e) {
    return json({ error: '메일 가져오기 실패: ' + (e && e.message) }, 500);
  } finally {
    try { await im.cmd('LOGOUT'); } catch { /* */ }
    try { sock.close(); } catch { /* */ }
  }
}

function json(o, status = 200) {
  return new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type' } });
}
