import type { InboundConfig, OuterInboundMeta } from '../outer/inbound-policy.js';

export interface ParticipationLabCase {
  id: string;
  label: string;
  category: 'dm' | 'group-sync' | 'group-llm' | 'edge';
  description?: string;
  threadId: string;
  content: string;
  meta: OuterInboundMeta;
  proactiveLevel: number;
  threadHistoryPrefix: string;
  innerStatusSummary: string;
  config?: Partial<InboundConfig>;
  /** 仅 full + mock 模式：注入 LLM 返回正文 */
  mockLlmContent?: string;
  expect?: { shouldReply: boolean; reason?: string };
}

const LAB_THREAD = 'participation-lab:preset';

export const PARTICIPATION_LAB_PRESETS: ParticipationLabCase[] = [
  {
    id: 'dm-text',
    label: 'DM · 有文本',
    category: 'dm',
    threadId: `${LAB_THREAD}:dm-text`,
    content: '帮我看下',
    meta: { threadKind: 'dm', isMentionAgent: true, mentionsOthers: false, skipParticipationCheck: false },
    proactiveLevel: 2,
    threadHistoryPrefix: '',
    innerStatusSummary: '',
    expect: { shouldReply: true, reason: 'dm' },
  },
  {
    id: 'dm-placeholder',
    label: 'DM · 仅图片占位',
    category: 'dm',
    threadId: `${LAB_THREAD}:dm-placeholder`,
    content: '[图片]',
    meta: { threadKind: 'dm', isMentionAgent: true, mentionsOthers: false, skipParticipationCheck: false },
    proactiveLevel: 2,
    threadHistoryPrefix: '',
    innerStatusSummary: '',
    expect: { shouldReply: false, reason: 'dm_empty_or_placeholder' },
  },
  {
    id: 'skip-check',
    label: '跳过参与检查（owner/调试）',
    category: 'edge',
    threadId: `${LAB_THREAD}:skip`,
    content: '',
    meta: { threadKind: 'group', isMentionAgent: false, mentionsOthers: true, skipParticipationCheck: true },
    proactiveLevel: 0,
    threadHistoryPrefix: '',
    innerStatusSummary: '',
    expect: { shouldReply: true, reason: 'skip_participation_check' },
  },
  {
    id: 'group-mention-agent',
    label: '群聊 · @ 本 agent',
    category: 'group-sync',
    threadId: `${LAB_THREAD}:at-agent`,
    content: '你怎么看？',
    meta: { threadKind: 'group', isMentionAgent: true, mentionsOthers: false, skipParticipationCheck: false },
    proactiveLevel: 2,
    threadHistoryPrefix: '',
    innerStatusSummary: '',
    expect: { shouldReply: true, reason: 'group_mention_agent' },
  },
  {
    id: 'group-mention-others',
    label: '群聊 · @ 他人',
    category: 'group-sync',
    threadId: `${LAB_THREAD}:at-others`,
    content: '@Alice 看下',
    meta: { threadKind: 'group', isMentionAgent: false, mentionsOthers: true, skipParticipationCheck: false },
    proactiveLevel: 3,
    threadHistoryPrefix: '',
    innerStatusSummary: '',
    expect: { shouldReply: false, reason: 'group_mention_others' },
  },
  {
    id: 'group-level-0',
    label: '群聊 · proactiveLevel=0',
    category: 'group-sync',
    threadId: `${LAB_THREAD}:l0`,
    content: '今天天气真好？',
    meta: { threadKind: 'group', isMentionAgent: false, mentionsOthers: false, skipParticipationCheck: false },
    proactiveLevel: 0,
    threadHistoryPrefix: '',
    innerStatusSummary: '',
    config: { proactiveLevel: 0 },
    expect: { shouldReply: false, reason: 'group_proactive_level_0' },
  },
  {
    id: 'group-l1-not-question',
    label: '群聊 · L1 非问句',
    category: 'group-sync',
    threadId: `${LAB_THREAD}:l1`,
    content: '今天天气真好',
    meta: { threadKind: 'group', isMentionAgent: false, mentionsOthers: false, skipParticipationCheck: false },
    proactiveLevel: 1,
    threadHistoryPrefix: '',
    innerStatusSummary: '',
    config: { proactiveLevel: 1 },
    expect: { shouldReply: false, reason: 'group_level1_not_question' },
  },
  {
    id: 'group-min-length',
    label: '群聊 · L2 过短',
    category: 'group-sync',
    threadId: `${LAB_THREAD}:min`,
    content: '嗯',
    meta: { threadKind: 'group', isMentionAgent: false, mentionsOthers: false, skipParticipationCheck: false },
    proactiveLevel: 2,
    threadHistoryPrefix: '',
    innerStatusSummary: '',
    expect: { shouldReply: false, reason: 'group_min_length' },
  },
  {
    id: 'group-invite',
    label: '群聊 · L3 群邀请规则',
    category: 'group-sync',
    threadId: `${LAB_THREAD}:invite`,
    content: '你们俩先互相认识下',
    meta: { threadKind: 'group', isMentionAgent: false, mentionsOthers: false, skipParticipationCheck: false },
    proactiveLevel: 3,
    threadHistoryPrefix: '',
    innerStatusSummary: '',
    config: { proactiveLevel: 3 },
    expect: { shouldReply: true, reason: 'group_rule_group_invite' },
  },
  {
    id: 'group-needs-llm',
    label: '群聊 · 需 LLM（陈述句）',
    category: 'group-llm',
    description: '同步阶段返回 needs_llm，需走 SPEAK/SILENT',
    threadId: `${LAB_THREAD}:needs-llm`,
    content: '我刚搭好开发环境，构建挺顺利',
    meta: { threadKind: 'group', isMentionAgent: false, mentionsOthers: false, skipParticipationCheck: false },
    proactiveLevel: 2,
    threadHistoryPrefix: 'Alice: 早上好\nBob: 早',
    innerStatusSummary: '内脑 idle',
    mockLlmContent: 'SILENT',
    expect: { shouldReply: false, reason: 'group_llm_silent' },
  },
  {
    id: 'group-llm-speak',
    label: '群聊 · Mock LLM → SPEAK',
    category: 'group-llm',
    threadId: `${LAB_THREAD}:llm-speak`,
    content: '谁能帮看下部署日志有没有报错',
    meta: { threadKind: 'group', isMentionAgent: false, mentionsOthers: false, skipParticipationCheck: false },
    proactiveLevel: 3,
    threadHistoryPrefix: '（无历史）',
    innerStatusSummary: '内脑 idle',
    config: { proactiveLevel: 3 },
    mockLlmContent: 'SPEAK',
    expect: { shouldReply: true, reason: 'group_llm_speak' },
  },
  {
    id: 'group-llm-disabled',
    label: '群聊 · 关闭参与 LLM',
    category: 'edge',
    threadId: `${LAB_THREAD}:llm-off`,
    content: '昨天那次发布挺顺的',
    meta: { threadKind: 'group', isMentionAgent: false, mentionsOthers: false, skipParticipationCheck: false },
    proactiveLevel: 2,
    threadHistoryPrefix: '',
    innerStatusSummary: '',
    config: { useLlmForParticipation: false },
    expect: { shouldReply: false, reason: 'participation_llm_disabled_or_no_key' },
  },
];
