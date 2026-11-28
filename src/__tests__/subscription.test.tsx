// @vitest-environment jsdom
import { act, StrictMode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ConnectStep, pollMs, SubscriptionApi } from '../components/ConnectStep';
import { AgentsDialog } from '../components/AgentsDialog';
import { ConnectView, SubscriptionList } from '../types';
import { connectView } from '../data/LiveDataSource';
import { click, flush, render } from './helpers';

// A fake control for a login that wants the code the page shows (claude and
// agy): it connects on c0de. No token is ever in what it answers, as the
// API's never is, and an ended connect has no link, as the API's has none.
function fakeApi(harness = 'claude', link = 'https://claude.example/oauth?code=1', renews = false) {
  let list: SubscriptionList = { subscriptions: [{ harness, connected: false, expired: false }] };
  let view: ConnectView = { harness, state: 'running', output: [link], paste: true };
  const api: SubscriptionApi = {
    list: vi.fn(async () => list),
    connect: vi.fn(async () => view),
    get: vi.fn(async () => view),
    input: vi.fn(async (_h: string, line: string) => {
      if (line !== 'c0de') return;
      view = { harness, state: 'connected', output: [], paste: false };
      list = {
        ...list,
        subscriptions: [
          renews
            ? { harness, connected: true, renews: true, expired: false, expires_at: '2026-11-11T13:00:00Z' }
            : { harness, connected: true, expired: false, expires_at: '2027-11-10T00:00:00Z' },
        ],
      };
    }),
  };
  return api;
}

async function waitFor(ok: () => boolean, what: string) {
  for (let i = 0; i < 80 && !ok(); i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
  }
  if (!ok()) throw new Error('waited for ' + what);
}

const phase = (root: HTMLElement) => root.querySelector('.connect-step')?.getAttribute('data-phase');

describe('subscription sign-in in New agent', () => {
  const url = 'https://auth.example/device';
  const pending: ConnectView = { harness: 'codex', state: 'running', output: [url], code: 'DEMO-CODE', paste: false };
  const loadHarnesses = async () => [{
    name: 'codex', found: true,
    access: [{ kind: 'subscription', label: 'ChatGPT subscription', models: [], any_model: true }],
  }];

  it('waits for the explicit sign-in action, checks on return and restores the edited form', async () => {
    const tab = {
      opener: window as Window | null,
      document: document.implementation.createHTMLDocument(),
    };
    const navigate = vi.fn((event: MouseEvent) => event.preventDefault());
    tab.document.body.addEventListener('click', navigate);
    const open = vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window);
    let finishCopy!: () => void;
    const writeText = vi.fn((_code: string) => new Promise<void>((resolve) => { finishCopy = resolve; }));
    vi.stubGlobal('navigator', Object.create(navigator, { clipboard: { value: { writeText } } }));
    let started!: (v: ConnectView) => void;
    let polled!: (v: ConnectView) => void;
    const api: SubscriptionApi = {
      ...fakeApi('codex', url),
      connect: vi.fn(() => new Promise<ConnectView>((resolve) => { started = resolve; })),
      get: vi.fn(() => new Promise<ConnectView>((resolve) => { polled = resolve; })),
      cancel: vi.fn(async () => {}),
    };
    const view = await render(<AgentsDialog loadHarnesses={loadHarnesses} subscriptions={api}
      createAgent={vi.fn()} updateAgent={vi.fn()} onClose={vi.fn()} />);
    const { container } = view;
    try {
      await click(container.querySelector('.ad-options'));
      await type(container.querySelector('input[name="name"]')!, 'Codex reviewer');
      expect(container.querySelector('[aria-labelledby="ad-access-label"] .cs-connect')).not.toBeNull();
      await click(container.querySelector('.cs-connect'));
      expect(open).not.toHaveBeenCalled();
      expect(container.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe('Connect Codex');
      expect(container.querySelector('[aria-labelledby="ad-access-label"]')).toBeNull();
      expect(container.querySelector('.ad-save')?.closest('[hidden]')).not.toBeNull();
      await act(async () => started({ ...pending, output: [], code: undefined }));
      expect(container.querySelector('.cs-open')).toBeNull();
      expect(container.querySelector('.cs-sign-in-footer .cs-cancel')?.textContent).toBe('Cancel sign-in');
      await act(async () => { window.dispatchEvent(new Event('focus')); });
      await act(async () => polled(pending));
      expect(open).not.toHaveBeenCalled();
      expect(writeText).not.toHaveBeenCalled();
      expect(container.querySelector('.cs-code')?.textContent).toBe('DEMO-CODE');
      const signIn = container.querySelector<HTMLAnchorElement>('.cs-open')!;
      expect(container.querySelector('.cs-progress')?.textContent).toBe('Ready to sign in');
      expect(signIn.textContent).toBe('Copy code and open sign-in');
      expect(signIn.href).toBe(url);
      expect(signIn.target).toBe('_blank');
      await click(signIn);
      expect(writeText).toHaveBeenCalledExactlyOnceWith('DEMO-CODE');
      expect(open).not.toHaveBeenCalled();
      await act(async () => finishCopy());
      expect(open).toHaveBeenCalledExactlyOnceWith('', '_blank');
      expect(navigate).toHaveBeenCalledTimes(1);
      expect(tab.document.querySelector('a')?.href).toBe(url);
      expect(tab.document.querySelector('a')?.rel).toBe('noreferrer');
      expect(tab.opener).toBeNull();
      expect(container.querySelector('.cs-progress')?.textContent).toBe('Waiting for sign-in in the other tab…');
      expect(container.querySelector('.cs-spinner')).not.toBeNull();
      expect(signIn.textContent).toBe('Reopen sign-in page');
      await act(async () => { window.dispatchEvent(new Event('focus')); });
      expect(container.querySelector('.cs-progress')?.textContent).toBe('Checking connection…');
      expect(container.querySelector('.cs-spinner')).not.toBeNull();
      await act(async () => polled({ harness: 'codex', state: 'connected', output: [], paste: false }));
      expect(container.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe('New agent');
      expect(container.querySelector('.cs-status')?.textContent).toBe('connected');
      expect(container.querySelector<HTMLInputElement>('input[name="name"]')?.value).toBe('Codex reviewer');
      expect(container.querySelector('a.cs-open')).toBeNull();
    } finally {
      view.unmount();
      open.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it('rechecks on return when a background poll is already in flight', async () => {
    const waiting = { ...pending, code: undefined };
    let finishPoll!: (v: ConnectView) => void;
    let finishCheck!: (v: ConnectView) => void;
    const api = {
      ...fakeApi('codex', url),
      connect: vi.fn(async () => waiting),
      get: vi.fn()
        .mockImplementationOnce(() => new Promise<ConnectView>((resolve) => { finishPoll = resolve; }))
        .mockImplementationOnce(() => new Promise<ConnectView>((resolve) => { finishCheck = resolve; })),
    };
    vi.useFakeTimers();
    const visibility = vi.spyOn(document, 'visibilityState', 'get');
    const view = await render(<ConnectStep harness="codex" api={api} onSigningInChange={vi.fn()} />);
    const status = () => view.container.querySelector('.cs-progress')?.textContent;
    try {
      await click(view.container.querySelector('.cs-connect'));
      await click(view.container.querySelector('.cs-open'));
      visibility.mockReturnValue('hidden');
      await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
      expect(status()).toBe('Waiting for sign-in in the other tab…');
      await act(async () => { await vi.advanceTimersByTimeAsync(pollMs); });
      expect(api.get).toHaveBeenCalledTimes(1);
      visibility.mockReturnValue('visible');
      await act(async () => {
        document.dispatchEvent(new Event('visibilitychange'));
        window.dispatchEvent(new Event('focus'));
      });
      expect(status()).toBe('Checking connection…');
      expect(api.get).toHaveBeenCalledTimes(1);
      await act(async () => finishPoll(waiting));
      expect(api.get).toHaveBeenCalledTimes(2);
      expect(status()).toBe('Checking connection…');
      await act(async () => finishCheck(waiting));
      expect(status()).toBe('Waiting for sign-in in the other tab…');
      expect(api.get).toHaveBeenCalledTimes(2);
    } finally {
      view.unmount();
      visibility.mockRestore();
      vi.useRealTimers();
    }
  });

  it('keeps the device code in view when copying is blocked and lets the user open the page manually', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const writeText = vi.fn(async () => { throw new Error('Clipboard denied'); });
    vi.stubGlobal('navigator', Object.create(navigator, { clipboard: { value: { writeText } } }));
    const api = { ...fakeApi('codex', url), connect: vi.fn(async () => pending) };
    const view = await render(<ConnectStep harness="codex" api={api} onSigningInChange={vi.fn()} />);
    try {
      await click(view.container.querySelector('.cs-connect'));
      const signIn = view.container.querySelector<HTMLAnchorElement>('.cs-open')!;
      const event = new MouseEvent('click', { bubbles: true, cancelable: true });
      await act(async () => { signIn.dispatchEvent(event); });
      expect(event.defaultPrevented).toBe(true);
      expect(open).not.toHaveBeenCalled();
      expect(view.container.textContent).toContain('Couldn’t copy automatically. Copy the code manually before opening sign-in.');
      expect(view.container.querySelector('.cs-progress')?.textContent).toBe('Ready to sign in');
      expect(view.container.querySelector('.cs-code')?.textContent).toBe('DEMO-CODE');
      expect(signIn.textContent).toBe('Open sign-in page');
      expect(signIn.href).toBe(url);
    } finally {
      view.unmount();
      open.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it('offers the sign-in link when the browser blocks the automatic tab', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const writeText = vi.fn(async (_code: string) => {});
    vi.stubGlobal('navigator', Object.create(navigator, { clipboard: { value: { writeText } } }));
    const api = { ...fakeApi('codex', url), connect: vi.fn(async () => pending) };
    const view = await render(<ConnectStep harness="codex" api={api} onSigningInChange={vi.fn()} />);
    try {
      await click(view.container.querySelector('.cs-connect'));
      const link = view.container.querySelector<HTMLAnchorElement>('.cs-open')!;
      await click(link);
      expect(writeText).toHaveBeenCalledExactlyOnceWith('DEMO-CODE');
      expect(open).toHaveBeenCalledTimes(1);
      expect(link.textContent).toBe('Open sign-in page');
      expect(link.href).toBe(url);
      expect(view.container.querySelector('.cs-progress')?.textContent).toBe('Ready to sign in');
    } finally {
      view.unmount();
      open.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it('does not open the provider if cancellation was requested while the clipboard was pending', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    let finishCopy!: () => void;
    const writeText = vi.fn((_code: string) => new Promise<void>((resolve) => { finishCopy = resolve; }));
    vi.stubGlobal('navigator', Object.create(navigator, { clipboard: { value: { writeText } } }));
    const api = { ...fakeApi('codex', url), connect: vi.fn(async () => pending), cancel: vi.fn(async () => {}) };
    const view = await render(<ConnectStep harness="codex" api={api} onSigningInChange={vi.fn()} />);
    try {
      await click(view.container.querySelector('.cs-connect'));
      await click(view.container.querySelector('.cs-open'));
      await click(view.container.querySelector('.cs-cancel'));
      await act(async () => finishCopy());
      expect(api.cancel).toHaveBeenCalledExactlyOnceWith('codex');
      expect(open).not.toHaveBeenCalled();
      expect(view.container.querySelector('.cs-open')).toBeNull();
    } finally {
      view.unmount();
      open.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it('closes the access dropdown when the service reports a running sign-in', async () => {
    let deliverList!: (list: SubscriptionList) => void;
    const api = {
      ...fakeApi('codex', url),
      list: vi.fn(() => new Promise<SubscriptionList>((resolve) => { deliverList = resolve; })),
    };
    const harnesses = async () => [{
      name: 'codex', found: true,
      access: [
        { kind: 'subscription', label: 'ChatGPT subscription', models: [] },
        { kind: 'api', label: 'API key', models: [] },
      ],
    }];
    const view = await render(<AgentsDialog loadHarnesses={harnesses} subscriptions={api}
      createAgent={vi.fn()} updateAgent={vi.fn()} onClose={vi.fn()} />);
    try {
      const access = view.container.querySelector<HTMLButtonElement>('button[name="access"]')!;
      await click(access);
      expect(document.querySelector('[role="listbox"] [data-value="api"]')).not.toBeNull();
      await act(async () => deliverList({ subscriptions: [
        { harness: 'codex', connected: false, expired: false, connect: pending },
      ] }));
      expect(access.disabled).toBe(true);
      expect(access.value).toBe('subscription');
      expect(document.querySelector('[role="listbox"]')).toBeNull();
      expect(view.container.querySelector('.cs-dedicated')).not.toBeNull();
    } finally {
      view.unmount();
    }
  });

  it('Esc restores the draft while Connect is pending and ignores its late answer', async () => {
    let finishStart!: (view: ConnectView) => void;
    const api = {
      ...fakeApi('codex', url),
      connect: vi.fn(() => new Promise<ConnectView>((resolve) => { finishStart = resolve; })),
      cancel: vi.fn(async () => {}),
    };
    const onClose = vi.fn();
    const view = await render(<AgentsDialog loadHarnesses={loadHarnesses} subscriptions={api}
      createAgent={vi.fn()} updateAgent={vi.fn()} onClose={onClose} />);
    try {
      const { container } = view;
      await click(container.querySelector('.ad-options'));
      await type(container.querySelector('input[name="name"]')!, 'Codex reviewer');
      await click(container.querySelector('.cs-connect'));
      expect(container.querySelector('.cs-cancel')?.textContent).toBe('Back to setup');
      await act(async () => {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      });
      await act(async () => finishStart(pending));
      expect(container.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe('New agent');
      expect(container.querySelector<HTMLInputElement>('input[name="name"]')?.value).toBe('Codex reviewer');
      expect(api.cancel).not.toHaveBeenCalled();
      expect(onClose).not.toHaveBeenCalled();
    } finally {
      view.unmount();
    }
  });

  it('offers Back to setup during sign-in on servers that cannot cancel', async () => {
    const api = { ...fakeApi('codex', url), connect: vi.fn(async () => pending) };
    const view = await render(<AgentsDialog loadHarnesses={loadHarnesses} subscriptions={api}
      createAgent={vi.fn()} updateAgent={vi.fn()} onClose={vi.fn()} />);
    try {
      await click(view.container.querySelector('.cs-connect'));
      const back = view.container.querySelector('.cs-cancel');
      expect(back?.textContent).toBe('Back to setup');
      await click(back);
      expect(view.container.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe('New agent');
      expect(view.container.querySelector('.cs-dedicated')).toBeNull();
    } finally {
      view.unmount();
    }
  });

  it('offers an ordinary sign-in link when the provider has no device code', async () => {
    const view = await render(<ConnectStep harness="claude" api={fakeApi()} onSigningInChange={vi.fn()} />);
    try {
      await click(view.container.querySelector('.cs-connect'));
      expect(view.container.querySelector('.cs-open')?.textContent).toBe('Open sign-in page');
      expect(view.container.querySelector('.cs-code')).toBeNull();
      expect(view.container.querySelector('[aria-label="Code from the sign-in page"]')).not.toBeNull();
    } finally {
      view.unmount();
    }
  });
});

async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    set.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

// Nothing of a login is left on the page: no link, no code, no field.
function noLogin(root: HTMLElement, link: string) {
  expect(root.querySelector('.cs-login')).toBeNull();
  expect(root.querySelector('a')).toBeNull();
  expect(root.querySelector('.cs-input')).toBeNull();
  expect(root.innerHTML).not.toContain(link);
}

describe('ConnectStep', () => {
  // claude and agy: the same steps, the same words.
  for (const [harness, link, renews, done] of [
    ['claude', 'https://claude.example/oauth?code=1', false, 'until 2027-11-10'],
    ['agy', 'https://accounts.google.example/o/oauth2/auth?client_id=x', true, 'renews automatically'],
  ] as const) {
    it(`connects ${harness} with a pasted code, then shows only that it is connected`, async () => {
      const api = fakeApi(harness, link, renews);
      const { container } = await render(<ConnectStep harness={harness} api={api} />);
      await flush();
      expect(phase(container)).toBe('not-connected');
      expect(container.querySelector('.cs-status')?.textContent).toBe('not connected');
      // Every runner is the person's own: no switch to turn on.
      expect(container.textContent).not.toContain('subscriptions_on_runners');
      expect(container.textContent).not.toContain('Turn on for my runners');
      expect(container.querySelector('.cs-on')).toBeNull();

      await click(container.querySelector('.cs-connect'));
      await flush();
      expect(phase(container)).toBe('connecting');
      expect((container.querySelector('.cs-connect') as HTMLButtonElement).disabled).toBe(true);
      // The link is a button, never its text.
      const open = container.querySelector('a.cs-open') as HTMLAnchorElement;
      expect(open.textContent).toBe('Open sign-in page');
      expect(open.href).toBe(link);
      expect(open.rel).toContain('noopener');
      expect(container.textContent).not.toContain(link);
      expect(container.textContent).toContain('paste the code the page shows');

      const input = container.querySelector('.cs-input input') as HTMLInputElement;
      await type(input, 'c0de');
      await act(async () => {
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      });
      await click(container.querySelector('.cs-input button')); // a second send is not sent
      expect(api.input).toHaveBeenCalledTimes(1);
      expect(api.input).toHaveBeenCalledWith(harness, 'c0de');
      await flush();
      // Taken: the field stays closed while the login checks it.
      expect((container.querySelector('.cs-input input') as HTMLInputElement | null)?.disabled ?? true).toBe(true);

      await waitFor(() => phase(container) === 'connected', 'connected');
      expect(container.querySelector('.cs-status')?.textContent).toBe('connected');
      expect(container.querySelector('.cs-until')?.textContent).toBe(done);
      expect(container.querySelector('.cs-connect')?.textContent).toBe('Connect again');
      noLogin(container, link);
    });
  }

  it('shows nothing where the service connects no subscriptions', async () => {
    const api = { ...fakeApi(), list: vi.fn(async () => null) };
    const { container } = await render(<ConnectStep harness="claude" api={api} />);
    await flush();
    expect(api.list).toHaveBeenCalled();
    expect(container.querySelector('.connect-step')).toBeNull();
  });

  it('shows why the subscriptions could not be read', async () => {
    const api = {
      ...fakeApi(),
      list: vi.fn(async () => {
        throw new Error('the token is not valid');
      }),
    };
    const { container } = await render(<ConnectStep harness="claude" api={api} />);
    await flush();
    expect(container.textContent).toContain('the token is not valid');
  });

  it('keeps the code when sending fails, sends no empty line, and ends a login it cannot read', async () => {
    const base = fakeApi();
    let fail = true;
    const api: SubscriptionApi = {
      ...base,
      input: vi.fn(async () => {
        if (fail) throw new Error('no login is running for claude');
      }),
      get: vi.fn(async () => {
        throw new Error('no login was started for claude since control started');
      }),
    };
    const { container } = await render(<ConnectStep harness="claude" api={api} />);
    await flush();
    await click(container.querySelector('.cs-connect'));
    await flush();
    const input = container.querySelector('.cs-input input') as HTMLInputElement;
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(api.input).not.toHaveBeenCalled();
    await type(input, 'c0de');
    await click(container.querySelector('.cs-input button'));
    await flush();
    expect(container.textContent).toContain('no login is running');
    const again = container.querySelector('.cs-input input') as HTMLInputElement;
    expect(again.value).toBe('c0de');
    expect(again.disabled).toBe(false);
    fail = false;
    // The poll cannot read the login: it failed, and Try again comes back.
    await waitFor(() => phase(container) === 'failed', 'failed');
    expect(container.querySelector('.cs-why')?.textContent).toContain('no login was started');
    expect(container.querySelector('.cs-connect')?.textContent).toBe('Try again');
    noLogin(container, 'claude.example');
  });

  it('fails with the reason a login could not start, and tries again', async () => {
    const api = fakeApi('agy', 'https://accounts.google.example/x');
    let n = 0;
    api.connect = vi.fn(async () => {
      if (n++ === 0) throw new Error('agy keeps its sign-in in a file only on Linux');
      return { harness: 'agy', state: 'running' as const, output: ['https://accounts.google.example/x'], paste: true };
    });
    const { container } = await render(<ConnectStep harness="agy" api={api} />);
    await flush();
    await click(container.querySelector('.cs-connect'));
    await flush();
    expect(phase(container)).toBe('failed');
    expect(container.querySelector('.cs-status')?.textContent).toBe('failed');
    expect(container.querySelector('.cs-why')?.textContent).toBe('agy keeps its sign-in in a file only on Linux');
    await click(container.querySelector('.cs-connect'));
    await flush();
    expect(phase(container)).toBe('connecting');
    expect(container.querySelector('.cs-why')).toBeNull();
  });

  it('shows the reason a login refused the code, and no link', async () => {
    const api = fakeApi();
    const why = 'the login did not accept the code: connect again for a new link';
    api.input = vi.fn(async () => {
      (api as { get: SubscriptionApi['get'] }).get = vi.fn(async () => ({
        harness: 'claude',
        state: 'failed' as const,
        output: [],
        paste: false,
        error: why,
      }));
    });
    const { container } = await render(<ConnectStep harness="claude" api={api} />);
    await flush();
    await click(container.querySelector('.cs-connect'));
    await flush();
    await type(container.querySelector('.cs-input input') as HTMLInputElement, 'wrong');
    await click(container.querySelector('.cs-input button'));
    await waitFor(() => phase(container) === 'failed', 'failed');
    expect(container.querySelector('.cs-why')?.textContent).toBe(why);
    noLogin(container, 'claude.example');
  });

  it('shows connected when the list cannot be read again after it connected', async () => {
    const api = fakeApi();
    const list = api.list;
    const { container } = await render(<ConnectStep harness="claude" api={api} />);
    await flush();
    await click(container.querySelector('.cs-connect'));
    await flush();
    api.list = vi.fn(async () => {
      throw new Error('the service did not answer');
    });
    await type(container.querySelector('.cs-input input') as HTMLInputElement, 'c0de');
    await click(container.querySelector('.cs-input button'));
    await waitFor(() => phase(container) !== 'connecting', 'the connect ended');
    expect(phase(container)).toBe('connected');
    expect(container.querySelector('.cs-connect')?.textContent).toBe('Connect again');
    noLogin(container, 'claude.example');
    expect(list).toHaveBeenCalled();
  });

  it('shows connected at once when the connect answers connected', async () => {
    const api = fakeApi();
    let release = () => {};
    const held = new Promise<void>((r) => (release = r));
    const list = api.list;
    api.connect = vi.fn(async () => ({ harness: 'claude', state: 'connected' as const, output: [], paste: false }));
    const { container } = await render(<ConnectStep harness="claude" api={api} />);
    await flush();
    api.list = vi.fn(async () => {
      await held;
      return list();
    });
    await click(container.querySelector('.cs-connect'));
    await flush();
    // The list is still being read: it is connected all the same, and
    // Connect again starts no second login before that click.
    expect(phase(container)).toBe('connected');
    expect(api.connect).toHaveBeenCalledTimes(1);
    await act(async () => release());
  });

  it('starts one connect for two quick clicks', async () => {
    const api = fakeApi();
    let release = (_v: ConnectView) => {};
    api.connect = vi.fn(() => new Promise<ConnectView>((r) => (release = r)));
    const { container } = await render(<ConnectStep harness="claude" api={api} />);
    await flush();
    const btn = container.querySelector('.cs-connect') as HTMLButtonElement;
    await act(async () => {
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await click(container.querySelector('.cs-connect'));
    expect(api.connect).toHaveBeenCalledTimes(1);
    expect((container.querySelector('.cs-connect') as HTMLButtonElement).disabled).toBe(true);
    expect(container.textContent).toContain('Waiting for the sign-in page');
    await act(async () => release({ harness: 'claude', state: 'running', output: ['https://claude.example/a'], paste: true }));
  });

  it('says a harness without a login cannot be connected', async () => {
    const api = fakeApi();
    const { container } = await render(<ConnectStep harness="codex" api={api} />);
    await flush();
    expect(container.textContent).toContain('AgentBus cannot connect this sign-in.');
    expect(container.textContent).not.toMatch(/\bcontrol\b/);
  });

  // A code the login did not take ends the connect at once, as rejected,
  // with control's words, and Try again starts a new one.
  it('says a rejected code was rejected, and offers to try again', async () => {
    const api = fakeApi();
    const why = 'the code was rejected: it may be incomplete, expired, already used, or from an earlier sign-in; try again, Connect gives a new link';
    api.input = vi.fn(async () => {
      (api as { get: SubscriptionApi['get'] }).get = vi.fn(async () => ({
        harness: 'claude',
        state: 'failed' as const,
        output: [],
        paste: false,
        rejected: true,
        error: why,
      }));
    });
    const { container } = await render(<ConnectStep harness="claude" api={api} />);
    await flush();
    await click(container.querySelector('.cs-connect'));
    await flush();
    await type(container.querySelector('.cs-input input') as HTMLInputElement, 'wrong');
    await click(container.querySelector('.cs-input button'));
    await waitFor(() => phase(container) === 'failed', 'failed');
    expect(container.querySelector('.cs-status')?.textContent).toBe('code rejected');
    expect(container.querySelector('.cs-why')?.textContent).toBe(why);
    expect(container.querySelector('.cs-connect')?.textContent).toBe('Try again');
    noLogin(container, 'claude.example');
  });

  // While it connects, Cancel stops the login on control; once control says
  // it ended as cancelled, the step is as it was before, with no error.
  it('cancels a running connect', async () => {
    const api = fakeApi();
    api.cancel = vi.fn(async () => {
      (api as { get: SubscriptionApi['get'] }).get = vi.fn(async () => ({
        harness: 'claude',
        state: 'failed' as const,
        output: [],
        paste: false,
        cancelled: true,
        error: 'the connect was cancelled',
      }));
    });
    const { container } = await render(<ConnectStep harness="claude" api={api} />);
    await flush();
    expect(container.querySelector('.cs-cancel')).toBeNull();
    await click(container.querySelector('.cs-connect'));
    await flush();
    expect(phase(container)).toBe('connecting');
    expect(container.querySelector('.cs-connect')).toBeNull();
    await click(container.querySelector('.cs-cancel'));
    expect(api.cancel).toHaveBeenCalledWith('claude');
    await waitFor(() => phase(container) === 'not-connected', 'not connected');
    expect(container.querySelector('.cs-why')).toBeNull();
    expect(container.querySelector('.cs-connect')?.textContent).toBe('Connect');
    noLogin(container, 'claude.example');
  });

  // A Cancel the service refuses because the login ended already (409),
  // here after a connect that succeeded, never sticks: the step shows how
  // the login ended. Two quick clicks send one cancel.
  it('a late or doubled Cancel does not stick on how the login ended', async () => {
    const api = fakeApi();
    let cancels = 0;
    api.cancel = vi.fn(async () => {
      cancels++;
      (api as { get: SubscriptionApi['get'] }).get = vi.fn(async () => ({ harness: 'claude', state: 'connected' as const, output: [], paste: false }));
      throw new Error('no login is running for claude');
    });
    const { container } = await render(<ConnectStep harness="claude" api={api} />);
    await flush();
    await click(container.querySelector('.cs-connect'));
    await flush();
    const btn = container.querySelector('.cs-cancel') as HTMLButtonElement;
    await act(async () => {
      btn.click();
      btn.click();
    });
    expect(cancels).toBe(1);
    await waitFor(() => phase(container) === 'connected', 'connected');
    expect(container.textContent).not.toContain('no login is running');
  });

  // A read that fails while a cancel is on its way ends that login; the
  // next connect's Cancel works, not stuck on "Cancelling".
  it('a poll error during a cancel leaves the next Cancel usable', async () => {
    const api = fakeApi();
    let release: () => void = () => {};
    api.cancel = vi.fn(() => new Promise<void>((r) => (release = r)));
    const { container } = await render(<ConnectStep harness="claude" api={api} />);
    await flush();
    await click(container.querySelector('.cs-connect'));
    await flush();
    await click(container.querySelector('.cs-cancel'));
    (api as { get: SubscriptionApi['get'] }).get = vi.fn(async () => {
      throw new Error('control could not be reached');
    });
    await waitFor(() => phase(container) === 'failed', 'failed');
    await act(async () => release());
    (api as { get: SubscriptionApi['get'] }).get = vi.fn(async () => ({ harness: 'claude', state: 'running' as const, output: ['https://claude.example/a'], paste: true }));
    await click(container.querySelector('.cs-connect'));
    await flush();
    const next = container.querySelector('.cs-cancel') as HTMLButtonElement;
    expect(next.textContent).toBe('Cancel');
    expect(next.disabled).toBe(false);
  });

  // Review round 2, order 1: the read applies how the login ended first,
  // then the cancel's refusal (409) arrives. Its answer is never shown.
  it('a cancel refused after the end was shown changes nothing', async () => {
    const api = fakeApi();
    let refuse: (e: Error) => void = () => {};
    api.cancel = vi.fn(() => new Promise<void>((_, rej) => (refuse = rej)));
    const { container } = await render(<ConnectStep harness="claude" api={api} />);
    await flush();
    await click(container.querySelector('.cs-connect'));
    await flush();
    await click(container.querySelector('.cs-cancel'));
    // Held from the click until that login ends.
    expect((container.querySelector('.cs-cancel') as HTMLButtonElement).disabled).toBe(true);
    (api as { get: SubscriptionApi['get'] }).get = vi.fn(async () => ({ harness: 'claude', state: 'connected' as const, output: [], paste: false }));
    await waitFor(() => phase(container) === 'connected', 'connected');
    await act(async () => refuse(new Error('no login is running for claude')));
    await flush();
    expect(phase(container)).toBe('connected');
    expect(container.textContent).not.toContain('no login is running');
  });

  // Review round 2, order 2: a cancel still on its way when its login has
  // ended and the person has started the next one. Its late refusal never
  // lands on the new login, whose Cancel is free.
  it('a late cancel answer never lands on the next login', async () => {
    const api = fakeApi();
    let refuse: (e: Error) => void = () => {};
    api.cancel = vi.fn(() => new Promise<void>((_, rej) => (refuse = rej)));
    const { container } = await render(<ConnectStep harness="claude" api={api} />);
    await flush();
    await click(container.querySelector('.cs-connect'));
    await flush();
    await click(container.querySelector('.cs-cancel'));
    (api as { get: SubscriptionApi['get'] }).get = vi.fn(async () => ({
      harness: 'claude', state: 'failed' as const, output: [], paste: false, cancelled: true, error: 'the connect was cancelled',
    }));
    await waitFor(() => phase(container) === 'not-connected', 'ended');
    (api as { get: SubscriptionApi['get'] }).get = vi.fn(async () => ({ harness: 'claude', state: 'running' as const, output: ['https://claude.example/b'], paste: true }));
    await click(container.querySelector('.cs-connect'));
    await flush();
    expect(phase(container)).toBe('connecting');
    await act(async () => refuse(new Error('no login is running for claude')));
    await flush();
    expect(container.textContent).not.toContain('no login is running');
    const next = container.querySelector('.cs-cancel') as HTMLButtonElement;
    expect(next.textContent).toBe('Cancel');
    expect(next.disabled).toBe(false);
  });

  // Range review, finding 1: the cancel request itself fails (control not
  // reached, 5xx) while the login still runs. Cancel is free again at once
  // for that login, the failure is not shown, and the poll still decides.
  it('a failed cancel frees Cancel while its login still runs', async () => {
    const api = fakeApi();
    let fail: (e: Error) => void = () => {};
    api.cancel = vi.fn(() => new Promise<void>((_, rej) => (fail = rej)));
    const { container } = await render(<ConnectStep harness="claude" api={api} />);
    await flush();
    await click(container.querySelector('.cs-connect'));
    await flush();
    await click(container.querySelector('.cs-cancel'));
    expect((container.querySelector('.cs-cancel') as HTMLButtonElement).disabled).toBe(true);
    await act(async () => fail(new Error('control could not be reached')));
    await flush();
    expect(phase(container)).toBe('connecting');
    const btn = container.querySelector('.cs-cancel') as HTMLButtonElement;
    expect(btn.textContent).toBe('Cancel');
    expect(btn.disabled).toBe(false);
    expect(container.textContent).not.toContain('could not be reached');
    // A second try is sent.
    await click(btn);
    expect(api.cancel).toHaveBeenCalledTimes(2);
  });

  // Range review, finding 2: a code is sent, Cancel ends that login, and
  // Connect starts the next. The first code's late success belongs to the
  // first login and never closes the new login's field.
  it('a late code answer never lands on the next login', async () => {
    const api = fakeApi();
    let took: () => void = () => {};
    api.input = vi.fn(() => new Promise<void>((r) => (took = r)));
    api.cancel = vi.fn(async () => {
      (api as { get: SubscriptionApi['get'] }).get = vi.fn(async () => ({
        harness: 'claude', state: 'failed' as const, output: [], paste: false, cancelled: true, error: 'the connect was cancelled',
      }));
    });
    const { container } = await render(<ConnectStep harness="claude" api={api} />);
    await flush();
    await click(container.querySelector('.cs-connect'));
    await flush();
    await type(container.querySelector('.cs-input input') as HTMLInputElement, 'c0de');
    await click(container.querySelector('.cs-input button'));
    expect(api.input).toHaveBeenCalledTimes(1);
    await click(container.querySelector('.cs-cancel'));
    await waitFor(() => phase(container) === 'not-connected', 'ended');
    (api as { get: SubscriptionApi['get'] }).get = vi.fn(async () => ({ harness: 'claude', state: 'running' as const, output: ['https://claude.example/b'], paste: true }));
    await click(container.querySelector('.cs-connect'));
    await flush();
    expect(phase(container)).toBe('connecting');
    await act(async () => took());
    await flush();
    const input = container.querySelector('.cs-input input') as HTMLInputElement;
    expect(input.disabled).toBe(false);
    expect(container.textContent).not.toContain('Code sent');
    await type(input, 'c0de');
    await click(container.querySelector('.cs-input button'));
    expect(api.input).toHaveBeenCalledTimes(2);
  });

  it('offers no Cancel where the service cannot cancel', async () => {
    const api = fakeApi();
    const { container } = await render(<ConnectStep harness="claude" api={api} />);
    await flush();
    await click(container.querySelector('.cs-connect'));
    await flush();
    expect(container.querySelector('.cs-cancel')).toBeNull();
    expect(container.querySelector('.cs-connect')).not.toBeNull();
  });
});

describe('connectView', () => {
  it('takes a login that printed nothing yet', () => {
    expect(connectView({ harness: 'claude', state: 'running', output: null as unknown as string[], paste: true }).output).toEqual([]);
  });
  it('keeps the one-time code of a device login', () => {
    const v = connectView({ harness: 'codex', state: 'running', output: [], code: 'ABCD-EFGH2', paste: false });
    expect(v.code).toBe('ABCD-EFGH2');
    expect(v.paste).toBe(false);
  });
  it('asks for a pasted code only when control says so', () => {
    expect(connectView({ harness: 'claude', state: 'running', output: [], paste: true }).paste).toBe(true);
    expect(connectView({ harness: 'codex', state: 'running', output: [] }).paste).toBe(false);
  });
});

describe('ConnectStep on open', () => {
  it('does not show a login that ended before it was opened', async () => {
    const api = fakeApi();
    const ended = { harness: 'claude', state: 'failed' as const, output: ['https://claude.example/old'], paste: false, error: 'old' };
    api.list = vi.fn(async () => ({ subscriptions: [{ harness: 'claude', connected: false, expired: false, connect: ended }] }));
    const { container } = await render(<ConnectStep harness="claude" api={api} />);
    await flush();
    expect(phase(container)).toBe('not-connected');
    noLogin(container, 'claude.example/old');
  });

  it('follows a login still running, with Connect held', async () => {
    const api = fakeApi();
    const running = { harness: 'claude', state: 'running' as const, output: ['https://claude.example/now'], paste: true };
    api.list = vi.fn(async () => ({ subscriptions: [{ harness: 'claude', connected: false, expired: false, connect: running }] }));
    const { container } = await render(<ConnectStep harness="claude" api={api} />);
    await flush();
    expect(phase(container)).toBe('connecting');
    expect((container.querySelector('.cs-connect') as HTMLButtonElement).disabled).toBe(true);
    expect((container.querySelector('a.cs-open') as HTMLAnchorElement).href).toBe('https://claude.example/now');
  });
});

describe('ConnectStep while a send runs', () => {
  it('sends a code once while the first send is still running', async () => {
    const api = fakeApi();
    let release = () => {};
    api.input = vi.fn(() => new Promise<void>((r) => (release = r)));
    const { container } = await render(<ConnectStep harness="claude" api={api} />);
    await flush();
    await click(container.querySelector('.cs-connect'));
    await flush();
    const input = container.querySelector('.cs-input input') as HTMLInputElement;
    await type(input, 'c0de');
    const btn = container.querySelector('.cs-input button') as HTMLButtonElement;
    await act(async () => {
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(api.input).toHaveBeenCalledTimes(1);
    expect(input.disabled).toBe(true);
    expect(btn.disabled).toBe(true);
    await act(async () => release());
    // Accepted: still closed, until the login ends.
    expect(input.disabled).toBe(true);
    expect(container.textContent).toContain('Code sent. Checking it.');
  });
});

describe('ConnectStep in StrictMode', () => {
  it('shows the subscription when mounted twice', async () => {
    const api = fakeApi();
    const { container } = await render(
      <StrictMode>
        <ConnectStep harness="claude" api={api} />
      </StrictMode>,
    );
    await flush();
    expect(container.textContent).toContain('not connected');
  });
});

describe('ConnectStep with a device login', () => {
  // codex's device login: control shows a link and a one-time code; the
  // person enters the code at the link, and nothing is typed here.
  it('shows a device login code, asks for nothing, and drops the code once connected', async () => {
    let list: SubscriptionList = { subscriptions: [{ harness: 'codex', connected: false, expired: false }] };
    let view: ConnectView = {
      harness: 'codex',
      state: 'running',
      output: ['https://auth.example/codex/device'],
      code: 'ABCD-EFGH2',
      paste: false,
    };
    const api: SubscriptionApi = {
      list: vi.fn(async () => list),
      connect: vi.fn(async () => view),
      get: vi.fn(async () => view),
      input: vi.fn(async () => {}),
    };
    const { container } = await render(<ConnectStep harness="codex" api={api} />);
    await flush();
    await click(container.querySelector('.cs-connect'));
    await flush();
    expect(container.querySelector('.cs-code')?.textContent).toBe('ABCD-EFGH2');
    expect((container.querySelector('a.cs-open') as HTMLAnchorElement).textContent).toBe('Open sign-in page');
    expect(container.querySelector('.cs-input')).toBeNull();
    expect(container.textContent).toContain('Enter this code on the sign-in page');
    expect(container.textContent).not.toContain('https://');
    view = { harness: 'codex', state: 'connected', output: [], paste: false };
    list = {
      subscriptions: [{ harness: 'codex', connected: true, renews: true, expired: false, expires_at: '2026-11-20T00:00:00Z' }],
    };
    await waitFor(() => phase(container) === 'connected', 'connected');
    expect(container.querySelector('.cs-until')?.textContent).toBe('renews automatically');
    expect(container.textContent).not.toContain('ABCD-EFGH2');
    noLogin(container, 'auth.example');
    expect(api.input).not.toHaveBeenCalled();
  });

  it('says why a sign-in control could not renew needs connecting again', async () => {
    const why = 'the vendor refused to renew the sign-in: connect again';
    const api: SubscriptionApi = {
      ...fakeApi(),
      list: vi.fn(async () => ({
        subscriptions: [{ harness: 'codex', connected: true, renews: true, expired: true, error: why }],
      })),
    };
    const { container } = await render(<ConnectStep harness="codex" api={api} />);
    await flush();
    expect(phase(container)).toBe('failed');
    expect(container.querySelector('.cs-status')?.textContent).toBe('expired');
    expect(container.querySelector('.cs-why')?.textContent).toBe(why);
    expect(container.querySelector('.cs-connect')?.textContent).toBe('Connect again');
  });
});
