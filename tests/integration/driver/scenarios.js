/** 集成测试场景：root 为主会话每一步的动作（tool+args / write / text），$TASK 替换为任务卡返回的 task_id */
const card = (flags, extra = {}) => ({
  tool: 'swarm_task_card',
  args: { title: '集成测试任务', goal: '验证 dsh-agent-swarm', acceptance: ['门禁满足'], scope: ['hello.txt'], flags, ...extra }
})
const delegate = (args) => ({ tool: 'swarm_delegate', args: { task_id: '$TASK', ...args } })
const accept = (stopReason) => ({ tool: 'swarm_accept', args: { task_id: '$TASK', decision: 'accept', summary: '申请验收', stopReason } })

export const SCENARIOS = {
  'gate-flow': {
    preset: 'tian-shu',
    root: [
      card({ changesCode: true }),
      delegate({ role: 'ji_feng', prompt: '创建 hello.txt' }),
      accept('尝试在复核前验收'),
      delegate({ role: 'fu_he', prompt: '确认 hello.txt 内容', gate: 'G_VERIFY' }),
      accept('门禁满足'),
      { tool: 'swarm_status', args: { task_id: '$TASK', verbose: true } },
      { text: 'DONE' }
    ]
  },
  'vision-blocked': {
    preset: 'tian-shu',
    root: [card({ hasVisualInput: true }), delegate({ role: 'guan_xiang', prompt: '描述截图', image_paths: ['shot.png'] }), { text: 'DONE' }]
  },
  'vision-ok': {
    preset: 'tian-shu',
    root: [
      card({ hasVisualInput: true }),
      delegate({ role: 'guan_xiang', prompt: '描述截图', image_paths: ['shot.png'] }),
      delegate({ role: 'guan_xiang', prompt: '越界路径', image_paths: ['../escape.png'] }),
      { text: 'DONE' }
    ]
  },
  'readonly-guard': {
    preset: 'yu-shi',
    root: [{ tool: 'write', write: { path: 'guard.txt', content: 'should be denied\n' } }, { text: 'DONE' }]
  },
  'native-fallback': {
    preset: 'tian-shu',
    root: [card({ changesCode: true }), delegate({ role: 'tan_wei', prompt: '定位入口', backend: 'codex' }), { text: 'DONE' }]
  },
  'jev-triage': { preset: 'tian-shu', root: [card({ changesCode: true }), { text: 'DONE' }] },
  'jev-fallback': { preset: 'tian-shu', root: [card({ changesCode: true, changesAlgorithm: true }), { text: 'DONE' }] },
  'root-fallback': { preset: 'tian-shu', root: [card({ uiCopy: true }), { text: 'DONE' }] },
  'thread-flow': {
    preset: 'tian-shu',
    root: [
      card({ changesCode: true }),
      delegate({ role: 'fu_he', prompt: '第一次验证 hello.txt' }),
      delegate({ role: 'fu_he', prompt: '修复后重新验证 hello.txt' }),
      delegate({ role: 'tan_wei', prompt: '一次性定位入口', session: 'oneshot' }),
      { tool: 'swarm_status', args: { task_id: '$TASK' } },
      { text: 'DONE' }
    ]
  }
}
