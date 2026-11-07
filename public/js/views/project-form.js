/**
 * 学习项目 / 课程表单。
 * 课程的三个集数字段含义不同，输入框下方都写了说明 —— 这里不做自动推断，
 * 「继续学习」和「完成本集」的实际集数以服务端接口为准。
 */

import { api } from '../api.js';
import { h, modal, toast, toastError, COURSE_PLATFORM_LABEL } from '../ui.js';

export function openProjectForm({ project = null, onSaved } = {}) {
  const isEdit = Boolean(project);
  const p = project || {};
  const title = h('input', { type: 'text', value: p.title || '', placeholder: '例如：考研数学' });
  const description = h('textarea', {
    rows: 3,
    value: p.description || '',
    placeholder: '这个项目大概要学什么、到什么程度。可以留空。',
  });

  modal({
    title: isEdit ? '编辑学习项目' : '新建学习项目',
    body: h('div', {}, [
      h('label.field', {}, [
        h('span.label-text', {}, '项目名称'),
        title,
      ]),
      h('label.field.mb0', {}, [
        h('span.label-text', {}, '项目简介'),
        h('span.label-hint', {}, '可选。写一句就够。'),
        description,
      ]),
    ]),
    actions: [
      { label: '取消' },
      {
        label: isEdit ? '保存' : '创建',
        primary: true,
        onClick: async () => {
          if (!title.value.trim()) {
            toast('给这个学习项目起个名字吧。', 'warn');
            title.focus();
            return false;
          }
          try {
            const payload = { title: title.value, description: description.value };
            if (isEdit) await api.patchProject(p.id, payload);
            else await api.createProject(payload);
            toast(isEdit ? '改好了。' : '项目建好了。');
            if (onSaved) await onSaved();
          } catch (err) {
            toastError(err);
            return false;
          }
        },
      },
    ],
  });
}

const numberValue = (raw) => (raw === '' ? 0 : Number(raw));

export function openCourseForm({ projectId, course = null, onSaved } = {}) {
  const isEdit = Boolean(course);
  const c = course || {};

  const title = h('input', { type: 'text', value: c.title || '', placeholder: '例如：高数基础班' });
  const platform = h('select', {}, ['bilibili', 'mooc', 'other'].map((value) =>
    h('option', { value, selected: (c.platform || 'other') === value }, COURSE_PLATFORM_LABEL[value])));
  const url = h('input', {
    type: 'text',
    value: c.url || '',
    placeholder: 'https://www.bilibili.com/video/...',
  });
  const source = h('input', {
    type: 'text',
    value: c.source || '',
    placeholder: '例如：2024 版 / 配套讲义在网盘',
  });
  const total = h('input', {
    type: 'number', min: '0', step: '1',
    value: c.totalEpisodes || '',
    placeholder: '不确定就留空',
  });
  const completed = h('input', {
    type: 'number', min: '0', step: '1',
    value: c.completedEpisodes || '',
    placeholder: '0',
  });
  const last = h('input', {
    type: 'number', min: '0', step: '1',
    value: c.lastEpisode || '',
    placeholder: '0',
  });

  modal({
    title: isEdit ? '编辑课程' : '添加课程',
    wide: true,
    body: h('div.course-form', {}, [
      h('label.field', {}, [
        h('span.label-text', {}, '课程名称'),
        title,
      ]),
      h('div.split', {}, [
        h('label.field', {}, [
          h('span.label-text', {}, '学习平台'),
          platform,
        ]),
        h('label.field', {}, [
          h('span.label-text', {}, '课程来源'),
          source,
          h('span.label-hint', {}, '可选。比如版本、老师或讲义位置。'),
        ]),
      ]),
      h('label.field', {}, [
        h('span.label-text', {}, '课程链接'),
        url,
        h('span.label-hint', {}, '可选。「继续学习」会打开它；只有链接本身带 p 参数的 B 站视频才会定位到具体集数。'),
      ]),
      h('div.course-form-numbers', {}, [
        h('label.field', {}, [
          h('span.label-text', {}, '总集数'),
          total,
          h('span.label-hint', {}, '不知道就留空。没填总集数的课程不参与项目进度计算。'),
        ]),
        h('label.field', {}, [
          h('span.label-text', {}, '已完成集数'),
          completed,
          h('span.label-hint', {}, '从第 1 集开始连续完成的集数。跳集时不要手动加，避免把中间没看的集算成完成。'),
        ]),
        h('label.field', {}, [
          h('span.label-text', {}, '最近学习集数'),
          last,
          h('span.label-hint', {}, '上次正在看的集数。继续学习会先打开这里，确认学完当前集后再进入下一集。'),
        ]),
      ]),
    ]),
    actions: [
      { label: '取消' },
      {
        label: isEdit ? '保存' : '添加',
        primary: true,
        onClick: async () => {
          if (!title.value.trim()) {
            toast('给这门课起个名字吧。', 'warn');
            title.focus();
            return false;
          }
          try {
            const payload = {
              title: title.value,
              platform: platform.value,
              url: url.value.trim(),
              source: source.value,
              totalEpisodes: numberValue(total.value),
              completedEpisodes: numberValue(completed.value),
              lastEpisode: numberValue(last.value),
            };
            if (isEdit) await api.patchCourse(projectId, c.id, payload);
            else await api.addCourse(projectId, payload);
            toast(isEdit ? '课程改好了。' : '课程加进来了。');
            if (onSaved) await onSaved();
          } catch (err) {
            toastError(err);
            return false;
          }
        },
      },
    ],
  });
}
