/**
 * db.js —— SQLite 单文件数据库数据层
 * 使用 Node.js 内置 node:sqlite（无需额外编译的原生模块）
 * 数据库文件：项目根目录下的 data.db（单文件）
 */
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

// 数据库文件路径：支持通过环境变量 DB_PATH 覆盖（部署到 Render 等平台持久磁盘时指向挂载目录）
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data.db');

// 单文件数据库，不存在则自动创建
const db = new DatabaseSync(DB_PATH);

// 初始化表结构
db.exec(`
  CREATE TABLE IF NOT EXISTS carousel (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    image     TEXT    NOT NULL DEFAULT '',
    caption   TEXT    NOT NULL DEFAULT '',
    sort      INTEGER NOT NULL DEFAULT 0,
    created_at TEXT   NOT NULL DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS intro (
    id         INTEGER PRIMARY KEY CHECK (id = 1),
    content    TEXT    NOT NULL,
    updated_at TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
  );

  -- 首页顶部大标题（由后台控制，单行文本）
  CREATE TABLE IF NOT EXISTS home_title (
    id    INTEGER PRIMARY KEY CHECK (id = 1),
    title TEXT NOT NULL DEFAULT '创新创意设计艺术学院（香蜜校区）',
    updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS foods (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    shop_name  TEXT    NOT NULL,
    location   TEXT    NOT NULL DEFAULT '校内',   -- '校内' | '周边'
    intro      TEXT    NOT NULL DEFAULT '',
    tags       TEXT    NOT NULL DEFAULT '',        -- 逗号分隔
    images     TEXT    NOT NULL DEFAULT '[]',       -- JSON 数组，存 data URI
    status     TEXT    NOT NULL DEFAULT 'pending',  -- 'approved' | 'pending'
    created_at TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS study (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    title      TEXT    NOT NULL,                   -- 名称
    intro      TEXT    NOT NULL DEFAULT '',         -- 简介
    courses    TEXT    NOT NULL DEFAULT '',         -- 核心课程，逗号分隔
    directions TEXT    NOT NULL DEFAULT '',         -- 学习方向，逗号分隔
    images     TEXT    NOT NULL DEFAULT '[]',       -- JSON 数组，存 data URI
    category   TEXT    NOT NULL DEFAULT '',         -- 归属专业板块（= study_categories.name）
    status     TEXT    NOT NULL DEFAULT 'pending',  -- 'approved' | 'pending'
    created_at TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS clubs (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    org_name   TEXT    NOT NULL,                   -- 社团 / 部门 / 工作室 名称
    intro      TEXT    NOT NULL DEFAULT '',         -- 简介
    recruit    TEXT    NOT NULL DEFAULT '',         -- 招新要求
    activities TEXT    NOT NULL DEFAULT '',         -- 艺术活动介绍
    contact    TEXT    NOT NULL DEFAULT '',         -- 联系方式
    images     TEXT    NOT NULL DEFAULT '[]',       -- JSON 数组，存 data URI
    category   TEXT    NOT NULL DEFAULT '',         -- 归属分类（= club_categories.name）
    status     TEXT    NOT NULL DEFAULT 'pending',  -- 'approved' | 'pending'
    created_at TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
  );

  -- 专业板块（对应“学什么”），由后台管理
  CREATE TABLE IF NOT EXISTS study_categories (
    id    INTEGER PRIMARY KEY AUTOINCREMENT,
    name  TEXT NOT NULL UNIQUE,
    cover TEXT NOT NULL DEFAULT '',   -- 板块封面图，data URI
    intro TEXT NOT NULL DEFAULT '',   -- 板块简介
    sort  INTEGER NOT NULL DEFAULT 0
  );

  -- 玩乐分类（对应“玩什么”），由后台管理
  CREATE TABLE IF NOT EXISTS club_categories (
    id    INTEGER PRIMARY KEY AUTOINCREMENT,
    name  TEXT NOT NULL UNIQUE,
    sort  INTEGER NOT NULL DEFAULT 0
  );
`);

// 数据迁移：为 study 表补上 category（专业分类）字段，兼容已存在的旧数据库
function migrateStudyCategory() {
  const cols = db.prepare('PRAGMA table_info(study)').all().map((c) => c.name);
  if (!cols.includes('category')) {
    db.exec("ALTER TABLE study ADD COLUMN category TEXT NOT NULL DEFAULT ''");
    const map = {
      '工艺美术品设计': '工艺美术品设计',
      '数字媒体艺术': '视觉传达设计',
      '设计思维笔记 · 资料': '产品设计',
      '全国大学生数字艺术大赛': '工业设计',
    };
    const upd = db.prepare("UPDATE study SET category = ? WHERE title = ? AND category = ''");
    Object.entries(map).forEach(([title, cat]) => upd.run(cat, title));
  }
}

// 数据迁移：为 clubs 表补上 category（分类）字段，兼容已存在的旧数据库
function migrateClubsCategory() {
  const cols = db.prepare('PRAGMA table_info(clubs)').all().map((c) => c.name);
  if (!cols.includes('category')) {
    db.exec("ALTER TABLE clubs ADD COLUMN category TEXT NOT NULL DEFAULT ''");
    const map = {
      '非遗手作社': '社团',
      '视觉传达设计工作室': '社团',
      '学院学生会·宣传部': '学生会组织',
      '香蜜艺术季': '社团',
      '数字媒体创客空间': '社团',
    };
    const upd = db.prepare("UPDATE clubs SET category = ? WHERE org_name = ? AND category = ''");
    Object.entries(map).forEach(([name, cat]) => upd.run(cat, name));
  }
}

// 默认种子数据：首次启动时写入（仅当表为空）
function seedIfEmpty() {
  const carouselCount = db.prepare('SELECT COUNT(*) AS c FROM carousel').get().c;
  if (carouselCount === 0) {
    const inserts = db.prepare('INSERT INTO carousel (caption, sort) VALUES (?, ?)');
    const items = ['校区环境', '课堂实拍', '作品展览'];
    items.forEach((caption, i) => inserts.run(caption, i));
  }

  const introCount = db.prepare('SELECT COUNT(*) AS c FROM intro').get().c;
  if (introCount === 0) {
    const defaultIntro =
      '深圳职业技术大学创新创意设计艺术学院（香蜜校区）坐落于深圳福田香蜜湖畔，' +
      '是融合工艺美术、数字媒体、环境艺术与产品设计于一体的创新型艺术学府。' +
      '校区以“手作的温度 + 设计的思维”为育人理念，拥有开放式工作室、' +
      '材料实验室与常年开放的作品展厅，鼓励学生在真实项目中打磨审美与技艺。' +
      '这里既是课堂，也是通往创意产业的起点。';
    db.prepare(
      "INSERT INTO intro (id, content, updated_at) VALUES (1, ?, datetime('now','localtime'))"
    ).run(defaultIntro);
  }

  // 首页标题默认种子
  const htCount = db.prepare('SELECT COUNT(*) AS c FROM home_title').get().c;
  if (htCount === 0) {
    db.prepare(
      "INSERT INTO home_title (id, title, updated_at) VALUES (1, ?, datetime('now','localtime'))"
    ).run('创新创意设计艺术学院（香蜜校区）');
  }

  // 演示用：已发布（approved）的校内/周边美食，让列表不为空
  const foodCount = db.prepare('SELECT COUNT(*) AS c FROM foods').get().c;
  if (foodCount === 0) {
    const seedFoods = [
      ['香蜜一楼自选快餐', '校内', '品种多、出餐快，午晚餐人气王。', '性价比高,出餐快'],
      ['湖景奶茶铺', '周边', '校门口步行3分钟，招牌芋泥波波。', '奶茶,人气'],
      ['匠造手作面', '校内', '现擀面条，浇头现炒，汤头浓郁。', '现做,面食'],
      ['巷子里的麻辣烫', '周边', '自选称重，辣度可调，宵夜首选。', '麻辣,宵夜'],
    ];
    const ins = db.prepare(
      "INSERT INTO foods (shop_name, location, intro, tags, status) VALUES (?, ?, ?, ?, 'approved')"
    );
    seedFoods.forEach((f) => ins.run(f[0], f[1], f[2], f[3]));
  }

  // 演示用：已发布（approved）的学习内容，覆盖 专业 / 课程 / 资料 / 赛事，并按专业归类
  const studyCount = db.prepare('SELECT COUNT(*) AS c FROM study').get().c;
  if (studyCount === 0) {
    const seedStudy = [
      ['工艺美术品设计', '本院核心专业，强调手作器物与非遗创新，培养审美与工艺兼备的设计人才。', '造型基础,材料工艺,文创设计', '手作器物,非遗创新', '工艺美术品设计'],
      ['数字媒体艺术', '聚焦动态视觉与交互，课程横跨二维动效、三维建模与界面设计。', '动态图形,交互设计,三维建模', '视觉动效,UI设计', '视觉传达设计'],
      ['设计思维笔记 · 资料', '一份可复用的设计方法论笔记：从共情、定义到原型与测试的完整流程。', '设计史,构成基础', '设计方法论,作业干货', '产品设计'],
      ['全国大学生数字艺术大赛', '赛事资讯：每年一届，面向在校生征集数字艺术与文创作品，建议关注官网投稿节点。', '', '参赛指南,赛事资讯', '工业设计'],
    ];
    const insS = db.prepare(
      "INSERT INTO study (title, intro, courses, directions, category, status) VALUES (?, ?, ?, ?, ?, 'approved')"
    );
    seedStudy.forEach((s) => insS.run(s[0], s[1], s[2], s[3], s[4]));
  }

  // 演示用：已发布（approved）的社团 / 部门 / 工作室 / 活动
  const clubCount = db.prepare('SELECT COUNT(*) AS c FROM clubs').get().c;
  if (clubCount === 0) {
    const seedClubs = [
      ['非遗手作社', '聚焦掐丝珐琅、草木染与传统器物再造，定期在香蜜展厅办成果展。', '零基础可入，热爱手作、能坚持每周一次工坊活动即可。', '每月一次公开体验课，学期末举办“手作市集”义卖。', '微信 search：香蜜非遗手作社', '社团'],
      ['视觉传达设计工作室', '由专业教师带队，承接校内外真实VI与海报项目，主打品牌视觉。', '需提交一份作品集，熟悉 PS/AI 优先，招新每学期初。', '承办学院大型活动主视觉，作品多次入选省级展览。', '工作室地址：香蜜校区 A 栋 305', '社团'],
      ['学院学生会·宣传部', '学院官方宣传中枢，负责活动拍摄、推文与设计物料产出。', '细心、有责任心，会摄影或排版者优先，面向全院招新。', '负责迎新、艺术季、毕业展等全程视觉记录与传播。', '邮箱：sztu_design_pr@campus.edu', '学生会组织'],
      ['香蜜艺术季', '每年春季举办的校级艺术盛典，集合展览、工作坊与街头艺术。', '以志愿者身份参与，报名通道在活动前一个月开放。', '连续举办三届，单届吸引超 5000 人次观展。', '公众号：深职大设计艺术学院', '社团'],
      ['数字媒体创客空间', '开放式创客空间，配备动作捕捉与VR设备，主攻互动艺术。', '对新技术好奇即可加入，需参加一次安全与设备培训。', '孵化多支学生团队，作品亮相深圳文博会。', '预约系统：校园内网 creative.sztu.edu', '社团'],
    ];
    const insC = db.prepare(
      "INSERT INTO clubs (org_name, intro, recruit, activities, contact, category, status) VALUES (?, ?, ?, ?, ?, ?, 'approved')"
    );
    seedClubs.forEach((c) => insC.run(c[0], c[1], c[2], c[3], c[4], c[5]));
  }

  // 专业板块种子（前台“学什么”标签栏，由后台管理）
  const scCount = db.prepare('SELECT COUNT(*) AS c FROM study_categories').get().c;
  if (scCount === 0) {
    const seedCats = [
      ['服装设计', '服装结构设计、立体裁剪与成衣工艺，连接创意与穿戴。', 0],
      ['产品设计', '从用户研究到产品落地，涵盖家居、文具与智能硬件。', 1],
      ['工艺美术品设计', '手作器物与非遗创新，本院核心专业。', 2],
      ['视觉传达设计', '品牌视觉、海报与动态图形，信息的高效表达。', 3],
      ['工业设计', '产品形态、结构与 CMF，平衡功能与美学。', 4],
      ['时尚品设计', '配饰、箱包与潮流单品的设计与开发。', 5],
      ['环境艺术设计', '空间、展陈与景观，塑造人与环境的关系。', 6],
      ['专业八（占位）', '', 7],
      ['专业九（占位）', '', 8],
    ];
    const insCat = db.prepare('INSERT INTO study_categories (name, intro, sort) VALUES (?, ?, ?)');
    seedCats.forEach((c) => insCat.run(c[0], c[1], c[2]));
  }

  // 玩乐分类种子（前台“玩什么”标签栏，由后台管理）
  const ccCount = db.prepare('SELECT COUNT(*) AS c FROM club_categories').get().c;
  if (ccCount === 0) {
    const insCC = db.prepare('INSERT INTO club_categories (name, sort) VALUES (?, ?)');
    insCC.run('社团', 0);
    insCC.run('学生会组织', 1);
  }
}

// 数据迁移：study / clubs 表补 category 字段（兼容旧库），并给演示数据归类
migrateStudyCategory();
migrateClubsCategory();
seedIfEmpty();

/* ============================ 轮播图 / 简介 ============================ */

function getCarousel() {
  return db.prepare('SELECT id, image, caption, sort FROM carousel ORDER BY sort ASC, id ASC').all();
}

function getIntro() {
  const row = db.prepare('SELECT content FROM intro WHERE id = 1').get();
  return row ? row.content : '';
}

function setIntro(content) {
  db.prepare(
    "INSERT INTO intro (id, content, updated_at) VALUES (1, ?, datetime('now','localtime')) " +
      "ON CONFLICT(id) DO UPDATE SET content = excluded.content, updated_at = datetime('now','localtime')"
  ).run(content);
}

function addCarousel({ image, caption = '' }) {
  const info = db
    .prepare('INSERT INTO carousel (image, caption, sort) VALUES (?, ?, (SELECT COALESCE(MAX(sort),0)+1 FROM carousel))')
    .run(image, caption);
  return Number(info.lastInsertRowid);
}

function deleteCarousel(id) {
  db.prepare('DELETE FROM carousel WHERE id = ?').run(id);
}

// 调整轮播图顺序：ids 为按目标顺序排列的 id 数组
function reorderCarousel(ids) {
  const upd = db.prepare('UPDATE carousel SET sort = ? WHERE id = ?');
  ids.forEach((id, i) => upd.run(i, id));
}

/* ============================ 首页标题 ============================ */

function getHomeTitle() {
  const row = db.prepare('SELECT title FROM home_title WHERE id = 1').get();
  return row ? row.title : '创新创意设计艺术学院（香蜜校区）';
}

function setHomeTitle(title) {
  db.prepare(
    "INSERT INTO home_title (id, title, updated_at) VALUES (1, ?, datetime('now','localtime')) " +
      "ON CONFLICT(id) DO UPDATE SET title = excluded.title, updated_at = datetime('now','localtime')"
  ).run(title);
}

/* ============================ 美食（吃什么） ============================ */

function getApprovedFoods() {
  return db
    .prepare("SELECT id, shop_name, location, intro, tags, images FROM foods WHERE status = 'approved' ORDER BY id DESC")
    .all();
}

function getAllFoods() {
  return db
    .prepare("SELECT id, shop_name, location, intro, tags, images, status, created_at FROM foods ORDER BY id DESC")
    .all();
}

function getPendingFoods() {
  return db
    .prepare("SELECT id, shop_name, location, intro, tags, images, created_at FROM foods WHERE status = 'pending' ORDER BY id DESC")
    .all();
}

function getFood(id) {
  return db.prepare('SELECT * FROM foods WHERE id = ?').get(id);
}

function addFood({ shop_name, location, intro = '', tags = '', images = [], status = 'pending' }) {
  const info = db
    .prepare("INSERT INTO foods (shop_name, location, intro, tags, images, status) VALUES (?, ?, ?, ?, ?, ?)")
    .run(shop_name, location, intro, tags, JSON.stringify(images || []), status);
  return Number(info.lastInsertRowid);
}

function updateFood(id, fields = {}) {
  const cur = getFood(id);
  if (!cur) return false;
  const shop_name = fields.shop_name !== undefined ? String(fields.shop_name).trim() : cur.shop_name;
  const location = fields.location !== undefined ? (fields.location === '周边' ? '周边' : '校内') : cur.location;
  const intro = fields.intro !== undefined ? String(fields.intro).trim() : cur.intro;
  const tags = fields.tags !== undefined
    ? (Array.isArray(fields.tags) ? fields.tags.join(',') : String(fields.tags).trim())
    : cur.tags;
  const images = fields.images !== undefined ? JSON.stringify(fields.images || []) : cur.images;
  db.prepare('UPDATE foods SET shop_name=?, location=?, intro=?, tags=?, images=? WHERE id=?')
    .run(shop_name, location, intro, tags, images, id);
  return true;
}

function deleteFood(id) {
  db.prepare('DELETE FROM foods WHERE id = ?').run(id);
}

function approveFood(id) {
  db.prepare("UPDATE foods SET status = 'approved' WHERE id = ?").run(id);
}

function rejectFood(id) {
  // 驳回 = 丢弃该投稿
  db.prepare('DELETE FROM foods WHERE id = ?').run(id);
}

/* ============================ 学习资料（学什么） ============================ */

function getApprovedStudy() {
  return db
    .prepare("SELECT id, title, intro, courses, directions, images, category FROM study WHERE status = 'approved' ORDER BY id DESC")
    .all();
}

function getAllStudy() {
  return db
    .prepare("SELECT id, title, intro, courses, directions, images, category, status, created_at FROM study ORDER BY id DESC")
    .all();
}

function getPendingStudy() {
  return db
    .prepare("SELECT id, title, intro, courses, directions, images, category, created_at FROM study WHERE status = 'pending' ORDER BY id DESC")
    .all();
}

function getStudy(id) {
  return db.prepare('SELECT * FROM study WHERE id = ?').get(id);
}

function addStudy({ title, intro = '', courses = '', directions = '', images = [], category = '', status = 'pending' }) {
  const info = db
    .prepare("INSERT INTO study (title, intro, courses, directions, images, category, status) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(title, intro, courses, directions, JSON.stringify(images || []), String(category || ''), status);
  return Number(info.lastInsertRowid);
}

function updateStudy(id, fields = {}) {
  const cur = getStudy(id);
  if (!cur) return false;
  const title = fields.title !== undefined ? String(fields.title).trim() : cur.title;
  const intro = fields.intro !== undefined ? String(fields.intro).trim() : cur.intro;
  const courses = fields.courses !== undefined
    ? (Array.isArray(fields.courses) ? fields.courses.join(',') : String(fields.courses).trim())
    : cur.courses;
  const directions = fields.directions !== undefined
    ? (Array.isArray(fields.directions) ? fields.directions.join(',') : String(fields.directions).trim())
    : cur.directions;
  const images = fields.images !== undefined ? JSON.stringify(fields.images || []) : cur.images;
  const category = fields.category !== undefined ? String(fields.category || '') : cur.category;
  db.prepare('UPDATE study SET title=?, intro=?, courses=?, directions=?, images=?, category=? WHERE id=?')
    .run(title, intro, courses, directions, images, category, id);
  return true;
}

function deleteStudy(id) {
  db.prepare('DELETE FROM study WHERE id = ?').run(id);
}

function approveStudy(id) {
  db.prepare("UPDATE study SET status = 'approved' WHERE id = ?").run(id);
}

function rejectStudy(id) {
  db.prepare('DELETE FROM study WHERE id = ?').run(id);
}

/* ============================ 社团 / 工作室（玩什么） ============================ */

function getApprovedClubs() {
  return db
    .prepare("SELECT id, org_name, intro, recruit, activities, contact, images, category FROM clubs WHERE status = 'approved' ORDER BY id DESC")
    .all();
}

function getAllClubs() {
  return db
    .prepare("SELECT id, org_name, intro, recruit, activities, contact, images, category, status, created_at FROM clubs ORDER BY id DESC")
    .all();
}

function getPendingClubs() {
  return db
    .prepare("SELECT id, org_name, intro, recruit, activities, contact, images, category, created_at FROM clubs WHERE status = 'pending' ORDER BY id DESC")
    .all();
}

function getClub(id) {
  return db.prepare('SELECT * FROM clubs WHERE id = ?').get(id);
}

function addClub({ org_name, intro = '', recruit = '', activities = '', contact = '', images = [], category = '', status = 'pending' }) {
  const info = db
    .prepare("INSERT INTO clubs (org_name, intro, recruit, activities, contact, images, category, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(org_name, intro, recruit, activities, contact, JSON.stringify(images || []), String(category || ''), status);
  return Number(info.lastInsertRowid);
}

function updateClub(id, fields = {}) {
  const cur = getClub(id);
  if (!cur) return false;
  const org_name = fields.org_name !== undefined ? String(fields.org_name).trim() : cur.org_name;
  const intro = fields.intro !== undefined ? String(fields.intro).trim() : cur.intro;
  const recruit = fields.recruit !== undefined ? String(fields.recruit).trim() : cur.recruit;
  const activities = fields.activities !== undefined ? String(fields.activities).trim() : cur.activities;
  const contact = fields.contact !== undefined ? String(fields.contact).trim() : cur.contact;
  const images = fields.images !== undefined ? JSON.stringify(fields.images || []) : cur.images;
  const category = fields.category !== undefined ? String(fields.category || '') : cur.category;
  db.prepare('UPDATE clubs SET org_name=?, intro=?, recruit=?, activities=?, contact=?, images=?, category=? WHERE id=?')
    .run(org_name, intro, recruit, activities, contact, images, category, id);
  return true;
}

function deleteClub(id) {
  db.prepare('DELETE FROM clubs WHERE id = ?').run(id);
}

function approveClub(id) {
  db.prepare("UPDATE clubs SET status = 'approved' WHERE id = ?").run(id);
}

function rejectClub(id) {
  db.prepare('DELETE FROM clubs WHERE id = ?').run(id);
}

/* ============================ 专业板块（study_categories） ============================ */

function getStudyCategories() {
  return db.prepare('SELECT id, name, cover, intro, sort FROM study_categories ORDER BY sort ASC, id ASC').all();
}

function getStudyCategory(id) {
  return db.prepare('SELECT id, name, cover, intro, sort FROM study_categories WHERE id = ?').get(id);
}

function addStudyCategory({ name, cover = '', intro = '', sort = 0 }) {
  const info = db
    .prepare('INSERT INTO study_categories (name, cover, intro, sort) VALUES (?, ?, ?, ?)')
    .run(String(name).trim(), cover || '', intro || '', sort || 0);
  return Number(info.lastInsertRowid);
}

function updateStudyCategory(id, fields = {}) {
  const cur = getStudyCategory(id);
  if (!cur) return false;
  const name = fields.name !== undefined ? String(fields.name).trim() : cur.name;
  const cover = fields.cover !== undefined ? fields.cover : cur.cover;
  const intro = fields.intro !== undefined ? fields.intro : cur.intro;
  const sort = fields.sort !== undefined ? fields.sort : cur.sort;
  // 改名时同步 study 表中引用该分类的条目
  if (name !== cur.name) {
    db.prepare('UPDATE study SET category = ? WHERE category = ?').run(name, cur.name);
  }
  db.prepare('UPDATE study_categories SET name=?, cover=?, intro=?, sort=? WHERE id=?')
    .run(name, cover, intro, sort, id);
  return true;
}

function deleteStudyCategory(id) {
  const cur = getStudyCategory(id);
  if (!cur) return false;
  // 解除该板块下学习资料的归属
  db.prepare("UPDATE study SET category = '' WHERE category = ?").run(cur.name);
  db.prepare('DELETE FROM study_categories WHERE id = ?').run(id);
  return true;
}

/* ============================ 玩乐分类（club_categories） ============================ */

function getClubCategories() {
  return db.prepare('SELECT id, name, sort FROM club_categories ORDER BY sort ASC, id ASC').all();
}

function getClubCategory(id) {
  return db.prepare('SELECT id, name, sort FROM club_categories WHERE id = ?').get(id);
}

function addClubCategory({ name, sort = 0 }) {
  const info = db
    .prepare('INSERT INTO club_categories (name, sort) VALUES (?, ?)')
    .run(String(name).trim(), sort || 0);
  return Number(info.lastInsertRowid);
}

function updateClubCategory(id, fields = {}) {
  const cur = getClubCategory(id);
  if (!cur) return false;
  const name = fields.name !== undefined ? String(fields.name).trim() : cur.name;
  const sort = fields.sort !== undefined ? fields.sort : cur.sort;
  if (name !== cur.name) {
    db.prepare('UPDATE clubs SET category = ? WHERE category = ?').run(name, cur.name);
  }
  db.prepare('UPDATE club_categories SET name=?, sort=? WHERE id=?').run(name, sort, id);
  return true;
}

function deleteClubCategory(id) {
  const cur = getClubCategory(id);
  if (!cur) return false;
  db.prepare("UPDATE clubs SET category = '' WHERE category = ?").run(cur.name);
  db.prepare('DELETE FROM club_categories WHERE id = ?').run(id);
  return true;
}

module.exports = {
  db,
  // 轮播 / 简介
  getCarousel,
  getIntro,
  setIntro,
  addCarousel,
  deleteCarousel,
  reorderCarousel,
  // 首页标题
  getHomeTitle,
  setHomeTitle,
  // 美食
  getApprovedFoods,
  getAllFoods,
  getPendingFoods,
  getFood,
  addFood,
  updateFood,
  deleteFood,
  approveFood,
  rejectFood,
  // 学习资料
  getApprovedStudy,
  getAllStudy,
  getPendingStudy,
  getStudy,
  addStudy,
  updateStudy,
  deleteStudy,
  approveStudy,
  rejectStudy,
  // 社团 / 工作室
  getApprovedClubs,
  getAllClubs,
  getPendingClubs,
  getClub,
  addClub,
  updateClub,
  deleteClub,
  approveClub,
  rejectClub,
  // 专业板块
  getStudyCategories,
  getStudyCategory,
  addStudyCategory,
  updateStudyCategory,
  deleteStudyCategory,
  // 玩乐分类
  getClubCategories,
  getClubCategory,
  addClubCategory,
  updateClubCategory,
  deleteClubCategory,
};
