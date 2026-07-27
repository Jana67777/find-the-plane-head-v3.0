/*
 * 寻机头 · 本地"服务端" Service Worker
 * ------------------------------------------------------------
 * 作用：在纯静态托管（GitHub Pages）上，拦截前端发往
 *   POST ./api/game/session  和  POST ./api/game/reveal
 * 的请求，在 SW 内部生成棋盘、逐格判定并返回结果。
 *
 * 关键点（防作弊）：整张棋盘（机头/机身位置）只存在于本 SW 的内部状态里，
 * 并持久化到 Cache Storage；页面（React 状态 / DOM）永远只拿到"你点的这一格是什么"，
 * 拿不到未翻开格子的类型。这样浏览器控制台读取 React state / DOM 都读不到机头。
 *
 * 说明：这是"半服务端权威"——SW 仍运行在用户本机，能挡住控制台/DOM 层面的作弊，
 * 但挡不住直接改 sw.js 的高级用户。真·防作弊需要独立后端。
 * 挑战模式（challenge）交给前端用它已加载的正确地图走客户端逻辑（本 SW 返回 501）。
 */

const SESS_CACHE = 'ftph-sessions-v1';

// ---- 三种机型 (2=机头, 1=机身, 0=空) —— 与原游戏一致 ----
const SHAPES = [
  [[0,0,0,0,0],[0,0,2,0,0],[1,1,1,1,1],[0,0,1,0,0],[0,1,1,1,0]],
  [[0,0,2,0,0],[0,1,1,1,0],[1,0,1,0,1],[0,0,1,0,0],[0,1,1,1,0]],
  [[0,0,2,0,0],[0,0,1,0,0],[1,1,1,1,1],[0,0,1,0,0],[0,1,0,1,0]],
];

function rot90(m){
  const n = m.length, r = Array.from({length:n}, () => Array(n).fill(0));
  for (let i=0;i<n;i++) for (let j=0;j<n;j++) r[j][n-1-i] = m[i][j];
  return r;
}
function fits(types, shape, r0, c0, R, C){
  for (let i=0;i<5;i++) for (let j=0;j<5;j++) if (shape[i][j] !== 0){
    const r = r0+i, c = c0+j;
    if (r<0 || c<0 || r>=R || c>=C || types[r][c] !== 'empty') return false;
  }
  return true;
}
function place(types, shape, r0, c0){
  for (let i=0;i<5;i++) for (let j=0;j<5;j++){
    const v = shape[i][j];
    if (v !== 0){ types[r0+i][c0+j] = (v===2 ? 'head' : 'body'); }
  }
}
// 生成棋盘：返回 types[R][C]（'empty'|'body'|'head'）与机头总数
function genBoard(planeCounts, R, C){
  const types = Array.from({length:R}, () => Array(C).fill('empty'));
  const list = [];
  (Array.isArray(planeCounts) && planeCounts.length ? planeCounts : [1,1,1]).forEach((cnt, idx) => {
    if (idx < SHAPES.length) for (let k=0;k<cnt;k++) list.push(SHAPES[idx]);
  });
  let heads = 0;
  if (R>=5 && C>=5){
    for (const base of list){
      let placed = false, tries = 0;
      while (!placed && tries < 1000){
        const g = Math.floor(Math.random()*4);
        let sh = base; for (let t=0;t<g;t++) sh = rot90(sh);
        const r0 = Math.floor(Math.random()*(R-5+1));
        const c0 = Math.floor(Math.random()*(C-5+1));
        if (fits(types, sh, r0, c0, R, C)){ place(types, sh, r0, c0); heads++; placed = true; }
        tries++;
      }
    }
  }
  return { types, totalHeads: heads };
}

// ---- 会话持久化（SW 被系统回收重启后也不丢失当前对局）----
async function saveSession(id, state){
  const cache = await caches.open(SESS_CACHE);
  await cache.put(new Request('/__ftph_sess__/' + id),
    new Response(JSON.stringify(state), { headers: { 'Content-Type': 'application/json' } }));
}
async function loadSession(id){
  const cache = await caches.open(SESS_CACHE);
  const res = await cache.match(new Request('/__ftph_sess__/' + id));
  return res ? res.json() : null;
}

const json = (obj, status=200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });

async function handleSession(req){
  const body = await req.json().catch(() => ({}));
  const mode = body.mode || 'classic';
  // 挑战模式：本 SW 没有那张具体地图，返回 501 让前端走它自带的客户端回退（用已加载的正确地图）
  if (mode === 'challenge') return json({ error: 'challenge handled client-side' }, 501);

  const R = Math.max(5, body.gridRows || 16);
  const C = Math.max(5, body.gridCols || 16);
  const planeCounts = (Array.isArray(body.planeCounts) && body.planeCounts.length) ? body.planeCounts : [1,1,1];
  const { types, totalHeads } = genBoard(planeCounts, R, C);
  const id = (self.crypto && crypto.randomUUID)
    ? crypto.randomUUID()
    : ('s' + Date.now() + Math.random().toString(36).slice(2));
  // 注意：types（含机头位置）只存 SW 侧，绝不放进返回体
  await saveSession(id, { rows: R, cols: C, totalHeads, types, revealed: {}, foundHeads: 0, clicks: 0 });
  return json({ sessionId: id, rows: R, cols: C, totalHeads, planeCounts });
}

async function handleReveal(req){
  const { sessionId, row, col } = await req.json().catch(() => ({}));
  const st = await loadSession(sessionId);
  if (!st) return json({ error: 'no session' }, 404);

  const key = row + ',' + col;
  if (st.revealed[key]) return json({ alreadyRevealed: true });

  const type = (st.types[row] && st.types[row][col]) || 'empty';
  st.revealed[key] = type;
  st.clicks++;
  if (type === 'head') st.foundHeads++;
  const isWin = st.foundHeads >= st.totalHeads;

  const resp = {
    result: type,
    clicks: st.clicks,
    foundHeads: st.foundHeads,
    totalHeads: st.totalHeads,
    isGameOver: isWin,
    isWin: isWin,
  };
  if (isWin){
    // 游戏结束：把整张棋盘发回用于翻牌动画（此时公布已无所谓）
    const fb = [];
    for (let r=0;r<st.rows;r++) for (let c=0;c<st.cols;c++) fb.push({ row:r, col:c, type: st.types[r][c] });
    resp.finalBoard = fb;
  }
  await saveSession(sessionId, st);
  return json(resp);
}

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'POST') return;
  const path = new URL(req.url).pathname;
  if (path.endsWith('/api/game/session')) { e.respondWith(handleSession(req)); return; }
  if (path.endsWith('/api/game/reveal'))  { e.respondWith(handleReveal(req));  return; }
});
