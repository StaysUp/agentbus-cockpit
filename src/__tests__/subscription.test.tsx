// @vitest-environment jsdom
import { act, StrictMode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ConnectStep, SubscriptionApi } from '../components/ConnectStep';
import { ConnectView, SubscriptionList } from '../types';
import { connectView } from '../data/LiveDataSource';
import { click, flush, render } from './helpers';

// A fake control: the login asks for a code, then connects. No token is
// ever in what it answers, as the API's never is.
function fakeApi() {
  let list: SubscriptionList = { on: false, subscriptions: [{ harness: 'claude', connected: false, expired: false }] };
  let view: ConnectView = {
    harness: 'claude',
    state: 'running',
    output: ['https://claude.example/oauth?code=1'],
  };
  const api: SubscriptionApi = {
    list: vi.fn(async () => list),
    connect: vi.fn(async () => view),
    get: vi.fn(async () => view),
    input: vi.fn(async (_h: string, line: string) => {
      if (line !== 'c0de') return;
      view = { ...view, state: 'connected' };
      list = {
        ...list,
        subscriptions: [{ harness: 'claude', connected: true, expired: false, expires_at: '2027-11-10T00:00:00Z' }],
      };
    }),
    turnOn: vi.fn(async () => {
      list = { ...list, on: true };
    }),
  };
  return api;
}

async function waitText(root: HTMLElement, text: string) {
  for (let i = 0; i < 60 && !root.textContent?.includes(text); i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
  }
  expect(root.textContent).toContain(text);
}

describe('ConnectStep', () => {
  it('connects a subscription with the login run on control', async () => {
    const api = fakeApi();
    const { container } = await render(<ConnectStep harness="claude" api={api} />);
    await flush();
    expect(container.textContent).toContain('not connected');
    expect(container.textContent).toContain('subscriptions_on_runners');
    await click(container.querySelector('.cs-on'));
    await flush();
    expect(api.turnOn).toHaveBeenCalled();
    expect(container.querySelector('.cs-on')).toBeNull();

    await click(container.querySelector('.cs-connect'));
    await flush();
    const link = container.querySelector('.cs-login a') as HTMLAnchorElement;
    expect(link.href).toBe('https://claude.example/oauth?code=1');
    expect(link.rel).toContain('noopener');

    const input = container.querySelector('.cs-input input') as HTMLInputElement;
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      set.call(input, 'c0de');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(api.input).toHaveBeenCalledTimes(1);
    await click(container.querySelector('.cs-input button')); // a second send while the first runs is not sent
    expect(api.input).toHaveBeenCalledTimes(1);
    expect(api.input).toHaveBeenCalledWith('claude', 'c0de');
    await waitText(container, 'Connected.');
    await waitText(container, 'connected, until 2027-11-10');
    expect(container.querySelector('.cs-input')).toBeNull();
  });

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
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      set.call(input, 'c0de');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click(container.querySelector('.cs-input button'));
    await flush();
    expect(container.textContent).toContain('no login is running');
    expect((container.querySelector('.cs-input input') as HTMLInputElement).value).toBe('c0de');
    fail = false;
    // The poll cannot read the login: it ends, and Connect comes back.
    await waitText(container, 'no login was started');
    expect(container.querySelector('.cs-connect')).not.toBeNull();
    expect(container.querySelector('.cs-input')).toBeNull();
  });

  it('says a harness without a login cannot use its subscription on a runner', async () => {
    const api = fakeApi();
    const { container } = await render(<ConnectStep harness="codex" api={api} />);
    await flush();
    expect(container.textContent).toContain('cannot be used yet');
  });
});

describe('connectView', () => {
  it('takes a login that printed nothing yet', () => {
    expect(connectView({ harness: 'claude', state: 'running', output: null as unknown as string[] }).output).toEqual([]);
  });
});

describe('ConnectStep on open', () => {
  it('does not show a login that ended before it was opened', async () => {
    const api = fakeApi();
    const ended = { harness: 'claude', state: 'failed' as const, output: ['https://claude.example/old'], error: 'old' };
    api.list = vi.fn(async () => ({ on: true, subscriptions: [{ harness: 'claude', connected: false, expired: false, connect: ended }] }));
    const { container } = await render(<ConnectStep harness="claude" api={api} />);
    await flush();
    expect(container.querySelector('.cs-login')).toBeNull();
    expect(container.textContent).not.toContain('claude.example/old');
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
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      set.call(input, 'c0de');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click(container.querySelector('.cs-input button'));
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    await click(container.querySelector('.cs-input button'));
    expect(api.input).toHaveBeenCalledTimes(1);
    await act(async () => release());
  });

  it('clears an old error when the switch is turned on', async () => {
    const api = fakeApi();
    let fail = true;
    api.turnOn = vi.fn(async () => {
      if (fail) throw new Error('the policy changed');
    });
    const { container } = await render(<ConnectStep harness="claude" api={api} />);
    await flush();
    await click(container.querySelector('.cs-on'));
    await flush();
    expect(container.textContent).toContain('the policy changed');
    fail = false;
    await click(container.querySelector('.cs-on'));
    await flush();
    expect(container.textContent).not.toContain('the policy changed');
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
