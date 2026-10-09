// After each turn, ask the SDK for the numbers behind `/usage` and send them
// the way the adapter sends limits itself: the session's last `usage_update`
// again, unchanged but for `_meta["_claude/rateLimit"]`. Claude Code only
// pushes limits when they change (and the adapter drops the push when it
// comes before the turn's first token count), and an Enterprise seat's push
// carries no utilization; its one limit, the monthly spend cap, becomes a
// `monthly_spend` window here.
//
// The usage call is experimental and `agent.sessions` / `agent.client` are
// adapter internals, so every step is optional and any failure sends
// nothing. The turn's own result never waits on this.

const USAGE = "usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET";

/** `{ utilization: 0–100, resets_at: ISO }` → `{ utilization: 0–1, resetsAt: s }`. */
function toWindow(fields) {
  if (typeof fields?.utilization !== "number") return null;
  const resetsAt = Date.parse(fields.resets_at);
  return {
    utilization: fields.utilization / 100,
    ...(Number.isFinite(resetsAt) && { resetsAt: Math.round(resetsAt / 1000) }),
  };
}

export function rateLimitInfoFrom(usage) {
  const limits = usage?.rate_limits;
  const unifiedWindows = {};
  for (const id of ["five_hour", "seven_day"]) {
    const window = toWindow(limits?.[id]);
    if (window) unifiedWindows[id] = window;
  }
  if (limits?.extra_usage?.is_enabled) {
    const window = toWindow(limits.extra_usage);
    if (window) unifiedWindows.monthly_spend = window;
  }
  if (Object.keys(unifiedWindows).length === 0) return null;
  return { status: "allowed", unifiedWindows };
}

export function reportUsageLimits(agent) {
  const prompt = agent?.prompt;
  const sessionUpdate = agent?.client?.sessionUpdate;
  if (typeof prompt !== "function" || typeof sessionUpdate !== "function") return;
  const send = (notification) => sessionUpdate.call(agent.client, notification);

  // The last usage_update each session sent, to repeat with limits added.
  const lastUsage = new Map();
  agent.client.sessionUpdate = (notification) => {
    if (notification?.update?.sessionUpdate === "usage_update") {
      lastUsage.set(notification.sessionId, notification);
    }
    return send(notification);
  };

  agent.prompt = async function (params, ...rest) {
    const result = await prompt.call(this, params, ...rest);
    const sessionId = params?.sessionId;
    Promise.resolve()
      .then(() => agent.sessions?.[sessionId]?.query?.[USAGE]?.({ skipBehaviors: true }))
      .then((usage) => {
        const info = rateLimitInfoFrom(usage);
        const last = lastUsage.get(sessionId);
        if (!info || !last) return;
        return send({
          ...last,
          update: {
            ...last.update,
            _meta: { ...last.update._meta, "_claude/rateLimit": info },
          },
        });
      })
      .catch(() => {});
    return result;
  };
}
