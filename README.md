<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/agentbus-logo-dark.svg">
  <img alt="AgentBus" src="docs/assets/agentbus-logo-light.svg" width="360">
</picture>

**A free, self-hosted browser cockpit for [AgentBus](https://github.com/staysup/agentbus).**

[![GitHub stars](https://img.shields.io/github/stars/staysup/agentbus-cockpit?style=flat)](https://github.com/staysup/agentbus-cockpit/stargazers)
[![Latest release](https://img.shields.io/github/v/release/staysup/agentbus-cockpit)](https://github.com/staysup/agentbus-cockpit/releases)
[![CI](https://github.com/StaysUp/agentbus-cockpit/actions/workflows/ci.yml/badge.svg)](https://github.com/StaysUp/agentbus-cockpit/actions/workflows/ci.yml)

[Quickstart](#quickstart) &nbsp;&bull;&nbsp; [Demo](#demo) &nbsp;&bull;&nbsp; [Releases](https://github.com/staysup/agentbus-cockpit/releases)

</div>

![AgentBus cockpit: a session, and one turn's model calls](docs/assets/cockpit-session.png)

It shows your agents' sessions, every turn, every model call and its cost. It uses only the public
AgentBus API, so anything it shows, your own program can read too.

## Demo

[![AgentBus cockpit demo](https://img.youtube.com/vi/si0HHQFcCD0/maxresdefault.jpg)](https://youtu.be/si0HHQFcCD0)

## Prerequisites

- Node.js 20.19 or later in the 20 line, or 22.12 or later. Vite needs one of these.
- A running AgentBus service (`agentbus up`). See the
  [AgentBus README](https://github.com/staysup/agentbus#quickstart).

## Quickstart

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

4. Connect. The address is filled in as `http://127.0.0.1:8787`. For the token, copy the file
   `token` from the data folder `agentbus up` printed (by default `~/.local/share/agentbus`):

   ```sh
   pbcopy < ~/.local/share/agentbus/token   # macOS; on Linux, cat it and copy it
   ```

   Paste it into the Token field and press Connect.

**Use recorded data** opens the cockpit on a recorded sample, with no service needed.

## Using it

- **An agent is a saved setup**: a harness (Claude Code, Codex or Antigravity), how it reaches a
  model (its own subscription, or an OpenRouter key read from an environment variable), the model
  and a name. "+ Agent" makes one.
- **+ Session** picks a machine, then a folder on it, and the first message. The session works on
  its own copy of the folder. Your folder does not change until a turn is applied.
- **Any message may go to any agent.** Pick it beside Send. Messages sent while a turn runs wait
  and run next.
- **Other agents answer in the conversation.** Ask in the chat, for example "ask codex to add a
  test". The answer comes back as the next turn.
- **Click a turn** to see its result, prompt, events, every model call with its cost, and its tools.

## Runners and Settings

**Runners** (at the foot of the Agents column) lists each machine, whether it is online, and whether
it can build a session's sandbox. A machine that ran `agentbus login` waits there: type the code it
shows and press Approve. An offline machine can be removed. The steps are in the
[AgentBus README](https://github.com/staysup/agentbus#add-a-machine).

![The Runners page: a machine waiting for approval](docs/assets/cockpit-runners.png)

**Settings** holds what every turn may do and the instructions every turn gets, the same on every
machine.

![The Settings page: the grants](docs/assets/cockpit-settings.png)

For a subscription agent on runners that hold no sign-in, open the agent's form and use
**Connect**. It runs the harness's own login on control. The token stays on control and is never
shown. **Turn on for my runners** lets control use it for your runners.

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
