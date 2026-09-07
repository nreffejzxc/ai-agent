# Customer support agent

An AI support agent that answers customer questions on your website, in a chat
bubble in the corner of the page. It answers from facts you give it, and hands
off to a human when it doesn't know.

Answers visitors through AgentRouter, an Anthropic-compatible gateway you pay
for with prepaid credits. Defaults to a fast, cheap model (`deepseek-v4-flash`);
the stronger Claude models are a one-line switch away. TypeScript, one small
server, no database.

---

## Quick start

**1. Install** (once)

```bash
npm install
```

**2. Add your API key**

Copy `.env.example` to `.env`, then put your AgentRouter key in it. Create one
in your AgentRouter console at [agentrouter.org](https://agentrouter.org) — it
runs on prepaid credits that cover Anthropic models.

```bash
cp .env.example .env      # on Windows PowerShell: Copy-Item .env.example .env
```

**3. Run it**

```bash
npm run dev
```

**4. Open <http://localhost:3000>**

You'll see a fake bike-shop page with the chat widget in the corner. Ask it
something. It's answering as the example business for now.

**5. Make it yours** — open `src/business.ts` and replace the example details
with your own. Save, and the server restarts automatically.

---

## The only file you need to edit

`src/business.ts` holds everything the agent knows: hours, pricing, policies,
FAQs, how to reach a human, and what it must never do. It's a plain list of
facts with comments explaining each section — no code to write.

Two things worth knowing:

- **Only put true things in it.** The agent is instructed never to invent a
  price, a date, or an availability. Anything you leave out becomes "let me put
  you in touch with the team" instead of a guess. That's deliberate: a wrong
  price quoted confidently costs you more than an unanswered question.
- **The FAQ section earns its keep fastest.** The questions you already answer
  ten times a week are the ones the agent will take off your hands.

The agent has no access to your calendar, stock, or order system — it only
knows what's in that file. Connecting it to live systems is the natural next
step; see [What to add next](#what-to-add-next).

---

## Putting it on your website

Deploy this server somewhere (see below), then paste one tag into your site's
HTML, just before `</body>`:

```html
<script
  src="https://chat.yourbusiness.com/widget.js"
  data-api="https://chat.yourbusiness.com"
  data-title="Your Business"
  data-greeting="Hi! Ask me about anything."
  data-launcher="Chat with us"
  data-accent="#1f6f4a"
></script>
```

| Attribute       | What it does                                          |
| --------------- | ----------------------------------------------------- |
| `data-api`      | Where this server lives. Defaults to the page origin. |
| `data-title`    | Heading at the top of the chat panel.                 |
| `data-greeting` | First thing the agent says.                           |
| `data-launcher` | Text on the chat button.                              |
| `data-accent`   | Your brand colour, any CSS colour.                    |

The widget renders inside a shadow root, so your site's CSS can't break it and
it won't leak styles onto your pages. It follows the visitor's light/dark
preference, works on mobile, and keeps the conversation across page navigation.

---

## What it costs

Every real answer draws on your AgentRouter prepaid credits — there is no free
tier here. How fast they go, and what they cost, depends mostly on which model
answers:

| Model               | What it's for                                  | Cost  |
| ------------------- | ---------------------------------------------- | ----- |
| `deepseek-v4-flash` | **The default.** Fast, cheap support answers.  | Low   |
| `glm-5.3`, `gpt-5.6-sol` | Other non-Anthropic options.             | Varies |
| `claude-opus-4-8`   | Anthropic Claude — strong answers, Opus-tier.  | High  |
| `claude-opus-5`     | Anthropic Claude — strongest of the plan.      | High  |

Your plan exposes all of these. The default is `deepseek-v4-flash`: it's not
Anthropic's model, but it runs on the same Anthropic-compatible API, replies in
a fraction of the time, and stretches your credits far further — which is why a
chat widget defaults to it. Pick any other by setting `AGENT_MODEL` in `.env`,
e.g. `AGENT_MODEL=claude-opus-5` when you want Claude's best answer and the
extra latency/cost is worth it (the Opus models are slower partly because they
think before replying).

Two things to know:

- **Your AgentRouter plan may only allow a subset of models.** If a request
  errors, check Console → API Token → model restrictions and switch `AGENT_MODEL`
  to something your plan covers.
- **AgentRouter is a young third-party relay**, not run by Anthropic, with no
  published uptime guarantee. Great for learning, testing and side projects;
  worth a second thought before it fronts real customer traffic. (If you later
  prefer going direct or to a bigger provider, the model call lives in one
  file — `src/agent.ts` — and is the only thing that would change.)

The system prompt — the biggest, most stable part of each request — is marked
with Anthropic's prompt caching (`cache_control`), so the repeated prefix is
served from cache at a fraction of the price. Every reply logs its real token
usage:

```
[chat] session=8f2a1c04 in=182 cache_read=1204 cache_write=412 out=96 stop=end_turn
```

`cache_read` above zero means the cache is working. It can stay zero if your
prompt is short — caching only kicks in past a minimum prefix size
(somewhere between ~512 and ~4096 tokens depending on model), and it has a
5-minute freshness window.

---

## Testing without spending anything

Set `MOCK=true` in `.env` and run `npm run dev`. No API key needed, no calls
made, nothing billed.

The server streams canned replies word by word, so this genuinely exercises the
widget, the streaming, scrolling, the typing indicator, CORS, rate limiting and
your deployment — the whole machine except the model. Replies are prefixed
`[mock]` so they can't be mistaken for real answers, and different questions
(pricing, hours, booking, a complaint) hit different canned responses.

What mock mode **cannot** tell you is whether the answers are any good. That's
the one thing only a real call can settle, and it's the thing worth spending
your credits on. A handful of real test chats costs fractions of a cent to a
few cents depending on the model.

---

## Deploying

It's a standard Node server, so anything that runs Node works — Render, Fly,
Railway, a VPS, or your own box.

```bash
npm run build
npm start
```

Set these in your host's environment:

| Variable              | Value                                                       |
| --------------------- | ----------------------------------------------------------- |
| `AGENTROUTER_API_KEY` | Your AgentRouter key (`ANTHROPIC_API_KEY` also works).      |
| `ANTHROPIC_BASE_URL`  | Optional — defaults to `https://agentrouter.org`.           |
| `AGENT_MODEL`         | Optional — defaults to `deepseek-v4-flash`.     |
| `ALLOWED_ORIGINS`     | `https://yourbusiness.com,https://www.yourbusiness.com`     |
| `TRUST_PROXY`         | `true` if you're behind Nginx, Cloudflare, or a host proxy. |
| `PORT`                | Usually set for you by the host.                            |

The server warns you on startup about anything still left at a development
default.

---

## Security notes

Worth reading before this faces the public, because a chat endpoint backed by
your API key is a stranger's access to a paid model.

- **Your API key never leaves the server.** That's the reason this server
  exists rather than calling the model from the browser.
- **Rate limiting is on by default** — 20 messages per IP per 5 minutes, tuned
  with `RATE_LIMIT_MAX` and `RATE_LIMIT_WINDOW_SECONDS`. Don't remove it.
- **Set `ALLOWED_ORIGINS`.** While it's empty, any website can call your server
  and spend your credits.
- **Only set `TRUST_PROXY=true` if you really are behind a proxy.** Otherwise a
  caller can forge `X-Forwarded-For` and walk around the rate limiter.
- **Conversations are stored server-side**, keyed by an unguessable session id.
  The browser sends only its newest message. If the browser sent the whole
  transcript, a visitor could forge the agent's own past words — "you already
  promised me a refund" — and it would believe them.
- **`LOG_TRANSCRIPTS=true` writes real customer messages** to
  `logs/conversations.jsonl`. Useful for finding out what people actually ask.
  Treat the file as personal data; it's gitignored.

---

## Tuning the answers

**Answers too shallow?** The default `deepseek-v4-flash` is fast and cheap but
not Anthropic's strongest. Set `AGENT_MODEL=claude-opus-5` (or `claude-opus-4-8`)
for Claude's best answers — see [What it costs](#what-it-costs).

**Replies too slow, or spending too much?** That's the trade-off of a
heavyweight model. Stick with `deepseek-v4-flash`, the default, for snappy,
cheap support answers.

**Too chatty, too formal, too keen?** Rewrite the `tone` field in
`src/business.ts`. It's a sentence of plain instruction and it has more effect
than you'd expect.

**Answering things it shouldn't?** Add a line to `neverDo`.

**Handing off too much, or too little?** Adjust `escalateWhen`.

---

## What to add next

In rough order of how much they typically pay off:

1. **Your real documents.** Point it at price lists, policies, and manuals so
   you're not retyping them into `business.ts`. This is retrieval, and it's the
   usual second step.
2. **Live booking.** Give the agent a tool that reads your real calendar and
   books appointments, instead of linking to a form.
3. **Order and account lookup.** "Where's my order?" is the most common support
   question in most businesses, and it needs a tool call to answer.
4. **Email handoff.** When it escalates, open a real ticket rather than showing
   an address.
5. **Multiple instances.** Session memory and rate limits currently live in this
   process. Running more than one copy behind a load balancer means moving both
   to Redis — the interfaces in `src/sessions.ts` and `src/ratelimit.ts` are
   deliberately small so that swap is easy.

---

## Project layout

```
src/
  business.ts    ← your business facts. THE FILE YOU EDIT.
  prompt.ts      builds the system prompt from business.ts
  agent.ts       the Claude call: model, streaming, token usage
  server.ts      HTTP server, CORS, validation, SSE endpoint
  sessions.ts    server-side conversation memory
  ratelimit.ts   per-visitor abuse protection
public/
  widget.js      the embeddable chat bubble (self-contained)
  index.html     local demo page
```

| Command             | What it does                                 |
| ------------------- | -------------------------------------------- |
| `npm run dev`       | Run with auto-restart on save.               |
| `npm run typecheck` | Check types without building.                |
| `npm run build`     | Compile to `dist/`.                          |
| `npm start`         | Run the compiled server.                     |

`GET /health` reports the model, mock mode, and active session count.
