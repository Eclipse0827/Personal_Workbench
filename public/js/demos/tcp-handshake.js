/**
 * 演示：TCP 三次握手。
 * 不是一上来就放动画，而是可以一步一步看：
 * 每按一次「下一步」，信封走到对面，两边的状态跟着变。
 */

import { h } from '../ui.js';
import { svg, text, defsArrow, revealPath, prefersReducedMotion } from './svg.js';

const MARKER_SYN = 'tcp-arrow-syn';
const MARKER_SYNACK = 'tcp-arrow-synack';
const MARKER_ACK = 'tcp-arrow-ack';
const MARKER_DATA = 'tcp-arrow-data';

const STEPS = [
  {
    y: 130,
    dir: 'right',
    tone: 'syn',
    marker: MARKER_SYN,
    label: '① SYN · seq = x',
    client: 'SYN_SENT',
    server: 'LISTEN',
    title: '第一次握手：我想建立连接',
    explain: '客户端发送 SYN 报文，带上自己的初始序号 x。它在告诉服务器：「我想连你，我的起始序号是 x。」此时连接还没建立。',
  },
  {
    y: 200,
    dir: 'left',
    tone: 'synack',
    marker: MARKER_SYNACK,
    label: '② SYN + ACK · ack = x+1',
    client: 'SYN_SENT',
    server: 'SYN_RCVD',
    title: '第二次握手：收到了，我也发一个序号',
    explain: '服务器回 SYN + ACK：确认收到了 x（所以 ack = x + 1），同时告诉客户端自己的初始序号 y。服务器这边先进入 SYN_RCVD。',
  },
  {
    y: 270,
    dir: 'right',
    tone: 'ack',
    marker: MARKER_ACK,
    label: '③ ACK · ack = y+1',
    client: 'ESTABLISHED',
    server: 'ESTABLISHED',
    title: '第三次握手：确认你的序号',
    explain: '客户端再发一个 ACK，确认收到了服务器的 y。到这里，双方都确认了「我能发、你能收」和「你能发、我能收」，连接正式建立。',
  },
  {
    y: 340,
    dir: 'right',
    tone: 'data',
    marker: MARKER_DATA,
    label: '④ 数据传输 · seq = x+1',
    client: 'ESTABLISHED',
    server: 'ESTABLISHED',
    title: '连接建立之后，才开始传数据',
    explain: '数据阶段用序号保证有序，用确认和重传保证可靠。三次握手只负责「把连接建起来」，不负责传正文。',
  },
];

const STATE_TONE = {
  CLOSED: 'idle',
  LISTEN: 'calm',
  SYN_SENT: 'warm',
  SYN_RCVD: 'warm',
  ESTABLISHED: 'ok',
};

function stateBadge() {
  return h('span.demo-tcp-state', {}, '—');
}

export default {
  id: 'tcp-handshake',
  title: 'TCP 三次握手：三步到底在确认什么',
  description: '一步一步看 SYN、SYN + ACK、ACK 怎么走，以及两端的连接状态怎么变。',
  hint: '三次的本质：双方都要确认自己的发送和接收都被对方看见。少一次，就有一方的能力没被验证。',
  concept: 'TCP 三次握手分别在确认哪一方的发送与接收能力',

  mount(stage) {
    const reduceMotion = prefersReducedMotion();
    let step = 0;
    let timer = null;

    const arrows = STEPS.map((s, index) => {
      const x1 = s.dir === 'right' ? 145 : 535;
      const x2 = s.dir === 'right' ? 535 : 145;
      const path = svg('path', {
        d: `M ${x1} ${s.y} H ${x2}`,
        class: `demo-seq-arrow tone-${s.tone}`,
        'marker-end': `url(#${s.marker})`,
      });
      const label = text(340, s.y - 12, s.label, {
        class: `demo-seq-label tone-${s.tone}`,
        'text-anchor': 'middle',
      });
      const group = svg('g', { class: 'demo-seq', style: { opacity: '0' } }, [path, label]);
      return { ...s, path, group, revealed: false, index: index + 1 };
    });

    const svgRoot = svg('svg', {
      viewBox: '0 0 680 390',
      class: 'demo-svg demo-svg-tcp',
      role: 'img',
      'aria-label': 'TCP 三次握手时序图',
    }, [
      defsArrow(MARKER_SYN, '#b97844'),
      defsArrow(MARKER_SYNACK, '#6f8f84'),
      defsArrow(MARKER_ACK, '#5c4033'),
      defsArrow(MARKER_DATA, '#b7aa9d'),
      svg('rect', { x: 50, y: 20, width: 170, height: 54, rx: 12, class: 'demo-tcp-endpoint' }),
      text(135, 44, '客户端', { class: 'demo-tcp-endpoint-label', 'text-anchor': 'middle' }),
      text(135, 62, '发起连接的一方', { class: 'demo-tcp-endpoint-sub', 'text-anchor': 'middle' }),
      svg('rect', { x: 460, y: 20, width: 170, height: 54, rx: 12, class: 'demo-tcp-endpoint' }),
      text(545, 44, '服务器', { class: 'demo-tcp-endpoint-label', 'text-anchor': 'middle' }),
      text(545, 62, '监听端口的一方', { class: 'demo-tcp-endpoint-sub', 'text-anchor': 'middle' }),
      svg('line', { x1: 135, y1: 74, x2: 135, y2: 360, class: 'demo-tcp-lifeline' }),
      svg('line', { x1: 545, y1: 74, x2: 545, y2: 360, class: 'demo-tcp-lifeline' }),
      ...arrows.map((a) => a.group),
      text(26, 208, '时间', { class: 'demo-caption', transform: 'rotate(-90 26 208)' }),
      text(340, 380, '箭头方向就是报文方向；服务器先处于监听状态', {
        class: 'demo-caption',
        'text-anchor': 'middle',
      }),
    ]);

    // ------------------------------------------------------------ 状态与说明

    const clientState = stateBadge();
    const serverState = stateBadge();
    const states = h('div.demo-tcp-states', {}, [
      h('div.demo-tcp-peer', {}, [
        h('span.demo-tcp-peer-name', {}, '客户端状态'),
        clientState,
      ]),
      h('div.demo-tcp-transfer', {}, '⇄'),
      h('div.demo-tcp-peer', {}, [
        h('span.demo-tcp-peer-name', {}, '服务器状态'),
        serverState,
      ]),
    ]);

    const stepTitle = h('strong.demo-tcp-step-title', {}, '开始之前');
    const stepExplain = h('div.demo-tcp-step-explain', {},
      '服务器先监听端口（LISTEN），客户端还处于 CLOSED。下面每走一步，两边的状态都会更新。');

    const explainCard = h('div.demo-tcp-explain', {}, [stepTitle, stepExplain]);

    const note = h('div.demo-note', {}, '为什么不是两次？只发两次，服务器无法确认自己的 SYN + ACK 是否被客户端收到。第三次 ACK 补上的，正是「服务器也能被客户端听见」这一半确认。');

    // ------------------------------------------------------------ 控件

    const prevBtn = h('button.demo-btn', {
      type: 'button',
      onclick: () => {
        stopPlay();
        setStep(step - 1);
      },
    }, '← 上一步');

    const nextBtn = h('button.demo-btn', {
      type: 'button',
      onclick: () => {
        stopPlay();
        setStep(step + 1);
      },
    }, '下一步 →');

    const playBtn = h('button.demo-btn.primary', {
      type: 'button',
      onclick: () => {
        if (timer) { stopPlay(); return; }
        if (step >= STEPS.length) setStep(0, { animate: false });
        playBtn.textContent = '⏸ 暂停';
        timer = setInterval(() => {
          if (step >= STEPS.length) { stopPlay(); return; }
          setStep(step + 1);
        }, 1600);
      },
    }, '▶ 自动播放');

    const resetBtn = h('button.demo-btn', {
      type: 'button',
      onclick: () => {
        stopPlay();
        setStep(0, { animate: false });
      },
    }, '重置');

    const controls = h('div.demo-foot', {}, [
      h('div.demo-foot-btns', {}, [prevBtn, nextBtn, playBtn, resetBtn]),
      reduceMotion
        ? h('span.tiny.muted', {}, '系统开启了“减少动态效果”，箭头会直接出现，不放描边动画。')
        : h('span.tiny.muted', {}, '可以手动一步步点，也可以自动播放。'),
    ]);

    function stopPlay() {
      if (timer) { clearInterval(timer); timer = null; }
      playBtn.textContent = '▶ 自动播放';
    }

    function setStateBadge(el, value) {
      el.textContent = value;
      el.className = `demo-tcp-state ${STATE_TONE[value] || 'idle'}`;
    }

    function hideArrow(arrow) {
      arrow.revealed = false;
      arrow.group.style.opacity = '0';
      arrow.path.style.transition = 'none';
      arrow.path.style.strokeDasharray = '';
      arrow.path.style.strokeDashoffset = '';
    }

    function showArrow(arrow, animate) {
      arrow.group.style.opacity = '1';
      if (animate && !reduceMotion) {
        revealPath(arrow.path, 650);
      } else {
        arrow.path.style.transition = 'none';
        arrow.path.style.strokeDasharray = '';
        arrow.path.style.strokeDashoffset = '0';
        arrow.path.style.opacity = '1';
      }
      arrow.revealed = true;
    }

    function setStep(next, { animate = true } = {}) {
      const target = Math.max(0, Math.min(STEPS.length, next));
      step = target;

      for (const arrow of arrows) {
        const shouldShow = step >= arrow.index;
        if (!shouldShow) {
          hideArrow(arrow);
        } else if (!arrow.revealed) {
          showArrow(arrow, animate);
        }
      }

      if (step === 0) {
        stepTitle.textContent = '开始之前';
        stepExplain.textContent = '服务器先监听端口（LISTEN），客户端还处于 CLOSED。下面每走一步，两边的状态都会更新。';
        setStateBadge(clientState, 'CLOSED');
        setStateBadge(serverState, 'LISTEN');
      } else {
        const info = STEPS[step - 1];
        stepTitle.textContent = info.title;
        stepExplain.textContent = info.explain;
        setStateBadge(clientState, info.client);
        setStateBadge(serverState, info.server);
      }

      prevBtn.disabled = step === 0;
      nextBtn.disabled = step === STEPS.length;
      if (step === STEPS.length && timer) stopPlay();
    }

    stage.appendChild(h('div.demo-tcp', {}, [
      h('div.demo-tcp-visual', {}, [svgRoot, states]),
      explainCard,
    ]));
    stage.appendChild(note);
    stage.appendChild(controls);

    setStep(0, { animate: false });

    return () => {
      stopPlay();
    };
  },
};
