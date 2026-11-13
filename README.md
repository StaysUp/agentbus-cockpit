<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/agentbus-logo-dark.svg">
  <img alt="AgentBus" src="docs/assets/agentbus-logo-light.svg" width="360">
</picture>

**A free, self-hosted browser cockpit for [AgentBus](https://github.com/staysup/agentbus).**

[![GitHub stars](https://img.shields.io/github/stars/staysup/agentbus-cockpit?style=flat)](https://github.com/staysup/agentbus-cockpit/stargazers)
[![Latest release](https://img.shields.io/github/v/release/staysup/agentbus-cockpit)](https://github.com/staysup/agentbus-cockpit/releases)
[![CI](https://github.com/StaysUp/agentbus-cockpit/actions/workflows/ci.yml/badge.svg)](https://github.com/StaysUp/agentbus-cockpit/actions/workflows/ci.yml)

[Quickstart](https://github.com/staysup/agentbus#quickstart) &nbsp;&bull;&nbsp; [Demo](#demo) &nbsp;&bull;&nbsp; [Releases](https://github.com/staysup/agentbus-cockpit/releases)

</div>

![AgentBus cockpit: a session, and one turn's model calls](docs/assets/cockpit-session.png)

It shows your agents' sessions, every turn, every model call and its cost. It uses only the public
AgentBus API, so anything it shows, your own program can read too.

**The cockpit ships inside AgentBus.** `agentbus up` serves it on its own address and opens it
signed in. To use it, follow the
[AgentBus Quickstart](https://github.com/staysup/agentbus#quickstart). You do not need this
repository for that.

This repository is for working on the cockpit itself, with its dev server.

## Demo

[![AgentBus cockpit demo](https://img.youtube.com/vi/si0HHQFcCD0/maxresdefault.jpg)](https://youtu.be/si0HHQFcCD0)

## Work on the cockpit

You need Node.js 20.19 or later in the 20 line, or 22.12 or later (Vite needs one of these), and a
running AgentBus (`agentbus up`) of the same version.

1. Start AgentBus:

   ```sh
   agentbus up
   ```

   Any browser origin may call it, because every call needs the token. To allow only the dev
   server, start it with `agentbus up -origin http://localhost:5173` instead. That origin must then
   match exactly: open the cockpit at `localhost`, not `127.0.0.1`, or pass that origin.

2. In this folder, install and start the dev server:

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

   Paste it into the Token field and press Connect. The dev server never uses the sign-in link;
   only the cockpit that `agentbus up` serves does.

To work on the cockpit with no service, add `?recorded` to the address
(`http://localhost:5173/?recorded`). It opens a recorded sample. The connect screen has no
button for it, so people using the cockpit never land there.

## Using it

- **An agent is a saved setup**: a harness (Claude Code, Codex or Antigravity), how it reaches a
  model (a subscription connected in Settings, or the OpenRouter key set in Settings), the
  model and a name. "+ Agent" makes one. A subscription agent starts with no model,
  so the tool picks its own; type a model name to pin one.
- **+ Session** picks a machine, then a folder on it, and the first message. The session works on
  its own copy of the folder. Your folder does not change until a turn is applied.
- **Sessions lists every conversation, newest first.** A conversation is a list of turns, and each
  turn names its agent, so a row shows the agent of its first turn, and the agent of its latest turn
  when that is another one. The Agents column lists only the saved agents.
- **Any message may go to any agent.** Pick it beside Send. Messages sent while a turn runs wait
  and run next.
- **Other agents answer in the conversation.** Ask in the chat, for example "ask codex to add a
  test". The answer comes back as the next turn.
- **Click a turn** to see its result, prompt, events, every model call with its cost, and its tools.

## Runners and Settings

**Runners** (at the foot of the Agents column) lists each machine, whether it is online, and whether
it can build a session's sandbox. A machine that ran `agentbus login` waits there: type the code it
shows and press Approve. An offline machine can be removed. The steps are in the
[AgentBus README](https://github.com/staysup/agentbus#several-machines).

![The Runners page: a machine waiting for approval](docs/assets/cockpit-runners.png)

**Settings** holds what every turn may do and the instructions every turn gets, the same on every
machine. Each setting has its own control, in groups: Agents, Files, Home files, Commands, Network,
Sandbox and Limits. A save sends only what you changed. The policy as JSON is under **Advanced**.

![The Settings page](docs/assets/cockpit-settings.png)

Connect each subscription once, in **Settings** under Subscriptions (or in a subscription agent's
form), before its first turn. **Connect** runs the harness's own login on control. The token stays
on control and is never shown. Every turn uses it, on one machine (`agentbus up`) as on many: a
tool's own sign-in on the machine is not used. A code the login rejects says so at once, and
**Cancel** stops a connect that is running.

For OpenRouter agents, paste your OpenRouter key once in the same place (**OpenRouter key**,
**Save**). It is a password field: the key is sent once and never shown again. The row then says
"set", with **Replace** and **Remove**. Control adds the key to each OpenRouter call; no runner or
agent holds it. The agent form has no field for a key: Settings is the one place. An agent saved
before this may still name an environment variable for its key, and control still reads it; a key
set in Settings wins.

The agent form's **Model** offers the models the agent's access can use now, with their names where
the source gives one. It says where the list came from and when, and **Refresh** reads it again. You
can still type any name, and an empty one uses the tool's own default.

## Build

```sh
npm run build
```

This writes `dist/`. An AgentBus release packs it into the `agentbus` binary, built at the cockpit
tag of the same version (`tools/pack-cockpit.sh` in the AgentBus repository). To try a build of
your own inside agentbus, run `tools/pack-cockpit.sh --from <this folder>/dist` there and build
`agentbus`. You can also serve `dist/` from any static host: plain `agentbus up` accepts it; to
lock the service to that host, pass its origin to `agentbus up -origin`.

## Test

```sh
npm test
```

## License

Free to use, change and run, including inside your business. You can't sell it as a competing product or service. Each release becomes Apache 2.0 two years after it is published.

Licensed under the [Functional Source License](https://fsl.software) (FSL-1.1-ALv2). See [LICENSE](LICENSE).
