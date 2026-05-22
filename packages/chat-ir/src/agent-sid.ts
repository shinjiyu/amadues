/**
 * 本栈主助手 SID 的解析与默认值。
 *
 * 与 IM `identities.json`、外脑 Pack、`UTLRA_AGENT_IM_SID` 应对齐为同一值。
 *
 * 这层只读 `process.env`，不碰文件系统——浏览器侧若不设置 env 则永远返回默认值。
 */

/**
 * 未设置 `UTLRA_PRIMARY_AGENT_SID` 时的默认主助手 sid（刻意不用 `*:self`）。
 * 运行时请用 {@link resolvePrimaryAgentSid}（读环境变量）。
 */
export const DEFAULT_PRIMARY_AGENT_SID = 'idp:agent:assistant' as const;

/**
 * 解析本栈主助手 sid：环境变量 `UTLRA_PRIMARY_AGENT_SID`（trim 非空）优先，
 * 否则 {@link DEFAULT_PRIMARY_AGENT_SID}。
 */
export function resolvePrimaryAgentSid(): string {
  try {
    const v =
      typeof process !== 'undefined' && process.env
        ? process.env['UTLRA_PRIMARY_AGENT_SID']?.trim()
        : undefined;
    if (v) return v;
  } catch {
    /* ignore */
  }
  return DEFAULT_PRIMARY_AGENT_SID;
}

/** @deprecated 请用 {@link resolvePrimaryAgentSid} 或 {@link DEFAULT_PRIMARY_AGENT_SID} */
export const PRIMARY_AGENT_SID = DEFAULT_PRIMARY_AGENT_SID;
