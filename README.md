# TaskFlow

A personal task/reminder agent on Cloudflare. You chat with it in plain
English — "remind me to call the bank tomorrow at 10am" — and it figures out
what you meant, tracks it, and reminds you when it's due.

Built on Workers AI (Llama 3.3) + the Agents SDK (Durable Objects under the
hood for state and scheduling). No API key needed for the LLM.

## How it works

`src/server.ts` has one class, `TaskFlowAgent`. Each browser gets its own
instance (random id in localStorage), so it's really one durable object per
user.

Every message goes to Llama 3.3 with a system prompt asking it to return a
small JSON action — add a task, list tasks, complete one, or just chat.
One thing that tripped me up: I originally had the model compute the actual
reminder datetime itself, and it kept anchoring things to 1970 (some Unix
epoch default) instead of doing the date math right. Now the model only
extracts the time *phrase* ("tomorrow at 5pm") and a small function in code
does the actual arithmetic — much more reliable.

`this.schedule(...)` books the reminder as a durable callback, so it survives
even if the Worker instance gets evicted in between.

The front end used to be plain `fetch()` calls — worked, but every reply
needed a full request/response round trip, and two tabs wouldn't see each
other's changes. It now uses the SDK's `AgentClient` over a WebSocket
(`src/client.ts`), so state pushes to the browser the moment the server
changes it — open two tabs and they stay in sync live.

`AgentClient` is an npm package meant to be bundled, not dropped in with a
plain `<script>` tag, so there's a small esbuild step now
(`npm run build:client`) that turns `src/client.ts` into `public/client.js`.
It runs automatically before `dev` and `deploy`. If you edit `client.ts`
while `wrangler dev` is already running, rerun `npm run build:client` in a
second terminal (or just restart `npm run dev`) to pick up the change —
Wrangler doesn't rebuild it for you automatically.

Also tripped on this one: `@callable()` (used for the WebSocket RPC calls)
needs `target: "ES2021"` in tsconfig — I had it on ES2022, which silently
broke the decorator instead of erroring at build time. Fixed by extending
`agents/tsconfig` instead of hand-rolling compiler options.

## Voice

The mic button uses `@cloudflare/voice` — `WorkersAIFluxSTT` for
speech-to-text, `WorkersAITTS` for text-to-speech, both on the same Workers
AI binding as the LLM. The server's `onTurn` handler (fired once per spoken
turn) just calls `sendMessage()` — the same method the typed chat form
calls — so a task added by voice and one added by typing go through
identical logic and land in the same shared history. Needs mic permission
and a secure context (`localhost` or HTTPS — a deployed `*.workers.dev` URL
qualifies).

## Run it locally

```bash
npm install
npm run dev
```

First time using Workers AI on your account, you'll need a workers.dev
subdomain registered — wrangler will point you to the right dashboard page
if it's missing.

## Deploy

```bash
npx wrangler login
npm run deploy
```

## Ideas for later

- Swap `env.AI.run(...)` for AI Gateway if I want a different model.
- Cloudflare Workflows for anything more than a single LLM call (e.g. an
  agent that researches something and emails a summary).

Docs I used while building this: developers.cloudflare.com/agents,
agents.cloudflare.com, and the `cloudflare/agents` repo on GitHub for the
exact `Agent` class API.
