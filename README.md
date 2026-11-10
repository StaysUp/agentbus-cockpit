<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/agentbus-logo-dark.svg">
  <img alt="AgentBus" src="docs/assets/agentbus-logo-light.svg" width="360">
</picture>

# AgentBus cockpit

**A free, self-hosted browser cockpit for [AgentBus](https://github.com/staysup/agentbus).**

[![GitHub stars](https://img.shields.io/github/stars/staysup/agentbus-cockpit?style=flat)](https://github.com/staysup/agentbus-cockpit/stargazers)
[![Latest release](https://img.shields.io/github/v/release/staysup/agentbus-cockpit)](https://github.com/staysup/agentbus-cockpit/releases)
[![CI](https://github.com/StaysUp/agentbus-cockpit/actions/workflows/ci.yml/badge.svg)](https://github.com/StaysUp/agentbus-cockpit/actions/workflows/ci.yml)

[Run it](#run) &nbsp;&bull;&nbsp; [Demo](#demo) &nbsp;&bull;&nbsp; [AgentBus](https://github.com/staysup/agentbus) &nbsp;&bull;&nbsp; [Releases](https://github.com/staysup/agentbus-cockpit/releases)

</div>

![AgentBus cockpit: a conversation, and one turn's model calls](docs/assets/cockpit-model-calls.png)

A free, self-hosted browser cockpit for [AgentBus](https://github.com/staysup/agentbus). It shows
your agents' turns, every model call, its cost, and the full conversation.

The cockpit is a client of the AgentBus API. It uses only the public client API, so
anything it shows, your own program can read too.

## Demo

[![AgentBus cockpit demo](https://img.youtube.com/vi/si0HHQFcCD0/maxresdefault.jpg)](https://youtu.be/si0HHQFcCD0)

Click to watch on YouTube.

## Prerequisites

- Node.js 20.19 or later in the 20 line, or 22.12 or later. Vite needs one of these.
- A running AgentBus service (`agentbus up`). See the
  [AgentBus README](https://github.com/staysup/agentbus#quickstart).

## Run

1. Start AgentBus:

   ```sh
   agentbus up
   ```

   Any browser origin may call it, because every call needs the token. To allow only the cockpit,
   start it with `agentbus up -origin http://localhost:5173` instead. That origin must then match
   exactly: open the cockpit at `localhost`, not `127.0.0.1`, or pass that origin.

2. In this folder, install and start the cockpit:

   ```sh
   npm ci
   npm run dev
   ```

3. Open `http://localhost:5173`.

4. Connect. The service address is filled in as `http://127.0.0.1:8787`. For the token, copy the
   contents of the `token` file in the data folder that `agentbus up` printed at start, by default
   `~/.local/share/agentbus/token`. On macOS:

   ```sh
   pbcopy < ~/.local/share/agentbus/token
   ```

   On Linux, print it and copy it from the terminal:

   ```sh
   cat ~/.local/share/agentbus/token
   ```

   With `$AGENTBUS_HOME` set, the token is in that folder instead. With only `$XDG_DATA_HOME` set,
   it is in `$XDG_DATA_HOME/agentbus`.

   Paste it into the Token field and press Connect.

**Use recorded data** opens the cockpit on a recorded sample, with no service needed.

## Talking to agents

![A conversation: the model changes per message, and an asked agent's answer comes back as the next turn](docs/assets/cockpit-conversation.png)

- **An agent is a saved setup**: a harness (Claude Code or Codex), how it reaches a model (its own
  subscription or an OpenRouter key, read from an environment variable on the service's machine),
  the model and a name. "+ Agent" makes one. Select an agent in the left column to edit or remove it.
- **New session is an agent and a folder**, with the first message. The session works on its own
  copy of the folder. Your folder does not change until you apply.
- **Any message may go to any agent.** Pick it beside Send. Each turn's header names the agent and
  the model that ran it.
- **Messages queue.** Send while a turn runs. The message waits and runs next.
- **Other agents answer in the conversation.** Ask in the chat, for example "have codex check it".
  The answer comes back as the next turn, marked as delivered by AgentBus. "open its session"
  shows the other agent's own work.
- **Reviews and applies are asked for in the chat**, for example "apply that turn to my folder",
  not with buttons.
- **Click a turn** to see its result, prompt, events, every model call with its cost, and its tools.

The review screens (Review and Fix on a turn, the CI/CD tab, the session's job list) and a turn's
Changes dialog ("Apply to my folder") are still in the code, off by default. To turn them on, start
the cockpit with `VITE_REVIEW_UI=1`:

```sh
VITE_REVIEW_UI=1 npm run dev
```

## Runners on other machines

Point the cockpit at the machine that runs control (`agentbus server`, or `agentbus up`). It shows
turns that runners on other machines run, live, with their model calls. See the
[AgentBus README](https://github.com/staysup/agentbus#three-roles-one-or-more-machines) for the
setup.

![The + Agent form, with the Connect step of a subscription agent](docs/assets/cockpit-new-agent.png)

A runner holds no sign-in. For a subscription agent on your own runners, open the agent's form and
use **Connect**. It runs the harness's own login on control (for Claude Code,
`claude setup-token`). Open the link it shows, sign in, and type the code the browser gives you.
The token stays on control and is never shown. **Turn on for my runners** sets
`subscriptions_on_runners = "own"`. One machine (`agentbus up` alone) needs none of this.

## Build a static copy

```sh
npm run build
```

This writes `dist/`. Serve it from any static host. Plain `agentbus up` accepts it; to lock the
service to that host, pass its origin to `agentbus up -origin`.

## Test

```sh
npm test
```

## License

Free to use, change and run, including inside your business. You can't sell it as a competing product or service. Each release becomes Apache 2.0 two years after it is published.

Licensed under the [Functional Source License](https://fsl.software) (FSL-1.1-ALv2). See [LICENSE](LICENSE).
