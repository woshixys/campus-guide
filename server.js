/**
 * server.js —— Express 服务入口
 * 职责：
 *   1. 托管 public/ 下的前端 H5 页面（唯一入口 index.html，前台浏览 + 内嵌后台管理）
 *   2. 提供数据接口（轮播图、校区简介、美食、学习资料、社团、分类）
 *   3. 提供管理员登录鉴权与后台管理接口（增删改 + 审核）
 */
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const db = require('./db');

const app = express();

// ===================== 启动配置 =====================
// 1) 监听地址：固定绑定 0.0.0.0（所有网卡），不绑定 127.0.0.1，
//    以便局域网内其他设备（手机）能通过电脑 IP 直接访问。
const HOST = process.env.HOST || '0.0.0.0';
// 2) 端口：固定 3000，不随机分配；
//    仅在确实需要临时换端口时用环境变量覆盖（如 PORT=3100 node server.js）。
const PORT = process.env.PORT || 3000;
// 3) 不强制 HTTPS、不强制绑定域名：纯 HTTP 即可运行，
//    Cookie 按外层协议自适应（见 cookieOpts），不做重定向或域名校验。

// 信任反向代理（内网穿透 / 云服务器常在 HTTPS 终止后通过 X-Forwarded-Proto 转发）
// 开启后 req.secure / req.headers['x-forwarded-proto'] 才能正确反映外层协议
app.set('trust proxy', true);

// 管理员账号（可用环境变量覆盖，默认 admin / admin123）
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'admin123';

// 编辑密码（打破公网「纯只读」用）：外部网络用户在 /api/edit/unlock 输入正确后，
// 获得可编辑令牌（edit_sid Cookie），即可像同一局域网一样投稿 / 进入后台编辑。
// 可用环境变量覆盖；默认 campus2026。部署后请尽快改成自己的密码。
const EDIT_PASSWORD = process.env.EDIT_PASSWORD || 'campus2026';

// 登录会话：token -> { username, createdAt }（内存存储，重启失效，演示足够）
const sessions = new Map();
// 编辑解锁令牌：token -> createdAt（内存存储，重启失效）
const editTokens = new Map();

// 自适应 Cookie 策略：
//   - HTTPS 环境（内网穿透 / 云服务器反代通常为 https）：启用 sameSite=none + Secure，
//     使跨域访问也能携带登录态 Cookie（配合前端 credentials:'include'）。
//   - 纯 HTTP 环境（本机 / 局域网）：保持 sameSite=lax，避免 Secure 导致 Cookie 无法写入。
function cookieOpts(req) {
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const https = req.secure || proto === 'https';
  return https
    ? { httpOnly: true, sameSite: 'none', secure: true, maxAge: 1000 * 60 * 60 * 24 * 7, path: '/' }
    : { httpOnly: true, sameSite: 'lax', maxAge: 1000 * 60 * 60 * 24 * 7, path: '/' };
}

/* ------------------------------ 网络环境判定（局域网 / 外部） ------------------------------
 * 依据「浏览器访问时使用的 Host」判断：
 *   - 同一局域网（同一 Wi-Fi）：用户直接用电脑内网 IP / localhost 打开 → 允许完整浏览 + 在线编辑；
 *   - 外部网络（手机流量 / 校外 / 内网穿透隧道域名）：Host 为公网域名或地址 → 仅只读浏览，禁止写操作。
 * 前端（index.html 的 isPrivateHost）用同样逻辑独立判定并隐藏编辑 UI；后端此处做强制门禁（纵深防御）。
 */
function isPrivateHost(hostRaw) {
  if (!hostRaw) return false;
  const host = String(hostRaw).toLowerCase().split(':')[0].trim(); // 去掉端口
  if (host === 'localhost' || host === '[::1]' || host === '::1' || host.endsWith('.local')) return true;
  if (host.startsWith('fe80') || host.startsWith('fc') || host.startsWith('fd')) return true; // IPv6 链路/唯一本地
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false; // 非 IP（通常是公网域名）→ 视为外部
  const a = +m[1], b = +m[2];
  if (a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;           // 链路本地
  if (a === 172 && b >= 16 && b <= 31) return true;  // 私有
  if (a === 192 && b === 168) return true;           // 私有
  return false;
}

// 编辑解锁令牌校验：外部网络用户输入编辑密码解锁后，请求携带 edit_sid Cookie 即视为已授权
function hasEditToken(req) {
  const t = parseCookies(req).edit_sid;
  return !!(t && editTokens.has(t));
}

// 写操作门禁：同一局域网（无需密码）或外部网络已用编辑密码解锁 → 放行；否则 403 只读
function requireEdit(req, res, next) {
  if (isPrivateHost(req.headers.host || '') || hasEditToken(req)) return next();
  return res.status(403).json({ error: '当前为只读模式。编辑 / 投稿请在同一个 Wi-Fi（局域网）内访问，或输入编辑密码解锁。' });
}

/* ------------------------------ 实时同步（SSE） ------------------------------
 * 任意内容变更后向所有已连接的浏览端推送事件，前端据此静默刷新当前区块，
 * 实现「局域网内手机编辑提交 → 电脑页面无需手动刷新自动更新」。
 */
const sseClients = new Set();
function broadcastChange() {
  const payload = `data: ${JSON.stringify({ type: 'changed', ts: Date.now() })}\n\n`;
  sseClients.forEach((res) => { try { res.write(payload); } catch (e) { /* 客户端已断开 */ } });
}

// 放开 body 体积上限，便于接收 base64 图片
app.use(express.json({ limit: '15mb' }));

/* ------------------------------ CORS 跨域支持 ------------------------------
 * 目的：兼容「内网穿透」「云服务器 / CDN 反代」等跨网络、跨域访问场景。
 * 策略：
 *   - 镜像请求方 Origin（不是写死的 *），配合凭证(Cookie)使用，符合浏览器安全规范；
 *   - 允许凭证(include)，使跨域请求也能携带登录态 Cookie；
 *   - 处理 OPTIONS 预检，避免跨域写操作被浏览器拦截。
 * 同源（本机 / 局域网 / 同域云服务器）场景不受影响，功能完全不变。
 */
const CORS_METHODS = 'GET,HEAD,POST,PUT,DELETE,OPTIONS,PATCH';
const CORS_HEADERS = 'Content-Type,Authorization';

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin) {
    // 镜像来源，既支持任意跨域域名，又能与 credentials 共存（不能用 *）
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods', CORS_METHODS);
    res.setHeader('Access-Control-Allow-Headers', CORS_HEADERS);
    res.setHeader('Vary', 'Origin'); // 防止 CDN/浏览器按 * 错误缓存
  }
  // 预检请求直接放行
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

/* 实时同步钩子：所有「成功的写操作」自动广播 SSE 事件（登录/登出除外）。
 * 放在路由之前注册 res.on('finish')，无需在每个 handler 里手动调用 broadcastChange。 */
app.use((req, res, next) => {
  const method = req.method;
  const isMutating = method === 'POST' || method === 'PUT' || method === 'DELETE' || method === 'PATCH';
  const url = req.originalUrl.split('?')[0];
  const skip = url.endsWith('/api/admin/login') || url.endsWith('/api/admin/logout');
  if (isMutating && !skip) {
    res.on('finish', () => { if (res.statusCode >= 200 && res.statusCode < 300) broadcastChange(); });
  }
  next();
});

// 静态资源：前端 H5（唯一入口 index.html，内含前台浏览与内嵌后台管理）
app.use(express.static(path.join(__dirname, 'public')));

/* ------------------------------ 鉴权工具 ------------------------------ */

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie || '';
  raw.split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > -1) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}

function requireAuth(req, res, next) {
  const token = parseCookies(req).admin_sid;
  if (token && sessions.has(token)) return next();
  // 外部网络：若已用编辑密码解锁，亦放行（等同可编辑）
  if (hasEditToken(req)) return next();
  return res.status(401).json({ error: '未登录或登录已过期' });
}

// 所有 /api/admin/* 均走鉴权，除了登录 / 登出 / 当前状态
// 同一局域网（无需密码）或外部网络已用编辑密码解锁 → 允许后台编辑；否则 403 只读
app.use('/api/admin', (req, res, next) => {
  const path = req.originalUrl.split('?')[0];
  if (['/api/admin/login', '/api/admin/logout', '/api/admin/me'].includes(path)) return next();
  if (isPrivateHost(req.headers.host || '') || hasEditToken(req)) return requireAuth(req, res, next);
  return res.status(403).json({ error: '外部网络仅支持只读浏览，编辑请在同一个 Wi-Fi（局域网）内，或输入编辑密码解锁。' });
});

/* ------------------------------ 管理员登录 ------------------------------ */

app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body || {};
  if (username === ADMIN_USER && password === ADMIN_PASS) {
    const token = crypto.randomBytes(24).toString('hex');
    sessions.set(token, { username, createdAt: Date.now() });
    res.cookie('admin_sid', token, cookieOpts(req));
    return res.json({ ok: true, username });
  }
  return res.status(401).json({ error: '账号或密码错误' });
});

app.post('/api/admin/logout', (req, res) => {
  const token = parseCookies(req).admin_sid;
  if (token) sessions.delete(token);
  res.clearCookie('admin_sid', cookieOpts(req));
  res.json({ ok: true });
});

app.get('/api/admin/me', (req, res) => {
  const s = sessions.get(parseCookies(req).admin_sid);
  res.json({ authenticated: !!s, username: s ? s.username : null });
});

/* ------------------------------ 前端公共数据接口 ------------------------------ */

// 轮播图列表（首页）
app.get('/api/carousel', (req, res) => res.json({ items: db.getCarousel() }));

// 校区简介（首页）
app.get('/api/intro', (req, res) => res.json({ content: db.getIntro() }));

// 首页顶部大标题（首页）
app.get('/api/home-title', (req, res) => res.json({ title: db.getHomeTitle() }));

// 专业板块列表（学什么标签栏，公开）
app.get('/api/study-categories', (req, res) => res.json({ items: db.getStudyCategories() }));

// 玩乐分类列表（玩什么标签栏，公开）
app.get('/api/club-categories', (req, res) => res.json({ items: db.getClubCategories() }));

/* ------------------------------ 网络模式 / 实时事件（公开） ------------------------------ */

// 当前网络模式：lan（同一局域网，可编辑） / wan（外部网络，只读）
// editable：能否编辑 = 同一局域网，或外部网络但已用编辑密码解锁
app.get('/api/network-mode', (req, res) => {
  const lan = isPrivateHost(req.headers.host || '');
  res.json({ mode: lan ? 'lan' : 'wan', editable: lan || hasEditToken(req) });
});

// 外部网络「编辑密码」解锁：校验通过后下发 edit_sid Cookie（httpOnly，按协议自适应）
app.post('/api/edit/unlock', (req, res) => {
  const { password } = req.body || {};
  if (!password || password !== EDIT_PASSWORD) {
    return res.status(401).json({ error: '编辑密码错误' });
  }
  const token = crypto.randomBytes(24).toString('hex');
  editTokens.set(token, Date.now());
  res.cookie('edit_sid', token, cookieOpts(req));
  res.json({ ok: true });
});

// 锁定（退出编辑模式）：清除编辑令牌
app.post('/api/edit/lock', (req, res) => {
  const t = parseCookies(req).edit_sid;
  if (t) editTokens.delete(t);
  res.clearCookie('edit_sid', cookieOpts(req));
  res.json({ ok: true });
});

// SSE 实时事件流：内容变更时推送，前端静默刷新当前区块
app.get('/api/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': req.headers.origin || '*',
    'Access-Control-Allow-Credentials': 'true',
    Vary: 'Origin',
  });
  res.write('retry: 3000\n\n');
  sseClients.add(res);
  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch (e) { /* ignore */ } }, 25000);
  req.on('close', () => { clearInterval(ping); sseClients.delete(res); });
});


/* ------------------------------ 美食（吃什么）接口 ------------------------------ */

app.get('/api/foods', (req, res) => res.json({ items: db.getApprovedFoods() }));

// 学生投稿：写入待审核（仅同一局域网可提交）
app.post('/api/foods', requireEdit, (req, res) => {
  const { shop_name, location, intro, tags, images } = req.body || {};
  if (!shop_name || !String(shop_name).trim()) return res.status(400).json({ error: '店铺名称必填' });
  const id = db.addFood({
    shop_name: String(shop_name).trim(),
    location: location === '周边' ? '周边' : '校内',
    intro: String(intro || '').trim(),
    tags: Array.isArray(tags) ? tags.join(',') : String(tags || '').trim(),
    images: Array.isArray(images) ? images : [],
  });
  res.status(201).json({ id, status: 'pending' });
});

/* ------------------------------ 学习资料（学什么）接口 ------------------------------ */

app.get('/api/study', (req, res) => res.json({ items: db.getApprovedStudy() }));

// 学生投稿：写入待审核（仅同一局域网可提交）
app.post('/api/study', requireEdit, (req, res) => {
  const { title, intro, courses, directions, images, category } = req.body || {};
  if (!title || !String(title).trim()) return res.status(400).json({ error: '标题必填' });
  const id = db.addStudy({
    title: String(title).trim(),
    intro: String(intro || '').trim(),
    courses: Array.isArray(courses) ? courses.join(',') : String(courses || '').trim(),
    directions: Array.isArray(directions) ? directions.join(',') : String(directions || '').trim(),
    images: Array.isArray(images) ? images : [],
    category: String(category || '').trim(),
  });
  res.status(201).json({ id, status: 'pending' });
});

// 专业留言：任何人可读取 / 发布（无需编辑密码），发布后自动广播 SSE 实时刷新
app.get('/api/study/:id/comments', (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: '无效的专业' });
  const rows = db.getStudyComments(id).map((r) => ({ id: r.id, name: r.name, content: r.content, time: r.created_at }));
  res.json({ items: rows });
});

app.post('/api/study/:id/comments', (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: '无效的专业' });
  const { name, content } = req.body || {};
  if (!content || !String(content).trim()) return res.status(400).json({ error: '留言内容不能为空' });
  const cid = db.addStudyComment({ study_id: id, name: name || '匿名', content: String(content).trim() });
  res.status(201).json({ id: cid });
});

/* ------------------------------ 通用留言板（首页 / 专业 / 美食，任意网络可发） ------------------------------
 * 设计要点：
 *   1. POST /api/comments 完全公开——任何网络（同一 WiFi / 手机流量 / 公网域名）都能带昵称发布，
 *      不再受「局域网 / 编辑密码」门禁限制；
 *   2. GET /api/comments 公开读取；留言按 id 倒序（最新在前）；
 *   3. DELETE /api/admin/comments/:id 仍走 /api/admin 中间件——仅局域网或已解锁编辑密码的管理员可删；
 *   4. 任意成功的写操作都会触发全局 SSE 广播，所有打开页面的设备实时刷新（无需手动刷新）。
 */
// 轻量防刷：同一来源 IP 1.5 秒内最多发布 1 条留言
const commentRate = new Map();
function commentRateOk(ip) {
  const last = commentRate.get(ip) || 0;
  const now = Date.now();
  if (now - last < 1500) return false;
  commentRate.set(ip, now);
  return true;
}

app.get('/api/comments', (req, res) => {
  const type = String(req.query.type || 'home');
  const id = Number(req.query.id || 0);
  if (!['home', 'study', 'food'].includes(type)) return res.status(400).json({ error: '无效的留言对象' });
  const rows = db.getComments(type, id).map((r) => ({ id: r.id, name: r.name, content: r.content, time: r.created_at }));
  res.json({ items: rows });
});

// 公开发布：无局域网 / 编辑密码限制
app.post('/api/comments', (req, res) => {
  const { type, id, name, content } = req.body || {};
  if (!['home', 'study', 'food'].includes(type)) return res.status(400).json({ error: '无效的留言对象' });
  if (!content || !String(content).trim()) return res.status(400).json({ error: '留言内容不能为空' });
  if (String(content).length > 500) return res.status(400).json({ error: '留言内容过长（最多 500 字）' });
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  if (!commentRateOk(ip)) return res.status(429).json({ error: '留言太频繁，请稍候再试' });
  const cid = db.addComment({
    entity_type: type,
    entity_id: Number(id) || 0,
    name: name || '匿名',
    content: String(content).trim(),
  });
  res.status(201).json({ id: cid });
});

// 删除留言：仅「同一局域网」或「已用编辑密码解锁」的管理员可删；其他外部用户返回 403
app.delete('/api/comments/:id', (req, res) => {
  if (!isPrivateHost(req.headers.host || '') && !hasEditToken(req)) {
    return res.status(403).json({ error: '仅管理员可删除留言' });
  }
  db.deleteComment(Number(req.params.id));
  res.json({ ok: true });
});

/* ------------------------------ 社团 / 工作室（玩什么）接口 ------------------------------ */

app.get('/api/clubs', (req, res) => res.json({ items: db.getApprovedClubs() }));

// 学生投稿：写入待审核（仅同一局域网可提交）
app.post('/api/clubs', requireEdit, (req, res) => {
  const { org_name, intro, recruit, activities, contact, images, category } = req.body || {};
  if (!org_name || !String(org_name).trim()) return res.status(400).json({ error: '组织名称必填' });
  const id = db.addClub({
    org_name: String(org_name).trim(),
    intro: String(intro || '').trim(),
    recruit: String(recruit || '').trim(),
    activities: String(activities || '').trim(),
    contact: String(contact || '').trim(),
    images: Array.isArray(images) ? images : [],
    category: String(category || '').trim(),
  });
  res.status(201).json({ id, status: 'pending' });
});

/* =========================================================================
 *  管理员后台接口（均经鉴权中间件）
 * ========================================================================= */

/* ---------- 首页内容管理：轮播图 ---------- */

// 上传 / 新增轮播图
app.post('/api/admin/carousel', (req, res) => {
  const { image, caption } = req.body || {};
  if (!image) return res.status(400).json({ error: '图片必填' });
  const id = db.addCarousel({ image, caption: String(caption || '').trim() });
  res.status(201).json({ id });
});

// 删除轮播图
app.delete('/api/admin/carousel/:id', (req, res) => {
  db.deleteCarousel(Number(req.params.id));
  res.json({ ok: true });
});

// 调整轮播图顺序：body { ids: [id, ...] }（按目标顺序排列）
app.post('/api/admin/carousel/reorder', (req, res) => {
  const { ids } = req.body || {};
  if (!Array.isArray(ids)) return res.status(400).json({ error: 'ids 必填' });
  db.reorderCarousel(ids.map(Number));
  res.json({ ok: true });
});

// 修改校区简介
app.put('/api/admin/intro', (req, res) => {
  const { content } = req.body || {};
  if (!content || !String(content).trim()) return res.status(400).json({ error: '简介内容必填' });
  db.setIntro(String(content).trim());
  res.json({ ok: true });
});

// 修改首页顶部大标题
app.put('/api/admin/home-title', (req, res) => {
  const { title } = req.body || {};
  if (!title || !String(title).trim()) return res.status(400).json({ error: '标题不能为空' });
  db.setHomeTitle(String(title).trim());
  res.json({ ok: true });
});

/* ---------- 专业板块管理（study_categories） ---------- */

app.get('/api/admin/study-categories', (req, res) => res.json({ items: db.getStudyCategories() }));

app.post('/api/admin/study-categories', (req, res) => {
  const { name, cover, intro, sort } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: '板块名称必填' });
  try {
    const id = db.addStudyCategory({ name, cover: cover || '', intro: intro || '', sort: sort || 0 });
    res.status(201).json({ id });
  } catch (e) {
    res.status(400).json({ error: '板块名称已存在' });
  }
});

app.put('/api/admin/study-categories/:id', (req, res) => {
  const { name, cover, intro, sort } = req.body || {};
  const ok = db.updateStudyCategory(Number(req.params.id), { name, cover, intro, sort });
  if (!ok) return res.status(404).json({ error: '板块不存在' });
  res.json({ ok: true });
});

app.delete('/api/admin/study-categories/:id', (req, res) => {
  const ok = db.deleteStudyCategory(Number(req.params.id));
  if (!ok) return res.status(404).json({ error: '板块不存在' });
  res.json({ ok: true });
});

/* ---------- 玩乐分类管理（club_categories） ---------- */

app.get('/api/admin/club-categories', (req, res) => res.json({ items: db.getClubCategories() }));

app.post('/api/admin/club-categories', (req, res) => {
  const { name, sort } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: '分类名称必填' });
  try {
    const id = db.addClubCategory({ name, sort: sort || 0 });
    res.status(201).json({ id });
  } catch (e) {
    res.status(400).json({ error: '分类名称已存在' });
  }
});

app.put('/api/admin/club-categories/:id', (req, res) => {
  const { name, sort } = req.body || {};
  const ok = db.updateClubCategory(Number(req.params.id), { name, sort });
  if (!ok) return res.status(404).json({ error: '分类不存在' });
  res.json({ ok: true });
});

app.delete('/api/admin/club-categories/:id', (req, res) => {
  const ok = db.deleteClubCategory(Number(req.params.id));
  if (!ok) return res.status(404).json({ error: '分类不存在' });
  res.json({ ok: true });
});

/* ---------- 美食管理 ---------- */

app.get('/api/admin/foods', (req, res) => res.json({ items: db.getAllFoods() }));

// 手动新增（直接发布）
app.post('/api/admin/foods', (req, res) => {
  const { shop_name, location, intro, tags, images } = req.body || {};
  if (!shop_name || !String(shop_name).trim()) return res.status(400).json({ error: '店铺名称必填' });
  const id = db.addFood({
    shop_name: String(shop_name).trim(),
    location: location === '周边' ? '周边' : '校内',
    intro: String(intro || '').trim(),
    tags: Array.isArray(tags) ? tags.join(',') : String(tags || '').trim(),
    images: Array.isArray(images) ? images : [],
    status: (req.body && req.body.status === 'pending') ? 'pending' : 'approved',
  });
  res.status(201).json({ id });
});

app.put('/api/admin/foods/:id', (req, res) => {
  const ok = db.updateFood(Number(req.params.id), req.body || {});
  if (!ok) return res.status(404).json({ error: '美食不存在' });
  res.json({ ok: true });
});

app.delete('/api/admin/foods/:id', (req, res) => {
  db.deleteFood(Number(req.params.id));
  res.json({ ok: true });
});

app.post('/api/admin/foods/:id/approve', (req, res) => {
  db.approveFood(Number(req.params.id));
  res.json({ ok: true });
});

app.post('/api/admin/foods/:id/reject', (req, res) => {
  db.rejectFood(Number(req.params.id));
  res.json({ ok: true });
});

/* ---------- 学习资料管理 ---------- */

app.get('/api/admin/study', (req, res) => res.json({ items: db.getAllStudy() }));

// 手动新增（直接发布，需指定归属专业）
app.post('/api/admin/study', (req, res) => {
  const { title, intro, courses, directions, images, category } = req.body || {};
  if (!title || !String(title).trim()) return res.status(400).json({ error: '标题必填' });
  const id = db.addStudy({
    title: String(title).trim(),
    intro: String(intro || '').trim(),
    courses: Array.isArray(courses) ? courses.join(',') : String(courses || '').trim(),
    directions: Array.isArray(directions) ? directions.join(',') : String(directions || '').trim(),
    images: Array.isArray(images) ? images : [],
    category: String(category || '').trim(),
    status: (req.body && req.body.status === 'pending') ? 'pending' : 'approved',
  });
  res.status(201).json({ id });
});

app.put('/api/admin/study/:id', (req, res) => {
  const ok = db.updateStudy(Number(req.params.id), req.body || {});
  if (!ok) return res.status(404).json({ error: '资料不存在' });
  res.json({ ok: true });
});

app.delete('/api/admin/study/:id', (req, res) => {
  db.deleteStudy(Number(req.params.id));
  res.json({ ok: true });
});

app.post('/api/admin/study/:id/approve', (req, res) => {
  db.approveStudy(Number(req.params.id));
  res.json({ ok: true });
});

app.post('/api/admin/study/:id/reject', (req, res) => {
  db.rejectStudy(Number(req.params.id));
  res.json({ ok: true });
});

/* ---------- 社团 / 工作室管理 ---------- */

app.get('/api/admin/clubs', (req, res) => res.json({ items: db.getAllClubs() }));

// 手动新增（直接发布，需指定归属分类）
app.post('/api/admin/clubs', (req, res) => {
  const { org_name, intro, recruit, activities, contact, images, category } = req.body || {};
  if (!org_name || !String(org_name).trim()) return res.status(400).json({ error: '组织名称必填' });
  const id = db.addClub({
    org_name: String(org_name).trim(),
    intro: String(intro || '').trim(),
    recruit: String(recruit || '').trim(),
    activities: String(activities || '').trim(),
    contact: String(contact || '').trim(),
    images: Array.isArray(images) ? images : [],
    category: String(category || '').trim(),
    status: (req.body && req.body.status === 'pending') ? 'pending' : 'approved',
  });
  res.status(201).json({ id });
});

app.put('/api/admin/clubs/:id', (req, res) => {
  const ok = db.updateClub(Number(req.params.id), req.body || {});
  if (!ok) return res.status(404).json({ error: '社团不存在' });
  res.json({ ok: true });
});

app.delete('/api/admin/clubs/:id', (req, res) => {
  db.deleteClub(Number(req.params.id));
  res.json({ ok: true });
});

app.post('/api/admin/clubs/:id/approve', (req, res) => {
  db.approveClub(Number(req.params.id));
  res.json({ ok: true });
});

app.post('/api/admin/clubs/:id/reject', (req, res) => {
  db.rejectClub(Number(req.params.id));
  res.json({ ok: true });
});

// 启动：监听 HOST(默认 0.0.0.0)，允许局域网内其他设备（手机）通过电脑 IP 访问
app.listen(PORT, HOST, () => {
  console.log(`✅ 校园指南 H5 已启动（监听 0.0.0.0，允许手机/局域网访问）： http://localhost:${PORT}`);
  console.log(`   唯一入口：    http://localhost:${PORT}/`);
  console.log(`   手机访问：    用手机浏览器打开  http://<电脑局域网IP>:${PORT}/  （例如 192.168.x.x）`);
  console.log(`   接口： /api/carousel | /api/intro | /api/foods | /api/study | /api/clubs`);
  console.log(`   后台接口：    /api/admin/* （需登录，内嵌于 index.html）`);
});
