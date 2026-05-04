const storage = {
  agentUrl: "clawy.agent.app.agentUrl",
  token: "clawy.agent.app.token",
  sessionKey: "clawy.agent.app.sessionKey",
};

const state = {
  eventCount: 0,
  streamingMessage: null,
};

const els = {
  connectionForm: document.querySelector("#connection-form"),
  agentUrl: document.querySelector("#agent-url"),
  token: document.querySelector("#server-token"),
  sessionKey: document.querySelector("#session-key"),
  planMode: document.querySelector("#plan-mode"),
  healthButton: document.querySelector("#health-button"),
  runtimeStatus: document.querySelector("#runtime-status"),
  eventCount: document.querySelector("#event-count"),
  sessionLabel: document.querySelector("#session-label"),
  messages: document.querySelector("#messages"),
  events: document.querySelector("#events"),
  messageForm: document.querySelector("#message-form"),
  messageInput: document.querySelector("#message-input"),
  sendButton: document.querySelector("#send-button"),
  clearButton: document.querySelector("#clear-button"),
};

function defaultSessionKey() {
  return "agent:local:app:web:default";
}

function loadSettings() {
  els.agentUrl.value = localStorage.getItem(storage.agentUrl) || window.location.origin;
  els.token.value = localStorage.getItem(storage.token) || "";
  els.sessionKey.value = localStorage.getItem(storage.sessionKey) || defaultSessionKey();
  updateSessionLabel();
}

function saveSettings() {
  localStorage.setItem(storage.agentUrl, normalizeAgentUrl(els.agentUrl.value));
  localStorage.setItem(storage.token, els.token.value.trim());
  localStorage.setItem(storage.sessionKey, els.sessionKey.value.trim() || defaultSessionKey());
  loadSettings();
  addEvent("connection_saved", {
    agentUrl: els.agentUrl.value,
    sessionKey: els.sessionKey.value,
    tokenPresent: els.token.value.trim().length > 0,
  });
}

function normalizeAgentUrl(value) {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.replace(/\/+$/, "") : window.location.origin;
}

function updateSessionLabel() {
  els.sessionLabel.textContent = els.sessionKey.value.trim() || defaultSessionKey();
}

function headers() {
  const token = els.token.value.trim();
  return {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    "X-Core-Agent-Session-Key": els.sessionKey.value.trim() || defaultSessionKey(),
    ...(els.planMode.checked ? { "X-Core-Agent-Plan-Mode": "on" } : {}),
  };
}

function addMessage(role, text, extraClass = "") {
  const node = document.createElement("div");
  node.className = `message ${role} ${extraClass}`.trim();
  node.textContent = text;
  els.messages.appendChild(node);
  node.scrollIntoView({ block: "end" });
  return node;
}

function appendAssistantText(text) {
  if (!state.streamingMessage) {
    state.streamingMessage = addMessage("assistant", "", "streaming");
  }
  state.streamingMessage.textContent += text;
  state.streamingMessage.scrollIntoView({ block: "end" });
}

function finishAssistantMessage() {
  if (!state.streamingMessage) return;
  state.streamingMessage.classList.remove("streaming");
  state.streamingMessage = null;
}

function addEvent(type, payload) {
  state.eventCount += 1;
  els.eventCount.textContent = String(state.eventCount);
  const node = document.createElement("div");
  node.className = "event";
  const title = document.createElement("strong");
  title.textContent = type;
  const body = document.createElement("span");
  body.textContent = JSON.stringify(payload, null, 2);
  node.append(title, body);
  els.events.prepend(node);
}

async function checkRuntime() {
  const base = normalizeAgentUrl(els.agentUrl.value);
  els.runtimeStatus.textContent = "Checking";
  try {
    const response = await fetch(`${base}/health`);
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || response.statusText);
    els.runtimeStatus.textContent = `${payload.runtime || "runtime"} ${payload.version || ""}`.trim();
    addEvent("health", payload);
  } catch (error) {
    els.runtimeStatus.textContent = "Unavailable";
    addEvent("health_error", { message: String(error.message || error) });
  }
}

export function createSseParser(onEvent) {
  let buffer = "";
  return (chunk) => {
    buffer += chunk;
    const frames = buffer.split(/\n\n/);
    buffer = frames.pop() || "";
    for (const frame of frames) {
      const lines = frame.split(/\n/);
      let event = "message";
      const data = [];
      for (const line of lines) {
        if (line.startsWith(":")) continue;
        if (line.startsWith("event:")) event = line.slice("event:".length).trim();
        if (line.startsWith("data:")) data.push(line.slice("data:".length).trimStart());
      }
      if (data.length > 0) onEvent(event, data.join("\n"));
    }
  };
}

function handleSseEvent(eventName, rawData) {
  if (rawData === "[DONE]") {
    finishAssistantMessage();
    addEvent("done", {});
    return;
  }
  let payload;
  try {
    payload = JSON.parse(rawData);
  } catch {
    addEvent("sse_parse_error", { eventName, rawData });
    return;
  }

  if (eventName === "agent") {
    addEvent(payload.type || "agent", payload);
    if (payload.type === "text_delta" && typeof payload.delta === "string") {
      appendAssistantText(payload.delta);
    }
    if (payload.type === "turn_end") {
      finishAssistantMessage();
    }
    return;
  }

  const delta = payload.choices?.[0]?.delta?.content;
  if (typeof delta === "string" && delta.length > 0) {
    appendAssistantText(delta);
  }
  if (payload.choices?.[0]?.finish_reason) {
    finishAssistantMessage();
  }
}

async function sendMessage(text) {
  const base = normalizeAgentUrl(els.agentUrl.value);
  const response = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      stream: true,
      messages: [{ role: "user", content: text }],
    }),
  });
  if (!response.ok || !response.body) {
    let payload = {};
    try {
      payload = await response.json();
    } catch {
      /* keep empty payload */
    }
    throw new Error(payload.error || response.statusText);
  }

  const decoder = new TextDecoder();
  const parser = createSseParser(handleSseEvent);
  for await (const chunk of response.body) {
    parser(decoder.decode(chunk, { stream: true }));
  }
  parser(decoder.decode());
  finishAssistantMessage();
}

els.connectionForm.addEventListener("submit", (event) => {
  event.preventDefault();
  saveSettings();
});

els.healthButton.addEventListener("click", () => {
  void checkRuntime();
});

els.sessionKey.addEventListener("input", updateSessionLabel);

els.clearButton.addEventListener("click", () => {
  els.messages.textContent = "";
  els.events.textContent = "";
  state.eventCount = 0;
  state.streamingMessage = null;
  els.eventCount.textContent = "0";
});

els.messageForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = els.messageInput.value.trim();
  if (text.length === 0) return;
  saveSettings();
  addMessage("user", text);
  els.messageInput.value = "";
  els.sendButton.disabled = true;
  try {
    await sendMessage(text);
  } catch (error) {
    finishAssistantMessage();
    addMessage("assistant", String(error.message || error), "error");
    addEvent("send_error", { message: String(error.message || error) });
  } finally {
    els.sendButton.disabled = false;
    els.messageInput.focus();
  }
});

loadSettings();
addEvent("app_ready", {
  agentUrl: els.agentUrl.value,
  sessionKey: els.sessionKey.value,
});
