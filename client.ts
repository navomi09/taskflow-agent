import { AgentClient } from "agents/client";
import { VoiceClient } from "@cloudflare/voice/client";

type ChatMessage = { role: "user" | "assistant"; content: string; ts: string };
type TaskFlowState = { tasks: unknown[]; history: ChatMessage[] };

const AGENT_NAME =
  localStorage.getItem("taskflow-user") ??
  (() => {
    const id = crypto.randomUUID();
    localStorage.setItem("taskflow-user", id);
    return id;
  })();

const log = document.getElementById("log") as HTMLDivElement;
const form = document.getElementById("form") as HTMLFormElement;
const input = document.getElementById("input") as HTMLInputElement;
const send = document.getElementById("send") as HTMLButtonElement;

function addEntry(role: "user" | "assistant", text: string) {
  const el = document.createElement("div");
  el.className = "entry " + role;
  el.textContent = text;
  log.appendChild(el);
  log.scrollTop = log.scrollHeight;
}

// We render off the server's history array rather than tracking our own
// copy of "what's been sent" — that's the whole point of state sync: every
// tab/device watching this agent renders the same thing, driven by the
// same source of truth.
let renderedCount = 0;

function renderHistory(state: TaskFlowState) {
  const history = state?.history ?? [];
  for (let i = renderedCount; i < history.length; i++) {
    addEntry(history[i].role, history[i].content);
  }
  renderedCount = history.length;
}

const agent = new AgentClient({
  agent: "task-flow-agent",
  name: AGENT_NAME,
  host: window.location.host,
  onStateUpdate: (state: TaskFlowState) => renderHistory(state),
});

// One-off events (like a fired reminder) come through as plain messages,
// separate from state sync, so they show up once instead of re-rendering
// on every connection.
agent.addEventListener("message", (event: MessageEvent) => {
  try {
    const data = JSON.parse(event.data);
    if (data.type === "reminder") addEntry("assistant", `Reminder: ${data.text}`);
  } catch {
    // Not JSON — state sync frames are handled separately, ignore the rest.
  }
});

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const message = input.value.trim();
  if (!message) return;
  input.value = "";
  send.disabled = true;
  try {
    // Don't render locally here — the message shows up via onStateUpdate
    // once the server actually persists it, same as it would on any other
    // connected tab.
    await agent.call("sendMessage", [message]);
  } catch (err) {
    addEntry("assistant", "Couldn't reach the agent — check the console.");
    console.error(err);
  } finally {
    send.disabled = false;
    input.focus();
  }
});

// Voice shares the same agent name, so a task added by talking and one
// added by typing land in the same list — onTurn (server side) just calls
// sendMessage under the hood, same as the form submit above.
const voiceBtn = document.getElementById("voice-btn") as HTMLButtonElement;
const voiceStatus = document.getElementById("voice-status") as HTMLSpanElement;

const voice = new VoiceClient({
  agent: "task-flow-agent",
  name: AGENT_NAME,
  host: window.location.host,
});

function setVoiceUI(status: string) {
  const active = status !== "idle";
  voiceBtn.textContent = active ? "■" : "🎙";
  voiceBtn.classList.toggle("active", active);
  voiceStatus.textContent = active ? status : "";
}

voice.addEventListener("statuschange", (status: string) => setVoiceUI(status));

voice.addEventListener("error", (err: unknown) => {
  console.error("Voice error:", err);
  voiceStatus.textContent = "voice error — check console";
});

voice.connect();

voiceBtn.addEventListener("click", async () => {
  try {
    if (voiceBtn.classList.contains("active")) {
      voice.endCall();
    } else {
      await voice.startCall();
    }
  } catch (err) {
    console.error("Couldn't start the call:", err);
    voiceStatus.textContent = "couldn't access the mic";
  }
});
