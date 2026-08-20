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

  -- 专业留言（对应“学什么”每个专业详情底部的留言区）
  CREATE TABLE IF NOT EXISTS study_comments (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    study_id   INTEGER NOT NULL,
    name       TEXT    NOT NULL DEFAULT '匿名',
    content    TEXT    NOT NULL,
    created_at TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
  );

  -- 通用留言板（首页 / 各专业详情 / 各美食详情 共用）
  CREATE TABLE IF NOT EXISTS comments (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_type TEXT NOT NULL,   -- 'home' | 'study' | 'food'
    entity_id   INTEGER NOT NULL DEFAULT 0,
    name        TEXT NOT NULL DEFAULT '匿名',
    content     TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  );

  CREATE INDEX IF NOT EXISTS idx_comments_entity ON comments(entity_type, entity_id, id);
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

  // 校内 / 周边美食（吃什么板块，16 家官方店铺，已发布、配图引用 food_imgs 目录）
  const foodCount = db.prepare('SELECT COUNT(*) AS c FROM foods').get().c;
  if (foodCount === 0) {
    const seedFoods = [
      { name: '香蜜一楼自选快餐', loc: '校内', intro: '品种多、出餐快，午晚餐人气王。', tags: '性价比高,出餐快', imgs: [] },
      { name: '湖景奶茶铺', loc: '周边', intro: '校门口步行3分钟，招牌芋泥波波。', tags: '奶茶,人气', imgs: [] },
      { name: '匠造手作面', loc: '校内', intro: '现擀面条，浇头现炒，汤头浓郁。', tags: '现做,面食', imgs: [] },
      { name: '巷子里的麻辣烫', loc: '周边', intro: '自选称重，辣度可调，宵夜首选。', tags: '麻辣,宵夜', imgs: [] },
      { name: '洪大厨鸡煲', loc: '周边', intro: '深圳排名第1的炭炉鸡煲。招牌石橄榄鸡煲，汤底清亮透着草本清香；重口味必点香辣鸡煲。营业到凌晨6:30，宵夜党友好。', tags: '鸡煲,炭炉,宵夜,聚餐', imgs: ['img_06', 'img_04', 'img_09', 'img_10', 'img_18'] },
      { name: '张姐烤肥牛', loc: '周边', intro: '深圳烤肥牛老字号。招牌肥牛配秘制酸菜一起烤，酸菜吸饱牛油，酸爽解腻。最后来盘生蚝压轴。大口吃肉大口喝酒。', tags: '烤肉,烤肥牛,老字号,聚餐', imgs: ['img_07'] },
      { name: '潮泰牛肉火锅', loc: '周边', intro: '开了34年的潮汕牛肉老字号。牛肉每天分批到店，明档现切。招牌顶鲜肥牛只涮9秒，入口满是奶香。五花趾爽脆弹牙。', tags: '潮汕牛肉,火锅,现切,老字号', imgs: ['img_08'] },
      { name: '欧记大排档·江西景德菜', loc: '周边', intro: '深圳江西菜排名第1。全透明厨房，盘盘猛火爆炒。招牌小炒黄牛肉、南昌拌粉，辣劲十足，下饭又刺激。聚餐宵夜小酌都很合适。', tags: '江西菜,辣,下饭,宵夜', imgs: ['img_15'] },
      { name: '念东北铁锅炖', loc: '周边', intro: '东北铁锅炖大鹅，大铁锅往桌上一支，灶火一点，热乎劲儿上来了。大鹅肉质紧实，慢火炖到酥烂入味。锅边贴一圈玉米饼蘸浓汤吃。等锅开先来份麻酱拉皮。', tags: '东北菜,铁锅炖,大鹅,聚餐', imgs: ['img_01'] },
      { name: '牧香云', loc: '周边', intro: '云南菌子鸡锅专门店。招牌黑松露羊肚菌炖鸡，羊肚菌吸饱土鸡汤精华，一口满口鲜汁。菌菇拼盘入汤，傣味香茅草烤鱼外焦里嫩。地标凉米线酸辣开胃。', tags: '云南菜,菌子,鸡汤,养生', imgs: ['img_13', 'img_14'] },
      { name: '俗器·贵州大牌档', loc: '周边', intro: '车公庙烧烤烤串热门榜TOP1。老板是土生土长贵阳人。招牌贵州炭火烤鸡，金黄诱人，焦香Q弹，自带烟熏炭火气息。搭配毛辣果、小米辣、青柠调制的秘制蘸酱，酸爽非常。营业到凌晨3点。', tags: '贵州菜,烧烤,烤鸡,宵夜', imgs: ['img_03', 'img_11', 'img_16'] },
      { name: 'Lapower泰式热炒小馆', loc: '周边', intro: '藏在泰然公寓楼下，像把曼谷夜市路边摊搬到家门口。必点打抛猪肉饭，肉碎和香料镬气爆炒，咸鲜微辣超级下饭。冬阴功和咖喱鸡也很浓郁。搭配泰式奶茶，地道东南亚街头味。', tags: '泰式,热炒,打抛饭,奶茶', imgs: ['img_17'] },
      { name: '丁叮小排档', loc: '周边', intro: '车公庙开了5年的江湖菜大排档。招牌大红盘尖椒鸡，超大一盘，鸡肉干香入味，裹满辣味，越吃越过瘾。火爆三脆、传统毛血旺也是必点。菜量大，镬气和下饭就是精髓。', tags: '江湖菜,辣,下饭,聚餐', imgs: ['img_12', 'img_02'] },
      { name: '罗大厨肥肠煲', loc: '周边', intro: '车公庙湘菜TOP2，开了十几年的排队神店。招牌肥肠煲，肥肠处理干净，大火煸炒后慢火煨煮，口感软糯带韧劲。小炒黄牛肉、干锅鱼籽鱼泡、干锅黄骨鱼都是下饭硬菜。营业到凌晨3点。', tags: '湘菜,肥肠,辣,下饭', imgs: ['img_05'] },
      { name: '润园四季椰子鸡火锅', loc: '周边', intro: '椰子鸡火锅，汤底清甜，鸡肉嫩滑。一级腊味煲仔饭是必点主食，锅巴金黄酥脆。适合朋友聚餐，人均约106元。', tags: '椰子鸡,火锅,煲仔饭,聚餐', imgs: [] },
      { name: '汶和记粥底火锅', loc: '周边', intro: '粥底涮海鲜的温和火锅。绵滑粥底做锅底，先喝一碗鲜粥，再涮入鲜活海鲜，滋味直达天灵盖。高压锅五指毛桃焗鸡也是特色，鸡肉嫩滑，药香扑鼻。人均约116元。', tags: '粥底火锅,海鲜,养生,特色', imgs: [] },
    ];
    const ins = db.prepare(
      "INSERT INTO foods (shop_name, location, intro, tags, images, status) VALUES (?, ?, ?, ?, ?, ?)"
    );
    seedFoods.forEach((f) => {
      const imgs = (f.imgs || []).map((x) => '/food_imgs/' + x + '.jpg');
      ins.run(f.name, f.loc, f.intro, f.tags, JSON.stringify(imgs), 'approved');
    });
  }

  // 本院官方专业（学什么板块，8 个，已发布、无图片）
  const studyCount = db.prepare('SELECT COUNT(*) AS c FROM study').get().c;
  if (studyCount === 0) {
    const seedStudy = [
      ['服装与服饰设计', '培养具备扎实服装专业理论、款式开发与工艺制作能力，把握时尚潮流趋势，可从事服装设计、版型开发、品牌运营的创新型人才。', '服装设计表现技法,服装CAD,立体裁剪,服装材料学,针织设计,配饰设计,服装工艺实训', '服装设计师,制版师,陈列搭配师,服装电商运营,时尚新媒体策划', '专科专业'],
      ['产品艺术设计', '培养掌握现代产品设计方法，兼具创新思维与人因工程知识，可从事消费产品、文创产品、交互界面设计的复合型设计人才。', '产品手绘,CAID三维设计,产品工学结构,交互设计,人因专题设计,文创产品开发', '产品设计师,交互设计师,文创策划,用户体验设计师,产品企划', '专科专业'],
      ['工艺美术品设计', '传承传统工艺，结合现代设计手法，从事非遗文创、工艺品研发、饰品设计、手工艺术创作的专业人才。', '陶瓷工艺设计与制作,玻璃工艺设计与制作,金属工艺设计与制作,纤维工艺设计与制作,漆艺设计与应用,工艺品专题设计', '工艺美术设计师,文创产品开发,非遗传承设计,手工艺术创作,工艺品营销管理', '专科专业'],
      ['视觉传达设计', '培养精通品牌视觉、平面广告、新媒体视觉、展示空间设计，可从事品牌全案视觉设计的人才。', 'VI品牌设计,海报包装,书籍创意设计,界面交互设计,商业广告设计', '品牌设计师,新媒体美工,电商视觉设计师,会展展示设计师,商业插画师', '专科专业'],
      ['首饰设计与工艺', '培养具有首饰创意设计与珠宝首饰鉴定能力，能够从事珠宝首饰设计、制作工艺、珠宝鉴定相关工作的珠宝首饰高技能复合型人才。', '首饰设计表现技法,首饰3D制图,首饰起板,宝玉石基础,钻石分级,首饰创意专题设计', '首饰设计师,首饰工艺师,珠宝鉴定师,珠宝产品定制师,珠宝门店运营管理', '专科专业'],
      ['环境艺术设计', '掌握室内空间、景观园林、家具陈设设计，可从事家装、工装、景观项目设计落地的综合型人才。', '室内设计制图,3dsMax空间表现,景观专题设计,施工工艺,家具陈设设计', '室内设计师,景观设计师,软装陈设师,工程绘图员', '专科专业'],
      ['工业设计', '面向智能硬件、家电装备行业，掌握工业产品结构、形态设计、用户体验研发，培养高端工业设计技术人才。', '工业设计工程基础,三维参数化建模,快速原型制作,产品形态语义,材料与工艺', '工业产品设计师,智能硬件研发,设计管理,用户研究工程师', '本科专业'],
      ['时尚品设计', '聚焦箱包、首饰、潮流配饰等时尚衍生品设计，贴合大湾区时尚产业，培养时尚产品开发与品牌运营人才。', '时尚配饰设计,箱包结构设计,潮流趋势分析,时尚品牌策划', '时尚配饰设计师,箱包产品开发,轻奢品牌设计,时尚买手', '本科专业'],
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

  // 专业板块种子（前台“学什么”标签栏：专科 / 本科 两个层次）
  const scCount = db.prepare('SELECT COUNT(*) AS c FROM study_categories').get().c;
  if (scCount === 0) {
    const seedCats = [
      ['专科专业', '专科层次招生专业', 0],
      ['本科专业', '职业本科层次招生专业', 1],
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
migrateFoodFields();
seedIfEmpty();
migrateComments();

// 数据迁移：为 foods 表补上详细字段（菜系 / 人均 / 地址 / 推荐菜品 / 点评），兼容已存在的旧数据库
function migrateFoodFields() {
  const cols = db.prepare('PRAGMA table_info(foods)').all().map((c) => c.name);
  const need = ['cuisine', 'avg_cost', 'address', 'recommend', 'review'];
  need.forEach((c) => {
    if (!cols.includes(c)) {
      db.exec(`ALTER TABLE foods ADD COLUMN ${c} TEXT NOT NULL DEFAULT ''`);
    }
  });
}

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
    .prepare("SELECT id, shop_name, location, intro, tags, images, cuisine, avg_cost, address, recommend, review FROM foods WHERE status = 'approved' ORDER BY id DESC")
    .all();
}

function getAllFoods() {
  return db
    .prepare("SELECT id, shop_name, location, intro, tags, images, cuisine, avg_cost, address, recommend, review, status, created_at FROM foods ORDER BY id DESC")
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

function addFood({ shop_name, location, intro = '', tags = '', images = [], cuisine = '', avg_cost = '', address = '', recommend = '', review = '', status = 'pending' }) {
  const info = db
    .prepare("INSERT INTO foods (shop_name, location, intro, tags, images, cuisine, avg_cost, address, recommend, review, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(shop_name, location, intro, tags, JSON.stringify(images || []), String(cuisine || ''), String(avg_cost || ''), String(address || ''), String(recommend || ''), String(review || ''), status);
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
  const cuisine = fields.cuisine !== undefined ? String(fields.cuisine || '').trim() : cur.cuisine;
  const avg_cost = fields.avg_cost !== undefined ? String(fields.avg_cost || '').trim() : cur.avg_cost;
  const address = fields.address !== undefined ? String(fields.address || '').trim() : cur.address;
  const recommend = fields.recommend !== undefined ? String(fields.recommend || '').trim() : cur.recommend;
  const review = fields.review !== undefined ? String(fields.review || '').trim() : cur.review;
  db.prepare('UPDATE foods SET shop_name=?, location=?, intro=?, tags=?, images=?, cuisine=?, avg_cost=?, address=?, recommend=?, review=? WHERE id=?')
    .run(shop_name, location, intro, tags, images, cuisine, avg_cost, address, recommend, review, id);
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

/* ============================ 专业留言（study_comments） ============================ */

function getStudyComments(studyId) {
  return db
    .prepare('SELECT id, name, content, created_at FROM study_comments WHERE study_id = ? ORDER BY id ASC')
    .all(studyId);
}

function addStudyComment({ study_id, name = '匿名', content }) {
  const info = db
    .prepare('INSERT INTO study_comments (study_id, name, content) VALUES (?, ?, ?)')
    .run(Number(study_id), String(name || '匿名').trim().slice(0, 20), String(content).trim());
  return Number(info.lastInsertRowid);
}

/* ============================ 通用留言板（comments） ============================ */

function getComments(entity_type, entity_id) {
  return db
    .prepare('SELECT id, name, content, created_at FROM comments WHERE entity_type=? AND entity_id=? ORDER BY id DESC')
    .all(entity_type, entity_id);
}

function addComment({ entity_type, entity_id = 0, name = '匿名', content }) {
  const info = db
    .prepare('INSERT INTO comments (entity_type, entity_id, name, content) VALUES (?, ?, ?, ?)')
    .run(String(entity_type), Number(entity_id) || 0, String(name || '匿名').trim().slice(0, 20), String(content).trim());
  return Number(info.lastInsertRowid);
}

function getComment(id) {
  return db.prepare('SELECT * FROM comments WHERE id=?').get(id);
}

function deleteComment(id) {
  db.prepare('DELETE FROM comments WHERE id=?').run(id);
}

// 旧的专业留言（study_comments）一次性迁移到通用留言板，避免历史留言丢失
function migrateComments() {
  const cols = db.prepare('PRAGMA table_info(comments)').all().map((c) => c.name);
  if (!cols.length) return;
  const exists = db.prepare("SELECT COUNT(*) AS c FROM comments WHERE entity_type='study'").get().c;
  if (exists) return;
  const old = db.prepare('SELECT study_id, name, content, created_at FROM study_comments').all();
  if (!old.length) return;
  const ins = db.prepare("INSERT INTO comments (entity_type, entity_id, name, content, created_at) VALUES ('study', ?, ?, ?, ?)");
  old.forEach((r) => ins.run(r.study_id, r.name, r.content, r.created_at));
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
  // 专业留言
  getStudyComments,
  addStudyComment,
  // 通用留言板
  getComments,
  addComment,
  getComment,
  deleteComment,
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
