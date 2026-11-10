'use strict';

/**
 * 智能体层的离线自检：不打模型。
 * 覆盖：工具读取、去重、参数错误、模型输出解析、工具调用循环、
 *       学习项目归属与精读/外刊内容入口。
 * 项目链路需要真实写一次库验证，临时数据在 finally 里移进回收站。
 */

const fs = require('fs');
const path = require('path');
const ai = require('./ai');
const tools = require('./tools');
const db = require('./db');

let pass = 0;
let fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass += 1; console.log('  ✓ ' + name); }
  else { fail += 1; console.log('  ✗ ' + name + (extra ? '  — ' + extra : '')); }
}

(async () => {
  console.log('\n【工具 · 只读】');
  const ov = await tools.executeOne({ tool: 'get_overview' });
  ok('get_overview 可用', ov.ok === true, ov.summary);
  ok('概览里有未完成数', /未完成/.test(ov.summary), ov.summary);
  ok('概览结构可序列化', typeof JSON.stringify(ov.data) === 'string');

  const lt = await tools.executeOne({ tool: 'list_tasks', args: { scope: 'open', limit: 3 } });
  ok('list_tasks 可用', lt.ok === true, lt.summary);
  ok('limit 生效', lt.data.items.length <= 3);

  const lp = await tools.executeOne({ tool: 'list_plans' });
  ok('list_plans 可用', lp.ok === true);

  const tb = await tools.executeOne({ tool: 'list_textbooks' });
  ok('list_textbooks 可用', tb.ok === true, tb.summary);

  console.log('\n【工具 · 学习项目与阅读内容】');
  const projects = await tools.executeOne({ tool: 'list_projects' });
  ok('★ list_projects 可用', projects.ok === true && Array.isArray(projects.data), projects.summary);

  const articles = await tools.executeOne({ tool: 'list_articles' });
  ok('★ list_articles 可用', articles.ok === true && Array.isArray(articles.data), articles.summary);
  const readArticle = await tools.executeOne({
    tool: 'read_article',
    args: { article: (articles.data[0] || {}).title },
  });
  ok('★ read_article 能读正文与高亮',
    readArticle.ok === true && typeof readArticle.data.text === 'string'
    && Array.isArray(readArticle.data.highlights), readArticle.summary);

  const notes = await tools.executeOne({ tool: 'list_notes', args: { scope: 'all' } });
  ok('★ list_notes 能读精读/外刊问答',
    notes.ok === true && Array.isArray(notes.data.textbook) && Array.isArray(notes.data.article), notes.summary);

  const tbNotes = await tools.executeOne({ tool: 'read_textbook', args: { book: (tb.data[0] || {}).title } });
  ok('★ read_textbook 带上章节问答',
    tbNotes.ok === true && Array.isArray((tbNotes.data || {}).notes), tbNotes.summary);

  const spec = tools.TOOL_SPEC;
  ok('工具说明覆盖项目与外刊',
    ['create_project', 'add_course', 'list_articles', 'read_article', 'projectId']
      .every((x) => spec.includes(x)));
  const aiSrc = fs.readFileSync(path.join(__dirname, 'ai.js'), 'utf8');
  ok('★ 提示词禁止无工具时声称已创建', /只有工具真正执行成功/.test(aiSrc));
  ok('提示词要求提到项目时先查 id', /先用 list_projects 查到 id/.test(aiSrc));

  const badScope = await tools.executeOne({
    tool: 'create_tasks',
    args: { project: '绝对不存在的项目-zzz', tasks: [{ title: '不该被建出来-zzz' }] },
  });
  ok('★ 项目不存在时整批不建任务',
    badScope.ok === false && !/^建了/.test(badScope.summary), badScope.summary);

  console.log('\n【工具 · 项目归属写链路】');
  let probeProjectId = null;
  let probeTaskId = null;
  try {
    const made = await tools.executeOne({
      tool: 'create_project',
      args: { title: '自测·临时项目-zzz', courses: [{ title: '临时课程', totalEpisodes: 3 }] },
    });
    ok('★ create_project 能建项目与课程',
      made.ok === true && made.data.project.courses.length === 1, made.summary);
    probeProjectId = made.data.project.id;

    const again = await tools.executeOne({ tool: 'create_project', args: { title: '自测·临时项目-zzz' } });
    ok('同名项目不会重复建', again.ok === false, again.summary);

    const added = await tools.executeOne({
      tool: 'add_course',
      args: { projectId: probeProjectId, title: '第二门临时课' },
    });
    ok('add_course 能补课程', added.ok === true, added.summary);

    const madeTask = await tools.executeOne({
      tool: 'create_tasks',
      args: { projectId: probeProjectId, tasks: [{ title: '自测·归属任务-zzz' }] },
    }, { conversationId: 'selftest' });
    ok('★ create_tasks 会把任务归到项目',
      madeTask.ok === true && madeTask.data.projectId === probeProjectId, madeTask.summary);
    probeTaskId = (madeTask.data.created[0] || {}).id;
    const stored = probeTaskId ? await db.getOrNull('tasks', probeTaskId) : null;
    ok('★ 任务落库带项目与对话来源',
      Boolean(stored && stored.projectId === probeProjectId && stored.sourceConversationId === 'selftest'));
  } finally {
    if (probeTaskId) await db.remove('tasks', probeTaskId);
    if (probeProjectId) await db.remove('projects', probeProjectId);
  }

  console.log('\n【工具 · 边界】');
  const bad = await tools.executeOne({ tool: 'drop_database', args: {} });
  ok('未知工具被拒绝', bad.ok === false);

  const empty = await tools.executeOne({ tool: 'create_tasks', args: { tasks: [] } });
  ok('空任务列表被拒绝', empty.ok === false);

  // 已存在的未完成任务：必须被去重，不写库
  const dup = await tools.executeOne({ tool: 'create_tasks', args: { tasks: [{ title: '做一段数学一摸底' }] } });
  ok('同名任务被去重（没有重复创建）', dup.ok === false || /跳过/.test(dup.summary), dup.summary);
  ok('去重结果里没有新建', !(dup.data && dup.data.created && dup.data.created.length));

  const noTask = await tools.executeOne({ tool: 'update_task', args: { title: '这个任务不存在-xyz' } });
  ok('改不存在的任务会失败而不是乱写', noTask.ok === false);

  console.log('\n【模型输出解析】');
  const p1 = ai.parseAssistant('{"reply":"你好","problemCard":null,"proposal":null}', { id: 't' });
  ok('正常 JSON 解析', p1.reply === '你好' && p1.actions.length === 0);
  const p2 = ai.parseAssistant('直接说了一句话，没有 JSON', { id: 't' });
  ok('非 JSON 不崩，退化成纯文本', p2.reply.includes('直接说了一句话') && p2.raw === true);
  const p3 = ai.parseAssistant('{"reply":"查","actions":[{"tool":"get_overview","args":{}}]}', { id: 't' });
  ok('actions 被识别', p3.actions.length === 1 && p3.actions[0].tool === 'get_overview');
  const p4 = ai.parseAssistant('{"reply":"x","actions":[{"nope":1}]}', { id: 't' });
  ok('坏 action 被过滤', p4.actions.length === 0);

  console.log('\n【流式片段解析】');
  ok('半截 JSON 能抠出已生成的部分', ai.partialReply('{"kind":"answer","reply":"你今天还剩') === '你今天还剩');
  ok('转义引号不会把句子截断', ai.partialReply('{"reply":"他说\\"好\\"了') === '他说"好"了');
  ok('没有 reply 字段时返回空串', ai.partialReply('{"kind":"tool"') === '');

  console.log('\n【智能体循环】');
  let calls = 0;
  const fake = async () => {
    calls += 1;
    if (calls === 1) return JSON.stringify({ reply: '我先看看', actions: [{ tool: 'get_overview', args: {} }] });
    return JSON.stringify({ reply: '你有任务没做完。', problemCard: null, proposal: null });
  };
  const out = await ai.agentLoop({
    settings: {},
    messages: [{ role: 'user', content: '我现在有什么没做的' }],
    conversation: { id: 't' },
    callModel: fake,
  });
  ok('调用了一轮工具', out.meta.rounds === 2 && out.meta.tools.length === 1, JSON.stringify(out.meta));
  ok('工具名与结果被记下', out.meta.tools[0].tool === 'get_overview' && out.meta.tools[0].ok === true);
  ok('最终回复来自第二轮', out.reply === '你有任务没做完。');
  ok('没有把执行过的 action 再抛给上层', !out.actions || out.actions.length === 0);

  console.log('\n【轮数上限】');
  let n = 0;
  const always = async () => {
    n += 1;
    return JSON.stringify({ reply: '继续查', actions: [{ tool: 'list_tasks', args: { scope: 'open' } }] });
  };
  const capped = await ai.agentLoop({
    settings: {},
    messages: [{ role: 'user', content: 'x' }],
    conversation: { id: 't' },
    maxRounds: 2,
    callModel: always,
  });
  ok('超过上限会强制收尾', capped.meta.capped === true, JSON.stringify(capped.meta));
  ok('上限之后不再调用工具', capped.meta.rounds === 3 && n === 3);

  console.log('\n【模型配置 · 多供应商】');
  const mc = require('./model-config');
  const legacy = {
    aiProvider: 'real',
    baseUrl: 'https://example.com/v1',
    model: 'test-model',
    apiKey: 'sk-secret-xyz',
    ollamaUrl: 'http://127.0.0.1:11434',
    ollamaModel: 'local-model',
  };
  const migrated = mc.migrateLegacy(legacy);
  const s = { ...legacy, ...migrated };
  ok('★ 旧的单份配置迁移成两家供应商', s.modelProviders.length === 2, JSON.stringify(s.modelProviders.map((p) => p.type)));
  ok('迁移保留原有 Key 与模型名',
    s.modelProviders[0].apiKey === 'sk-secret-xyz' && s.modelProviders[0].models[0].name === 'test-model');
  const pub = mc.publicProviders(s.modelProviders);
  ok('★ 对外形状不含 Key 明文',
    !JSON.stringify(pub).includes('sk-secret-xyz') && pub[0].hasApiKey === true);
  const opts = mc.flatOptions(s);
  ok('下拉含规则引擎与两家供应商的模型',
    opts.length === 3 && opts[0].ref === mc.MOCK_REF, JSON.stringify(opts.map((o) => o.ref)));
  const realRef = `${s.modelProviders[0].id}/${s.modelProviders[0].models[0].id}`;
  const ollamaRef = `${s.modelProviders[1].id}/${s.modelProviders[1].models[0].id}`;
  ok('★ 按 ref 展开成 OpenAI 兼容配置',
    mc.resolve(s, realRef).settings.aiProvider === 'real'
    && mc.resolve(s, realRef).settings.model === 'test-model');
  ok('★ 按 ref 展开成 Ollama 配置',
    mc.resolve(s, ollamaRef).settings.aiProvider === 'ollama'
    && mc.resolve(s, ollamaRef).settings.ollamaModel === 'local-model');
  ok('★ 伪造的 ref 被判非法', !mc.isValidRef(s, 'mp-nope/mdl-nope'));
  ok('★ 非法 ref 回退默认模型而不是乱打地址',
    mc.resolve(s, 'mp-nope/mdl-nope').ref === s.defaultModelRef);
  ok('选规则引擎时不丢已保存的 Key',
    mc.resolve(s, mc.MOCK_REF).settings.aiProvider === 'mock' && s.apiKey === 'sk-secret-xyz');
  const sanitized = mc.sanitizeProviders([{
    id: s.modelProviders[0].id,
    name: '改名了',
    type: 'openai',
    baseUrl: s.modelProviders[0].baseUrl,
    models: s.modelProviders[0].models,
  }], s.modelProviders);
  ok('★ 前端不回传 Key 时保留已保存的 Key',
    sanitized[0].apiKey === 'sk-secret-xyz' && sanitized[0].name === '改名了');
  ok('新供应商不填 id 会生成合法 id',
    /^[A-Za-z0-9_-]+$/.test(mc.sanitizeProviders([{ name: 'x', type: 'openai', models: [] }], [])[0].id));
  ok('★ 删掉默认的供应商后 ref 自动失效',
    !mc.isValidRef({ ...s, modelProviders: [s.modelProviders[1]] }, s.defaultModelRef));

  console.log('\n【打包地基 · 未来同步契约】');
  const sc = require('./sync-contract');
  const desc = sc.describe('inst-test');
  ok('★ 契约明确写着当前不同步', desc.enabled === false && desc.instanceId === 'inst-test');
  ok('★ 契约列清已具备与待补的能力',
    desc.capabilities.independentDataDirs === true && desc.capabilities.remoteSyncService === false);
  const env = sc.envelope({ instanceId: 'inst-test', collections: { tasks: [1], projects: [] } });
  ok('★ 导出信封带实例身份且不改原有字段',
    env.sync.instanceId === 'inst-test' && env.sync.enabled === false
    && Array.isArray(env.tasks) && env.tasks[0] === 1);
  ok('★ 未来记录字段含版本与墓碑',
    ['originId', 'updatedAt', 'rev', 'deletedAt'].every((k) => k in sc.syncFields('x')));

  console.log(`\n通过 ${pass} 项，失败 ${fail} 项\n`);
  process.exit(fail ? 1 : 0);
})();
