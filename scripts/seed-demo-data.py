# -*- coding: utf-8 -*-
"""生成一份干净的演示数据，专门用来截提交文档的配图。

只写进指定目录（默认 .demo-data），不碰真实 data/。
"""
import json
import os
import shutil
import sys
from datetime import datetime, timedelta

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, '.demo-data'))

TODAY = datetime(2026, 11, 10, 9, 30, 0)


def iso(dt):
    return dt.strftime('%Y-%m-%dT%H:%M:%S.000Z')


def day(offset):
    return (TODAY + timedelta(days=offset)).strftime('%Y-%m-%d')


def write(coll, rec):
    d = os.path.join(DATA, coll)
    os.makedirs(d, exist_ok=True)
    with open(os.path.join(d, rec['id'] + '.json'), 'w', encoding='utf-8') as f:
        json.dump(rec, f, ensure_ascii=False, indent=2)


# ---------------------------------------------------------------- 长期计划
PLANS = [
    ('plan-20261020-1a2b3c4d', '考研初试 · 数学 + 英语', '十二月下旬考试，先把这两门拉起来', 'active', '2026-10-20', '2026-12-20'),
    ('plan-20261025-5e6f7a8b', '408 专业课二轮', '按章过，重点补数据结构和操作系统', 'active', '2026-10-25', '2026-12-15'),
    ('plan-20261101-9c0d1e2f', '毕业设计 · 开题', '十一月内把开题报告定稿', 'active', '2026-11-01', '2026-11-30'),
]
for pid, title, desc, status, start, end in PLANS:
    write('plans', {
        'id': pid, 'title': title, 'description': desc, 'status': status,
        'startDate': start, 'endDate': end,
        'createdAt': iso(TODAY - timedelta(days=20)), 'updatedAt': iso(TODAY - timedelta(days=2)),
    })

PLAN_KAOYAN = PLANS[0][0]
PLAN_408 = PLANS[1][0]
PLAN_THESIS = PLANS[2][0]

# ---------------------------------------------------------------- 学习项目
write('projects', {
    'id': 'proj-20261020-aaaa1111',
    'title': '考研 408 · 计算机学科专业基础',
    'description': '数据结构、计算机网络、操作系统、计算机组成原理四门一起过第二轮。',
    'courses': ['数据结构', '计算机网络', '操作系统', '计算机组成原理'],
    'createdAt': iso(TODAY - timedelta(days=21)),
    'updatedAt': iso(TODAY - timedelta(days=1)),
})
write('projects', {
    'id': 'proj-20261101-bbbb2222',
    'title': '毕业设计 · 校园二手书流转平台',
    'description': '开题、文献综述、原型实现，一步步来。',
    'courses': ['文献综述', '原型实现', '论文写作'],
    'createdAt': iso(TODAY - timedelta(days=9)),
    'updatedAt': iso(TODAY - timedelta(days=3)),
})

# ---------------------------------------------------------------- 待办
TASKS = [
    # (标题, 说明, 状态, 计划日, 截止日, planId, 完成时间偏移)
    ('精读《计算机网络》第 3 章：数据链路层',
     '重点看差错检测和 CSMA/CD 那两节，看完能用一句话说清「为什么要有帧」。', 'todo', day(0), None, PLAN_408, None),
    ('数据结构 · 二叉树的三种遍历手写一遍',
     '不看代码，白纸上写前序、中序、后序，写完再对答案。', 'done', day(0), None, PLAN_408, -3),
    ('英语真题 2019 阅读 Text 2 精读',
     '先做题，再逐句翻译，把不认识的词抄进生词本。', 'todo', day(0), None, PLAN_KAOYAN, None),
    ('高数 · 中值定理证明题 5 道',
     '罗尔、拉格朗日、柯西各挑一两道，重点练辅助函数的构造。', 'todo', day(0), None, PLAN_KAOYAN, None),
    ('背单词 150 个',
     '早上一轮新的，晚上把昨天的过一遍。', 'done', day(0), None, PLAN_KAOYAN, -6),
    ('计算机网络 · 课后习题 3-12 到 3-18',
     '做完对着答案改，错题标出来留给周末复盘。', 'todo', day(0), day(1), PLAN_408, None),
    ('线性代数 · 特征值与特征向量',
     '把求特征多项式的套路走顺，做三道真题。', 'todo', day(0), None, PLAN_KAOYAN, None),
    ('整理操作系统 · 进程调度笔记',
     'FCFS、SJF、时间片轮转、多级反馈队列，画一张对比表。', 'todo', day(1), None, PLAN_408, None),
    ('毕设开题报告：把研究背景写满一页',
     '先不管写得好不好，先把字数堆够，明天再删。', 'todo', day(2), day(3), PLAN_THESIS, None),
    ('把开题提纲发给导师',
     '附上三篇参考文献，问一下方向要不要收窄。', 'todo', day(3), day(4), PLAN_THESIS, None),
    ('408 真题 2018 年选择题',
     '限时 40 分钟，做完只统计正确率，先不改错题。', 'todo', day(4), None, PLAN_408, None),
    ('英语作文模板整理',
     '把大作文的开头、过渡、结尾各准备两套句式。', 'todo', day(5), None, PLAN_KAOYAN, None),
    ('复盘上周错题',
     '只看错题本，把还不会的重新做一遍。', 'done', day(-1), None, PLAN_KAOYAN, -26),
    ('把教材 PDF 导进教材精读',
     '导进去之后按章拆一下，方便后面逐节看。', 'done', day(-2), None, None, -50),
    ('跑一次 25 分钟专注试试',
     '关掉手机通知，看看能不能坐住。', 'done', day(-2), None, None, -49),
    ('写一段今天的状态',
     '不用写得好，写下来就行。', 'done', day(0), None, None, -1),
]
for i, (title, desc, status, sched, due, plan, done_off) in enumerate(TASKS):
    tid = 'task-20261110-%08x' % (0x1000 + i * 7919)
    rec = {
        'id': tid, 'title': title, 'description': desc, 'status': status,
        'priority': 'high' if i in (0, 2, 8) else 'normal',
        'planId': plan, 'scheduledDate': sched, 'dueDate': due,
        'source': 'manual', 'sourceProposalId': None,
        'createdAt': iso(TODAY - timedelta(days=2, hours=i % 5)),
        'updatedAt': iso(TODAY + timedelta(hours=done_off or 0)),
    }
    if status == 'done':
        rec['completedAt'] = iso(TODAY + timedelta(hours=done_off or 0))
    else:
        rec['completedAt'] = None
    write('tasks', rec)

# ---------------------------------------------------------------- 专注记录
FOCUS_TITLES = ['背单词', '数学真题', '计算机网络', '英语阅读', '数据结构', '操作系统笔记']
idx = 0
for d in range(-6, 1):
    n = [3, 2, 4, 3, 2, 4, 3][d + 6]
    for k in range(n):
        idx += 1
        start = TODAY + timedelta(days=d, hours=-3 - k * 2)
        minutes = [25, 25, 45, 25][k % 4]
        write('focus-sessions', {
            'id': 'focus-20261110-%08x' % (0x2000 + idx * 6151),
            'clientToken': 'demo-%04d' % idx,
            'mode': 'focus',
            'title': FOCUS_TITLES[(idx + k) % len(FOCUS_TITLES)],
            'taskId': None, 'planId': PLAN_KAOYAN if k % 2 == 0 else None,
            'minutes': minutes, 'actualSeconds': minutes * 60,
            'startedAt': iso(start), 'endedAt': iso(start + timedelta(minutes=minutes)),
            'autoCompleted': False, 'taskCompleted': False, 'taskPreviousStatus': None,
            'undoneAt': None,
            'createdAt': iso(start + timedelta(minutes=minutes + 1)),
            'updatedAt': iso(start + timedelta(minutes=minutes + 1)),
        })

# ---------------------------------------------------------------- 教材
def section(sid, title, p1, p2, whole=False):
    return {
        'id': sid, 'title': title, 'pageStart': p1, 'pageEnd': p2,
        'wholeChapter': whole, 'subsections': [], 'demos': [], 'lesson': None,
    }


def book(bid, title, pages, chapters, days_ago, size_mb=20):
    """chapters: [(章标题, 起始页, 结束页, [节标题...])]"""
    chs = []
    for ci, (ct, p1, p2, secs) in enumerate(chapters, start=1):
        step = max(1, (p2 - p1) // max(1, len(secs)))
        ss = [section('ch%d-s%d' % (ci, si), st, p1 + (si - 1) * step, min(p2, p1 + si * step - 1))
              for si, st in enumerate(secs, start=1)]
        chs.append({'id': 'ch%d' % ci, 'title': ct, 'pageStart': p1, 'pageEnd': p2, 'sections': ss})
    write('textbooks', {
        'id': bid, 'title': title, 'fileName': title + '.pdf',
        'fileSize': size_mb * 1024 * 1024, 'pageCount': pages,
        'status': 'ready', 'statusMessage': '', 'chapters': chs,
        'createdAt': iso(TODAY - timedelta(days=days_ago)),
        'updatedAt': iso(TODAY - timedelta(days=max(1, days_ago - 3))),
    })


book('book-20261110-c0ffee01', '深入浅出计算机网络（第 2 版）', 164, [
    ('第 1 章 概述', 1, 22, ['1.1 计算机网络在信息时代的作用', '1.2 互联网概述', '1.3 互联网的组成']),
    ('第 2 章 物理层', 23, 54, ['2.1 物理层的基本概念', '2.2 数据通信的基础知识', '2.3 传输媒体']),
    ('第 3 章 数据链路层', 55, 104, ['3.1 点对点信道的数据链路层', '3.2 广播信道的数据链路层', '3.3 以太网']),
    ('第 4 章 网络层', 105, 164, ['4.1 网络层的几个重要概念', '4.2 IP 地址与分组转发', '4.3 路由选择协议']),
], 8, 30)

book('book-20261110-c0ffee02', '数据结构（C 语言版）', 320, [
    ('第 1 章 绪论', 1, 30, ['1.1 数据结构的研究内容', '1.2 基本概念和术语']),
    ('第 2 章 线性表', 31, 92, ['2.1 线性表的定义和特点', '2.2 顺序表', '2.3 链表']),
    ('第 3 章 栈和队列', 93, 140, ['3.1 栈', '3.2 队列']),
    ('第 4 章 串、数组和广义表', 141, 186, ['4.1 串']),
    ('第 5 章 树和二叉树', 187, 250, ['5.1 树的定义和基本术语', '5.2 二叉树', '5.3 遍历二叉树']),
], 6, 18)

book('book-20261110-c0ffee03', '计算机操作系统（第 4 版）', 386, [
    ('第 1 章 操作系统引论', 1, 34, ['1.1 操作系统的目标和作用', '1.2 操作系统的发展过程']),
    ('第 2 章 进程的描述与控制', 35, 96, ['2.1 前趋图和程序执行', '2.2 进程的描述', '2.3 进程控制']),
    ('第 3 章 处理机调度与死锁', 97, 158, ['3.1 处理机调度的层次', '3.2 调度算法', '3.3 死锁']),
    ('第 4 章 存储器管理', 159, 214, ['4.1 存储器的层次结构', '4.2 分页存储管理']),
], 11, 24)

book('book-20261110-c0ffee04', '计算机组成原理（第 2 版）', 412, [
    ('第 1 章 计算机系统概论', 1, 28, ['1.1 计算机系统简介', '1.2 计算机的基本组成']),
    ('第 2 章 计算机的发展及应用', 29, 52, ['2.1 计算机的发展史']),
    ('第 3 章 系统总线', 53, 88, ['3.1 总线的基本概念', '3.2 总线控制']),
    ('第 4 章 存储器', 89, 152, ['4.1 概述', '4.2 主存储器']),
], 13, 26)

book('book-20261110-c0ffee05', '线性代数（第六版）', 218, [
    ('第 1 章 行列式', 1, 46, ['1.1 二阶与三阶行列式', '1.2 全排列和对换', '1.3 行列式的性质']),
    ('第 2 章 矩阵及其运算', 47, 108, ['2.1 线性方程组和矩阵', '2.2 矩阵的运算', '2.3 逆矩阵']),
    ('第 3 章 矩阵的初等变换与线性方程组', 109, 156, ['3.1 矩阵的初等变换', '3.2 矩阵的秩']),
    ('第 4 章 向量组的线性相关性', 157, 218, ['4.1 向量组及其线性组合', '4.2 向量组的线性相关性']),
], 15, 12)

book('book-20261110-c0ffee06', '考研英语真题解析（2015—2025）', 296, [
    ('第一部分 阅读理解', 1, 152, ['2015—2018 真题', '2019—2021 真题', '2022—2025 真题']),
    ('第二部分 写作', 153, 214, ['小作文常见题型', '大作文结构模板']),
    ('第三部分 翻译与完形', 215, 296, ['翻译技巧', '完形填空高频词']),
], 4, 22)


# ---------------------------------------------------------------- 外刊
ARTICLES = [
    {
        'id': 'art-20261108-d001',
        'title': 'The Case for Doing One Thing at a Time',
        'source': 'The Atlantic', 'author': 'Derek Thompson',
        'excerpt': 'Multitasking is not a skill. It is a tax you pay without noticing the bill.',
        'tags': ['attention', 'productivity'],
        'paras': [
            ('heading', 1, 'The Case for Doing One Thing at a Time'),
            ('p', 'In the spring of 2008, a group of researchers at Stanford asked 100 students to sit down with a laptop and a stack of tasks. The heavy multitaskers were confident. They had spent years training on multiple screens, and they believed this was a talent. They were wrong. On almost every measure — filtering irrelevant information, switching between tasks, remembering what they had just seen — the heavy multitaskers performed worse than the light ones.'),
            ('p', 'That finding has been replicated many times since. What looks like skill is usually compensation. The brain does not actually run two streams of thought in parallel; it toggles, and every toggle costs something. The cost is small enough to be invisible one switch at a time, and large enough to matter over a day.'),
            ('p', 'The alternative is unglamorous. You pick one thing. You close the other windows. You sit with the mild discomfort of not knowing what is happening elsewhere, which is really the discomfort of not being in control. After twenty minutes the discomfort fades, and something else takes its place: the sense of a problem starting to give.'),
            ('heading', 2, 'Why the discomfort is the point'),
            ('p', 'Most people describe focus as a state they fall into. It is closer to a state they defend. The first few minutes are the expensive part, because that is when the mind keeps checking whether it should be somewhere else. If you can outlast that, the rest is mostly downhill.'),
            ('p', 'This is also why a timer helps more than a plan. A plan asks you to be reasonable about the future. A timer only asks you to stay for twenty-five minutes, which is a much smaller request and a much easier one to say yes to.'),
            ('p', 'None of this requires discipline in the moral sense. It requires removing the option to leave. The people who seem effortlessly productive are usually not resisting temptation; they have arranged their day so that temptation is not in the room.'),
        ],
    },
    {
        'id': 'art-20261108-d002',
        'title': 'Why We Wait Until the Last Minute',
        'source': 'The New Yorker', 'author': 'Maria Konnikova',
        'excerpt': 'Procrastination is not a time-management problem. It is a mood-management problem.',
        'tags': ['psychology', 'habits'],
        'paras': [
            ('heading', 1, 'Why We Wait Until the Last Minute'),
            ('p', 'The classic picture of a procrastinator is someone who cannot plan. The research says otherwise. Procrastinators tend to be optimistic about time in a very specific way: they believe the future version of themselves will be more capable, more rested, and more willing than the person sitting here now.'),
            ('p', 'What they are actually doing is trading a bad mood now for a worse one later. Starting a difficult task makes you feel incompetent for a few minutes. Checking your phone does not. The choice is not between work and rest; it is between two feelings, and the smaller, cheaper feeling usually wins.'),
            ('heading', 2, 'The two-minute door'),
            ('p', 'The interventions that work are embarrassingly small. Not "write the paper", but "open the document and write one sentence". Not "study for three hours", but "read the first page". The point is not the output. The point is to get past the moment where the task still feels like a verdict on you.'),
            ('p', 'Once you are inside the task, the verdict feeling fades, because you are no longer imagining the work — you are doing it, badly, which is the only way anyone does it.'),
        ],
    },
    {
        'id': 'art-20261108-d003',
        'title': 'The Quiet Power of a Written Plan',
        'source': 'The Economist', 'author': '',
        'excerpt': 'A plan is less a prediction than a way of noticing when reality disagrees with you.',
        'tags': ['planning', 'essay'],
        'paras': [
            ('heading', 1, 'The Quiet Power of a Written Plan'),
            ('p', 'Plans fail constantly, which is why people stop making them. But the value of a plan was never in its accuracy. It is in the fact that a written plan can be wrong out loud, and a plan in your head cannot.'),
            ('p', 'When you write down that a chapter will take two days, you create a small, cheap instrument for detecting reality. If it takes six, you learn something — about the chapter, about your reading speed, about the week you actually had. Without the number, the same six days produce nothing but a vague sense of being behind.'),
            ('p', 'The useful version of planning is therefore modest: short horizons, visible numbers, and a habit of revising rather than defending. A plan you refuse to change is not a plan. It is a wish with a date on it.'),
        ],
    },
    {
        'id': 'art-20261108-d004',
        'title': 'What We Talk About When We Talk About Focus',
        'source': 'The New York Times', 'author': 'Ezra Klein',
        'excerpt': 'Attention is not a resource you spend. It is a relationship you maintain.',
        'tags': ['attention', 'culture'],
        'paras': [
            ('heading', 1, 'What We Talk About When We Talk About Focus'),
            ('p', 'For most of the last decade, the conversation about attention has been a conversation about theft. Something is stealing it — the feed, the notification, the algorithm — and the solution is to lock it away.'),
            ('p', 'That framing is useful, but incomplete. Attention is less like money than like a relationship: it does not run out, it degrades when neglected and improves when tended. The question is not how much you have left, but what you have been in the habit of turning toward.'),
            ('p', 'Which suggests a different intervention. Instead of blocking the things you do not want, make the thing you do want slightly easier to reach than everything else. Put the book on the chair. Leave the document open. Open the app you are avoiding, and then close it, on purpose, once a day.'),
        ],
    },
    {
        'id': 'art-20261108-d005',
        'title': 'The Two-Hour Rule',
        'source': 'Wired', 'author': 'Clive Thompson',
        'excerpt': 'Deep work is not a marathon. It is a series of short, defended windows.',
        'tags': ['productivity', 'work'],
        'paras': [
            ('heading', 1, 'The Two-Hour Rule'),
            ('p', 'The people who produce the most do not work the longest. They work in windows they refuse to give away. Two hours, defended, beats eight hours, interrupted — not because of the arithmetic, but because of what interruption does to the shape of a thought.'),
            ('p', 'A thought has a middle. It takes time to get to the middle, and if you leave before you get there, you start over next time. This is why the third hour is often more productive than the first: you are already in the middle.'),
            ('p', 'The rule, then, is not about hours. It is about not leaving the middle once you have found it.'),
        ],
    },
    {
        'id': 'art-20261108-d006',
        'title': 'Notes on Reading Slowly',
        'source': 'The Paris Review', 'author': '',
        'excerpt': 'Speed is a property of the eye. Understanding is a property of the pause.',
        'tags': ['reading', 'essay'],
        'paras': [
            ('heading', 1, 'Notes on Reading Slowly'),
            ('p', 'There is a kind of reading that is really scanning: the eye moves, the page turns, and nothing is retained. It feels like progress because it is fast.'),
            ('p', 'Slow reading is not a moral position. It is a technique with a purpose: to notice when a sentence contradicts the one before it, or when an example does not actually support the claim it was brought in for.'),
            ('p', 'The practical version: read a section, close the book, say what it argued out loud. If you cannot, you did not read it. You only passed your eyes over it.'),
        ],
    },
    {
        'id': 'art-20261108-d007',
        'title': 'Against the Five-Year Plan',
        'source': 'The Guardian', 'author': 'Oliver Burkeman',
        'excerpt': 'Long plans are usually a way of avoiding the next twenty minutes.',
        'tags': ['planning', 'life'],
        'paras': [
            ('heading', 1, 'Against the Five-Year Plan'),
            ('p', 'The five-year plan has an obvious appeal: it makes the future feel settled. But the settling is the problem. A plan that reaches five years out has to be vague enough to survive five years of contact with reality, which means it is vague enough to be useless.'),
            ('p', 'What actually helps is a shorter unit — a week, a day, an afternoon — specific enough to be wrong, and therefore specific enough to teach you something.'),
            ('p', 'The long view is not a plan. It is a direction. Keep the direction, throw away the schedule.'),
        ],
    },
    {
        'id': 'art-20261108-d008',
        'title': 'How to Read a Difficult Paper',
        'source': 'Nature', 'author': '',
        'excerpt': 'Read the abstract, then the figures, then everything else — in that order.',
        'tags': ['research', 'method'],
        'paras': [
            ('heading', 1, 'How to Read a Difficult Paper'),
            ('p', 'Most people read a paper the way they read a news article: top to bottom. That order is the worst possible one for a difficult text, because the introduction assumes you already know why the question matters.'),
            ('p', 'A better order: the abstract, for the claim; the figures, for the evidence; the conclusion, for what the authors think it means; then the methods, and only then the introduction.'),
            ('p', 'By the time you reach the introduction, you will be reading it as an argument rather than as a wall. That is the whole difference.'),
        ],
    },
]
for a in ARTICLES:
    paras = []
    for i, item in enumerate(a['paras']):
        if item[0] == 'heading':
            paras.append({'id': 'p-%d' % (i + 1), 'kind': 'heading', 'level': item[1], 'text': item[2]})
        else:
            paras.append({'id': 'p-%d' % (i + 1), 'kind': 'paragraph', 'text': item[1]})
    words = sum(len(p['text'].split()) for p in paras)
    write('articles', {
        'id': a['id'], 'title': a['title'], 'source': a['source'], 'author': a['author'],
        'issue': '2026-11', 'url': '', 'format': 'md', 'fileName': a['id'] + '.md',
        'wordCount': words, 'paragraphCount': len(paras), 'excerpt': a['excerpt'],
        'tags': a['tags'], 'status': 'ready',
        'progress': {'anchorParagraphId': 'p-1', 'anchorRatio': 0, 'percent': 0, 'lastReadAt': None},
        'reader': {'fontSize': 19}, 'highlights': [],
        'createdAt': iso(TODAY - timedelta(days=2)), 'updatedAt': iso(TODAY - timedelta(days=2)),
    })
    os.makedirs(os.path.join(DATA, 'articles', 'content'), exist_ok=True)
    with open(os.path.join(DATA, 'articles', 'content', a['id'] + '.json'), 'w', encoding='utf-8') as f:
        json.dump({'id': a['id'], 'version': 1, 'paragraphs': paras}, f, ensure_ascii=False, indent=2)

# ---------------------------------------------------------------- 生词本
WORDS = [
    ('procrastinate', '/prəˈkræstɪneɪt/', 'v. 拖延，耽搁', 'art-20261108-d002', 'Procrastinators trade a bad mood now for a worse one later.'),
    ('replicate', '/ˈreplɪkeɪt/', 'v. 重复（实验）；复制', 'art-20261108-d001', 'That finding has been replicated many times since.'),
    ('unglamorous', '/ʌnˈɡlæmərəs/', 'adj. 不起眼的，不光鲜的', 'art-20261108-d001', 'The alternative is unglamorous.'),
    ('compensation', '/ˌkɒmpenˈseɪʃn/', 'n. 补偿；弥补', 'art-20261108-d001', 'What looks like skill is usually compensation.'),
    ('horizon', '/həˈraɪzn/', 'n. 范围，眼界；地平线', 'art-20261108-d003', 'The useful version of planning is modest: short horizons, visible numbers.'),
]
for i, (w, ph, mean, aid, sent) in enumerate(WORDS):
    write('vocabulary', {
        'id': 'word-20261110-%04d' % (i + 1), 'word': w, 'phonetic': ph, 'meaning': mean,
        'articleId': aid, 'sentence': sent, 'note': '',
        'createdAt': iso(TODAY - timedelta(days=2, hours=i)), 'updatedAt': iso(TODAY - timedelta(days=2, hours=i)),
    })


# ---------------------------------------------------------------- 对话
def msg(mid, role, content, minutes, **kw):
    base = {
        'id': mid, 'role': role, 'content': content,
        'createdAt': iso(TODAY - timedelta(days=1) + timedelta(minutes=minutes)),
        'problemCard': None, 'proposalId': None,
        'provider': 'local' if role == 'assistant' else None,
        'meta': None, 'context': None, 'actions': [],
    }
    base.update(kw)
    return base


PROBLEM_CARD = {
    'summary': '你现在卡在：事情都堆在一起，不知道先动哪一件。',
    'expressed': [
        '这周有四件事压着：开题报告、408 真题、英语作文、还有一门课的实验',
        '每件都挺急，我坐下来就先去刷手机了',
    ],
    'unknowns': ['开题报告到底要写多长', '真题要不要限时做'],
    'directions': [
        '四件事里只有开题报告有外部截止时间（导师周五要看），其余三件是你自己给自己加的。',
        '先做的不是最急的那件，而是最能让你今晚睡得着的那件。',
    ],
    'nextSteps': ['把开题报告拆成「先写一页背景」这一件小事，今天只做这一件'],
    'emotion': {
        'notice': '你提到「坐下来就先去刷手机」，这通常不是懒，是开头那几分钟太难。',
        'items': ['我坐下来就先去刷手机了'],
    },
}

PROPOSAL = {
    'id': 'prop-20261109-77aa88bb',
    'conversationId': 'conv-20261109-11aa22bb',
    'title': '先把开题报告推起来',
    'summary': '不排完整计划，只把最堵的那一件拆到能今天动手。',
    'actions': [
        {
            'id': 'act-1', 'title': '把开题报告的研究背景写满一页',
            'detail': '不管写得好不好，先把字数堆够。写完再删，比对着空白页想措辞容易。',
            'scheduledDate': day(0), 'dueDate': day(0), 'planId': PLAN_THESIS,
            'estimateMinutes': 40,
            'doneStandard': '文档里有一段连续的文字，能自己从头读到尾，不卡壳。',
            'createdTaskId': 'task-20261110-00001000',
        },
        {
            'id': 'act-2', 'title': '把开题提纲发给导师',
            'detail': '附上三篇参考文献，问一下方向要不要收窄。发出去就不用管了。',
            'scheduledDate': day(3), 'dueDate': day(4), 'planId': PLAN_THESIS,
            'estimateMinutes': 20,
            'doneStandard': '邮件已发出，且里面有一个具体的问题。',
            'createdTaskId': 'task-20261110-00001009',
        },
        {
            'id': 'act-3', 'title': '408 真题 2018 年选择题',
            'detail': '限时 40 分钟做完，只统计正确率，先不改错题。',
            'scheduledDate': day(4), 'dueDate': None, 'planId': PLAN_408,
            'estimateMinutes': 40,
            'doneStandard': '有一份带正确率的答卷。',
            'createdTaskId': 'task-20261110-0000100a',
        },
    ],
    'status': 'pending',
    'createdAt': iso(TODAY - timedelta(days=1, minutes=-4)),
    'updatedAt': iso(TODAY - timedelta(days=1, minutes=-4)),
}

CONV_A_MSGS = [
    msg('m-a1', 'user', '这周有四件事压着：开题报告、408 真题、英语作文，还有一门课的实验。每件都挺急，我坐下来就先去刷手机了。', 0),
    msg('m-a2', 'assistant', '四件事压在一起的时候，人容易先去做最不需要动脑的那件。先问一句：这四件里，哪一件是别人在等你的？', 2),
    msg('m-a3', 'user', '开题报告吧，导师说周五想看一下提纲。', 4),
    msg('m-a4', 'assistant', '那它就是唯一有外部截止时间的事，其余三件都是你自己给自己加的。今天不用排完整计划，只把开题报告拆到能立刻动手的程度就行。', 5,
        proposalId=PROPOSAL['id']),
    msg('m-a5', 'user', '可我打开文档也不知道写什么。', 7),
    msg('m-a6', 'assistant', '那就先不写「报告」，先写一页「我为什么要做这个题」。这一段不需要结构，写到哪算哪，堆满一页再回头看。', 8,
        problemCard=PROBLEM_CARD),
]

CONV_A = {
    'id': 'conv-20261109-11aa22bb',
    'title': '四件事压在一起，先动哪一件',
    'createdAt': iso(TODAY - timedelta(days=1)),
    'updatedAt': iso(TODAY - timedelta(days=1, minutes=-8)),
    'messages': CONV_A_MSGS,
    'proposals': [PROPOSAL],
    'asked': ['deadline'],
    'pendingIntent': None,
    'confirmedActionIds': [],
    'context': None,
}

CONV_B = {
    'id': 'conv-20261107-33cc44dd',
    'title': '读不进去书的时候怎么办',
    'createdAt': iso(TODAY - timedelta(days=3)),
    'updatedAt': iso(TODAY - timedelta(days=3, minutes=-12)),
    'messages': [
        msg('m-b1', 'user', '我坐下来读书，读两页就走神，然后就去看手机了。', -2880),
        msg('m-b2', 'assistant', '两页就走神，通常不是注意力的问题，是这两页对你说的话太抽象。可以试试读之前先给自己一个问题，带着问题读，走神会少一些。', -2878),
        msg('m-b3', 'user', '什么问题算好问题？', -2876),
        msg('m-b4', 'assistant', '能用一个具体例子回答的问题。比如读数据链路层，不要问「这一章讲了什么」，问「两个相邻的路由器之间，怎么保证收到的帧没有坏」。', -2875),
        msg('m-b5', 'user', '这个我好像能想起来。', -2874),
        msg('m-b6', 'assistant', '那就把这个问题写在纸上，读完这一节回来答一遍。答不上来再读一遍，比从头再读一遍省时间。', -2873),
    ],
    'proposals': [],
    'asked': [],
    'pendingIntent': None,
    'confirmedActionIds': [],
    'context': None,
}

for c in (CONV_A, CONV_B):
    write('conversations', c)

# ---------------------------------------------------------------- 汇总
print('demo data ->', DATA)
for coll in ('tasks', 'plans', 'projects', 'focus-sessions', 'textbooks', 'articles', 'vocabulary', 'conversations'):
    p = os.path.join(DATA, coll)
    n = len([x for x in os.listdir(p) if x.endswith('.json')]) if os.path.isdir(p) else 0
    print(' %-14s %d' % (coll, n))
