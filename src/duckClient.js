export const KNOWN_MODELS = [
  { id: "Luna", label: "GPT-6 Luna (observed in captured session)" },
];

export const UPSTREAM = {
  statusUrl: "https://duckduckgo.com/duckchat/v1/status",
  chatUrl: "https://duckduckgo.com/duckchat/v1/chat",
};

export function buildUpstreamBody({ model, messages }) {
  return {
    model,
    metadata: { toolChoice: { NewsSearch: false, VideosSearch: false } },
    messages,
    canUseTools: true,
  };
}

export async function sendUpstream({ model, messages }, env = process.env) {
  const hash = env.DUCK_X_VQD_HASH_1;
  const feVersion = env.DUCK_X_FE_VERSION;
  if (!hash || !feVersion) {
    const err = new Error(
      "Upstream mode needs DUCK_X_VQD_HASH_1 and DUCK_X_FE_VERSION supplied by you. " +
      "These are ephemeral session values, not a stable API key. See README.md."
    );
    err.code = "MISSING_UPSTREAM_HEADERS";
    throw err;
  }
  const res = await fetch(UPSTREAM.chatUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "text/event-stream",
      "x-vqd-hash-1": hash,
      "x-fe-version": feVersion,
    },
    body: JSON.stringify(buildUpstreamBody({ model, messages })),
  });
  return res;
}
