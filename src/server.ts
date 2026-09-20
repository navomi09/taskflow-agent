import { Agent, callable, routeAgentRequest } from "agents";
import { withVoice, WorkersAIFluxSTT, WorkersAITTS, type VoiceTurnContext } from "@cloudflare/voice";

export interface Env {
  AI: Ai;
  TaskFlowAgent: DurableObjectNamespace;
  ASSETS: Fetcher;
}

export type Task = {
  id: string;
  text: string;
  done: boolean;
  remindAt?: string;
};

export type ChatMessage = {
  role: "user" | "assistant";
  content: string;
  ts: string;
};

export type TaskFlowState = {
  tasks: Task[];
  history: ChatMessage[];
};

// Asks the model to just extract the phrase, not compute a date — llama
// kept anchoring reminders to 1970 when I let it do the math itself.
function buildSystemPrompt(): string {
  return `You are TaskFlow, a concise personal task assistant.
Reply with ONLY a single JSON object (no prose, no markdown fences) matching
one of these shapes:

- Add a task:      {"action":"add_task","text":"<short task description>","remindAtPhrase":"<verbatim time phrase from the user, e.g. 'tomorrow at 5pm', or null if no reminder>"}
- Show open tasks: {"action":"list_tasks"}
- Complete a task: {"action":"complete_task","match":"<words that identify which task>"}
- Anything else:   {"action":"chat","reply":"<a short, friendly reply>"}

Do not compute dates yourself — just copy the time phrase the user used, verbatim.`;
}

const VoiceAgent = withVoice(Agent);

export class TaskFlowAgent extends VoiceAgent<Env, TaskFlowState> {
  initialState: TaskFlowState = {
    tasks: [],
    history: [],
  };

  // Both use the same Workers AI binding already set up for the LLM —
  // no extra keys or setup needed.
  transcriber = new WorkersAIFluxSTT(this.env.AI);
  tts = new WorkersAITTS(this.env.AI);

  // Called once per spoken turn. Routes straight through sendMessage so a
  // task added by voice and one added by typing hit the exact same logic
  // and land in the same shared history/task list.
  async onTurn(transcript: string, context: VoiceTurnContext): Promise<string> {
    return this.sendMessage(transcript);
  }

  @callable()
  async sendMessage(message: string): Promise<string> {
    this.appendHistory({ role: "user", content: message, ts: new Date().toISOString() });

    const { response } = await this.env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
      messages: [
        { role: "system", content: buildSystemPrompt() },
        { role: "user", content: message },
      ],
    });

    const parsed = this.safeParse(response);
    const reply = await this.handleAction(parsed);

    this.appendHistory({ role: "assistant", content: reply, ts: new Date().toISOString() });
    return reply;
  }

  @callable()
  listTasks(): Task[] {
    return this.state.tasks;
  }

  async onRequest(request: Request): Promise<Response> {
    if (request.method === "POST") {
      const { message } = (await request.json()) as { message: string };
      const reply = await this.sendMessage(message);
      return Response.json({ reply, tasks: this.state.tasks });
    }
    return Response.json({ tasks: this.state.tasks, history: this.state.history });
  }

  async sendReminder({ taskId }: { taskId: string }) {
    const task = this.state.tasks.find((t) => t.id === taskId);
    if (!task || task.done) return;
    this.broadcast(JSON.stringify({ type: "reminder", text: task.text }));
  }

  private appendHistory(msg: ChatMessage) {
    this.setState({ ...this.state, history: [...this.state.history, msg] });
  }

  private safeParse(raw: unknown): any {
    // Workers AI hands back `response` as a ready-made object sometimes,
    // not just a JSON string — burned by this once already, so handle both.
    if (raw && typeof raw === "object") return raw;
    if (typeof raw !== "string") return { action: "chat", reply: String(raw ?? "") };
    try {
      return JSON.parse(raw);
    } catch {
      return { action: "chat", reply: raw };
    }
  }

  // Turns "tomorrow at 5pm" / "in 20 minutes" into a real Date using the
  // actual current time. Doesn't cover everything (e.g. "next Monday" falls
  // through), but it's deterministic, which is the part that matters here.
  private resolveReminderTime(phrase: string | null | undefined, now: Date): Date | null {
    if (!phrase) return null;
    const text = phrase.toLowerCase().trim();

    const relative = text.match(/in\s+(\d+)\s*(minute|min|hour|hr|day)s?/);
    if (relative) {
      const amount = parseInt(relative[1], 10);
      const unit = relative[2];
      const ms = unit.startsWith("min")
        ? amount * 60_000
        : unit.startsWith("hour") || unit.startsWith("hr")
          ? amount * 3_600_000
          : amount * 86_400_000;
      return new Date(now.getTime() + ms);
    }

    const target = new Date(now);
    if (text.includes("tomorrow")) target.setDate(target.getDate() + 1);

    const clock = text.match(/(\d{1,2})(:(\d{2}))?\s*(am|pm)?/);
    if (clock) {
      let hour = parseInt(clock[1], 10);
      const minute = clock[3] ? parseInt(clock[3], 10) : 0;
      const ampm = clock[4];
      if (ampm === "pm" && hour < 12) hour += 12;
      if (ampm === "am" && hour === 12) hour = 0;
      if (hour >= 0 && hour <= 23) {
        target.setHours(hour, minute, 0, 0);
        if (!text.includes("tomorrow") && target.getTime() <= now.getTime()) {
          target.setDate(target.getDate() + 1);
        }
        return target;
      }
    }

    if (text.includes("tomorrow")) {
      target.setHours(9, 0, 0, 0);
      return target;
    }

    return null;
  }

  private async handleAction(parsed: any): Promise<string> {
    switch (parsed?.action) {
      case "add_task": {
        const when = this.resolveReminderTime(parsed.remindAtPhrase, new Date());
        const task: Task = {
          id: crypto.randomUUID(),
          text: parsed.text ?? "Untitled task",
          done: false,
          remindAt: when ? when.toISOString() : undefined,
        };
        this.setState({ ...this.state, tasks: [...this.state.tasks, task] });

        if (when) {
          await this.schedule(when, "sendReminder", { taskId: task.id });
        }
        return when
          ? `Added "${task.text}" — I'll remind you at ${when.toLocaleString()}.`
          : `Added "${task.text}" to your list.`;
      }

      case "list_tasks": {
        const open = this.state.tasks.filter((t) => !t.done);
        if (open.length === 0) return "You're all caught up — no open tasks.";
        return "Here's what's open:\n" + open.map((t, i) => `${i + 1}. ${t.text}`).join("\n");
      }

      case "complete_task": {
        const match = (parsed.match ?? "").toLowerCase();
        let found = false;
        const tasks = this.state.tasks.map((t) => {
          if (!t.done && match && t.text.toLowerCase().includes(match)) {
            found = true;
            return { ...t, done: true };
          }
          return t;
        });
        this.setState({ ...this.state, tasks });
        return found ? "Marked that one done." : "I couldn't find a matching task.";
      }

      default: {
        const reply = parsed?.reply;
        if (typeof reply === "string" && reply.trim()) return reply;
        return "Sorry, I didn't catch that — try rephrasing?";
      }
    }
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    return (
      (await routeAgentRequest(request, env)) ??
      env.ASSETS.fetch(request)
    );
  },
};
