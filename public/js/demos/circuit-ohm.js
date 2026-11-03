/**
 * 演示：串联 / 并联电路的电流。
 * 用「流动的虚线」表示电流方向，虚线速度随电流大小变化；
 * 切换串并联时，总电阻和干路电流会跟着变。
 */

import { h } from '../ui.js';
import { svg, text, appendSvg, defsArrow, prefersReducedMotion } from './svg.js';

const ARROW_ID = 'circuit-demo-arrow';

function battery(x, y) {
  return [
    svg('rect', { x: x - 20, y: y - 34, width: 40, height: 68, rx: 6, class: 'demo-mask' }),
    svg('line', { x1: x - 24, y1: y - 8, x2: x + 24, y2: y - 8, class: 'demo-battery-plate' }),
    svg('line', { x1: x - 14, y1: y + 8, x2: x + 14, y2: y + 8, class: 'demo-battery-plate' }),
    text(x - 34, y - 4, '+', { class: 'demo-symbol demo-symbol-warm' }),
    text(x - 34, y + 22, '−', { class: 'demo-symbol demo-symbol-warm' }),
    text(x - 44, y + 42, '电源 U', { class: 'demo-label', 'text-anchor': 'middle' }),
  ];
}

function resistor(x, y, w, hh, label) {
  return [
    svg('rect', { x, y, width: w, height: hh, rx: 8, class: 'demo-resistor' }),
    text(x + w / 2, y + hh / 2 + 5, label, { class: 'demo-resistor-label', 'text-anchor': 'middle' }),
  ];
}

export default {
  id: 'circuit-ohm',
  title: '串联与并联：电流到底怎么走',
  description: '切换串联 / 并联，拖动电压和电阻，看总电阻、干路电流和支路电流怎么变。',
  hint: '虚线速度代表电流大小；并联时两条支路分流，R 越小分到的电流越大。',
  concept: '串联 / 并联电路中的总电阻、干路电流与支路电流',

  mount(stage) {
    let mode = 'series';
    let voltage = 6;
    let r1 = 6;
    let r2 = 12;
    let running = true;
    let visible = true;
    let seriesOffset = 0;
    let topOffset = 0;
    let bottomOffset = 0;
    let last = performance.now();
    const reduceMotion = prefersReducedMotion();

    // ------------------------------------------------------------ 图

    const seriesFlow = svg('path', {
      d: 'M 120 80 H 540 V 260 H 120 Z',
      class: 'demo-flow',
      style: { strokeDasharray: '12 28' },
    });
    const parallelFlowTop = svg('path', {
      d: 'M 100 100 H 560',
      class: 'demo-flow',
      style: { strokeDasharray: '12 28' },
    });
    const parallelFlowBottom = svg('path', {
      d: 'M 100 270 H 560',
      class: 'demo-flow',
      style: { strokeDasharray: '12 28' },
    });

    const seriesGroup = svg('g', { class: 'demo-circuit-group' }, [
      svg('path', { d: 'M 120 80 H 540 V 260 H 120 Z', class: 'demo-wire' }),
      seriesFlow,
      ...battery(120, 170),
      ...resistor(245, 62, 110, 36, 'R₁'),
      ...resistor(522, 148, 36, 90, 'R₂'),
      text(300, 124, 'R₁ 与 R₂ 串在同一条路上', { class: 'demo-caption', 'text-anchor': 'middle' }),
      svg('path', { d: 'M 370 80 H 430', class: 'demo-dir', 'marker-end': `url(#${ARROW_ID})` }),
      svg('path', { d: 'M 540 108 V 138', class: 'demo-dir', 'marker-end': `url(#${ARROW_ID})` }),
      svg('path', { d: 'M 430 260 H 370', class: 'demo-dir', 'marker-end': `url(#${ARROW_ID})` }),
      text(300, 294, '电流只有一条路，处处相同', { class: 'demo-caption', 'text-anchor': 'middle' }),
    ]);

    const parallelGroup = svg('g', { class: 'demo-circuit-group', style: { display: 'none' } }, [
      svg('path', { d: 'M 100 100 H 560 V 270 H 100 Z', class: 'demo-wire' }),
      parallelFlowTop,
      parallelFlowBottom,
      ...battery(100, 185),
      ...resistor(300, 82, 110, 36, 'R₁'),
      ...resistor(300, 252, 110, 36, 'R₂'),
      svg('path', { d: 'M 210 100 H 270', class: 'demo-dir', 'marker-end': `url(#${ARROW_ID})` }),
      svg('path', { d: 'M 210 270 H 270', class: 'demo-dir', 'marker-end': `url(#${ARROW_ID})` }),
      text(450, 112, '支路 1', { class: 'demo-caption', 'text-anchor': 'middle' }),
      text(450, 296, '支路 2', { class: 'demo-caption', 'text-anchor': 'middle' }),
      text(330, 196, '两条路各走各的，电压相同', { class: 'demo-caption', 'text-anchor': 'middle' }),
    ]);

    const svgRoot = svg('svg', {
      viewBox: '0 0 660 340',
      class: 'demo-svg',
      role: 'img',
      'aria-label': '串联与并联电路的电流演示',
    }, [
      defsArrow(ARROW_ID, 'var(--accent)'),
      seriesGroup,
      parallelGroup,
    ]);

    // ------------------------------------------------------------ 读数

    function stat(label) {
      const value = h('b', {}, '—');
      const box = h('div.demo-stat', {}, [h('span', {}, label), value]);
      return { box, value };
    }

    const reqStat = stat('总电阻 R');
    const mainStat = stat('干路电流 I');
    const branchStat = stat('各电阻电流');
    const powerStat = stat('总功率 P');
    const stats = h('div.demo-stats', {}, [reqStat.box, mainStat.box, branchStat.box, powerStat.box]);
    const note = h('div.demo-note', {});

    // ------------------------------------------------------------ 控制

    const modeButtons = new Map();
    const modeBar = h('div.demo-segment', { role: 'group', 'aria-label': '连接方式' }, [
      ['series', '串联'],
      ['parallel', '并联'],
    ].map(([id, label]) => {
      const btn = h(`button.demo-seg-btn${id === 'series' ? '.active' : ''}`, {
        type: 'button',
        onclick: () => setMode(id),
      }, label);
      modeButtons.set(id, btn);
      return btn;
    }));

    function slider(label, min, max, step, value, suffix, onInput) {
      const out = h('span.demo-range-value', {}, `${value}${suffix}`);
      const input = h('input.demo-range', {
        type: 'range', min, max, step, value,
        'aria-label': label,
        oninput: (e) => {
          const v = Number(e.target.value);
          out.textContent = `${v}${suffix}`;
          onInput(v);
        },
      });
      return h('label.demo-range-wrap', {}, [
        h('span.demo-range-label', {}, [h('span', {}, label), out]),
        input,
      ]);
    }

    const controls = h('div.demo-controls', {}, [
      modeBar,
      slider('电源电压', 3, 12, 0.5, voltage, ' V', (v) => { voltage = v; paint(); }),
      slider('R₁', 2, 20, 1, r1, ' Ω', (v) => { r1 = v; paint(); }),
      slider('R₂', 2, 20, 1, r2, ' Ω', (v) => { r2 = v; paint(); }),
    ]);

    const pauseBtn = h('button.demo-btn', {
      type: 'button',
      onclick: () => {
        running = !running;
        pauseBtn.textContent = running ? '⏸ 暂停' : '▶ 继续';
      },
    }, reduceMotion ? '静态示意' : '⏸ 暂停');
    if (reduceMotion) running = false;

    const foot = h('div.demo-foot', {}, [
      pauseBtn,
      h('span.tiny.muted', {}, reduceMotion ? '系统开启了“减少动态效果”，这里只显示静态方向。' : '画面离开视野时会自动暂停。'),
    ]);

    // ------------------------------------------------------------ 计算与绘制

    function values() {
      if (mode === 'series') {
        const req = r1 + r2;
        const current = voltage / req;
        return {
          req,
          main: current,
          branch: null,
          power: voltage * current,
          speed: 16 + current * 42,
          branchSpeed: 0,
        };
      }
      const req = (r1 * r2) / (r1 + r2);
      const i1 = voltage / r1;
      const i2 = voltage / r2;
      return {
        req,
        main: i1 + i2,
        branch: { i1, i2 },
        power: voltage * (i1 + i2),
        speed: 0,
        branchSpeed1: 16 + i1 * 28,
        branchSpeed2: 16 + i2 * 28,
      };
    }

    function paint() {
      const v = values();
      seriesGroup.style.display = mode === 'series' ? '' : 'none';
      parallelGroup.style.display = mode === 'parallel' ? '' : 'none';
      for (const [key, btn] of modeButtons) btn.classList.toggle('active', key === mode);

      reqStat.value.textContent = `${v.req.toFixed(1)} Ω`;
      mainStat.value.textContent = `${v.main.toFixed(2)} A`;
      powerStat.value.textContent = `${v.power.toFixed(1)} W`;
      branchStat.value.textContent = v.branch
        ? `${v.branch.i1.toFixed(2)} / ${v.branch.i2.toFixed(2)} A`
        : `${v.main.toFixed(2)} A`;

      note.textContent = mode === 'series'
        ? `串联：R = R₁ + R₂ = ${v.req.toFixed(1)} Ω。电压被两个电阻分掉，电流处处相同。`
        : `并联：1/R = 1/R₁ + 1/R₂，总电阻比任一支路都小。R₁ 分到 ${v.branch.i1.toFixed(2)} A，R₂ 分到 ${v.branch.i2.toFixed(2)} A。`;
    }

    function frame(now) {
      if (!svgRoot.isConnected) return;
      const dt = Math.min(80, now - last) / 1000;
      last = now;
      const v = values();
      if (running && visible && !reduceMotion) {
        if (mode === 'series') {
          seriesOffset -= v.speed * dt;
          seriesFlow.style.strokeDashoffset = String(seriesOffset);
        } else {
          topOffset -= v.branchSpeed1 * dt;
          bottomOffset -= v.branchSpeed2 * dt;
          parallelFlowTop.style.strokeDashoffset = String(topOffset);
          parallelFlowBottom.style.strokeDashoffset = String(bottomOffset);
        }
      }
      raf = requestAnimationFrame(frame);
    }

    function setMode(next) {
      mode = next;
      paint();
    }

    appendSvg(stage, [
      svgRoot,
      stats,
      note,
      controls,
      foot,
    ]);
    paint();

    let io = null;
    if ('IntersectionObserver' in window) {
      io = new IntersectionObserver((entries) => {
        visible = entries.some((x) => x.isIntersecting);
      }, { threshold: 0.05 });
      io.observe(stage);
    }
    let raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      if (io) io.disconnect();
    };
  },
};
