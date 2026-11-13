// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentsColumn } from '../components/AgentsColumn';
import { DISCUSSIONS_URL, FEEDBACK_URL } from '../components/FeedbackDialog';
import { click, flush, render, unmountAll } from './helpers';

async function setValue(el: Element | null, value: string) {
  if (!el) throw new Error('no field');
  const proto = el instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

// The column with a version, the Feedback box opened. The box is drawn on
// document.body, so it is looked for there.
async function openBox() {
  await render(<AgentsColumn agents={[]} selectedAgentId={null} onSelectAgent={() => {}} version="0.5.4" />);
  const link = [...document.querySelectorAll('.side-links .side-link')].find((x) => x.textContent === 'Feedback');
  await click(link);
  const box = document.querySelector('[role="dialog"][aria-label="Feedback"]') as HTMLElement;
  expect(box).not.toBeNull();
  return box;
}

async function fill(box: HTMLElement, { message = 'The runners page is empty', email = '', hosted = false } = {}) {
  await setValue(box.querySelector('textarea[name="message"]'), message);
  if (email) await setValue(box.querySelector('input[name="email"]'), email);
  if (hosted) await click(box.querySelector('button[role="switch"][name="wants_hosted"]'));
}

async function send(box: HTMLElement) {
  await click(box.querySelector('button.fb-send'));
  await flush();
}

describe('Feedback box', () => {
  afterEach(() => {
    unmountAll();
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  it('is a quiet link at the foot of the Agents column, after Runners and Settings', async () => {
    await render(
      <AgentsColumn agents={[]} selectedAgentId={null} onSelectAgent={() => {}} onRunners={() => {}} onSettings={() => {}} />
    );
    const names = [...document.querySelectorAll('#agents .brand-foot .side-links .side-link')].map((x) => x.textContent);
    expect(names).toEqual(['Runners', 'Settings', 'Feedback']);
  });

  it('shows the question, the fields and the line about what is sent', async () => {
    const box = await openBox();
    expect(box.textContent).toContain("What's missing or broken?");
    expect(box.querySelector('input[name="email"]')).not.toBeNull();
    expect(box.textContent).toContain('Tell me when hosted Lorebug is ready');
    expect(box.querySelector('.fb-what')!.textContent).toBe('This sends your message, and your email if given, to Lorebug.');
    // Nothing to send yet.
    expect((box.querySelector('button.fb-send') as HTMLButtonElement).disabled).toBe(true);
  });

  it('sends exactly the message, the email, the switch and the version', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    const box = await openBox();
    await fill(box, { message: '  Add a dark mode  ', email: 'me@example.com', hosted: true });
    await send(box);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(FEEDBACK_URL);
    expect(url).toBe('https://lorebug.art/api/feedback');
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('omit');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body as string)).toEqual({
      message: 'Add a dark mode',
      email: 'me@example.com',
      wants_hosted: true,
      version: '0.5.4',
    });
    expect(box.textContent).toContain('Thanks — sent.');
  });

  it('without an email or the switch sends them empty', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    const box = await openBox();
    await fill(box);
    await send(box);
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(JSON.parse(init.body as string)).toEqual({
      message: 'The runners page is empty',
      email: '',
      wants_hosted: false,
      version: '0.5.4',
    });
  });

  it('when the site refuses, says so in its words, keeps the text, links Discussions, and can send again', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('{"error":"The email does not look like an email address."}', { status: 400 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    const box = await openBox();
    await fill(box, { message: 'Keep this text', email: 'me@example' });
    await send(box);
    const failed = box.querySelector('.fb-failed')!;
    expect(failed.textContent).toContain('It was not sent: The email does not look like an email address.');
    expect(failed.querySelector('a')!.getAttribute('href')).toBe(DISCUSSIONS_URL);
    expect(DISCUSSIONS_URL).toBe('https://github.com/StaysUp/agentbus/discussions');
    const text = box.querySelector('textarea[name="message"]') as HTMLTextAreaElement;
    expect(text.value).toBe('Keep this text');
    expect(text.readOnly).toBe(false);
    expect(box.textContent).not.toContain('Thanks');

    // The email is fixed and the message sent again.
    await setValue(box.querySelector('input[name="email"]'), 'me@example.com');
    expect(box.querySelector('button.fb-send')!.textContent).toBe('Send again');
    await send(box);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse((fetchMock.mock.calls[1] as [string, RequestInit])[1].body as string).email).toBe('me@example.com');
    expect(box.textContent).toContain('Thanks — sent.');
  });

  it('a refusal without JSON gives its status', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('Method Not Allowed', { status: 405 })));
    const box = await openBox();
    await fill(box);
    await send(box);
    expect(box.querySelector('.fb-failed')!.textContent).toContain('the site answered 405.');
  });

  it('when the network fails, the same', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))));
    const box = await openBox();
    await fill(box);
    await send(box);
    expect(box.querySelector('.fb-failed')!.textContent).toContain('It could not be sent.');
    expect(box.querySelector('.fb-failed a')!.getAttribute('href')).toBe(DISCUSSIONS_URL);
    expect((box.querySelector('textarea[name="message"]') as HTMLTextAreaElement).value).toBe('The runners page is empty');
  });

  it('Escape closes it, and the cockpit behind it sees the key as handled', async () => {
    const box = await openBox();
    let seen: boolean | null = null;
    const behind = (e: KeyboardEvent) => (seen = e.defaultPrevented);
    window.addEventListener('keydown', behind);
    await act(async () => {
      box.querySelector('textarea')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    window.removeEventListener('keydown', behind);
    expect(document.querySelector('[aria-label="Feedback"]')).toBeNull();
    expect(seen).toBe(true);
  });

  it('Cancel closes it without sending', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const box = await openBox();
    await fill(box);
    await click(box.querySelector('button.nd-cancel'));
    expect(document.querySelector('[aria-label="Feedback"]')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
