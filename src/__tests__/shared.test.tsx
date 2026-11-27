// @vitest-environment jsdom
import React, { useState } from 'react';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Button, buttonClass } from '../components/Controls';
import { ConfirmDialog, Dialog, DialogActions } from '../components/Dialog';
import { Loading, Notice, WithCode } from '../components/Notice';
import { formatDuration, stateLabel, toolStateLabel } from '../utils/format';
import { CANCEL, harnessName, LOADING, STATE } from '../words';
import { click, flush, render, unmountAll } from './helpers';

const esc = () =>
  act(async () => {
    document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  });

afterEach(() => {
  unmountAll();
  document.body.innerHTML = '';
});

describe('Button', () => {
  it('has four looks, and link is the text action', () => {
    expect(buttonClass('primary')).toBe('btn btn-primary');
    expect(buttonClass('secondary', true, 'x')).toBe('btn btn-secondary btn-sm x');
    expect(buttonClass('link', true, 'x')).toBe('link-btn x');
  });

  it('is a plain button unless told to submit', async () => {
    const r = await render(<Button kind="quiet">Go</Button>);
    expect(r.container.querySelector('button')!.getAttribute('type')).toBe('button');
  });
});

describe('Dialog', () => {
  const Host: React.FC<{ busy?: boolean; onClose: () => void }> = ({ busy, onClose }) => (
    <Dialog title="Pick one" onClose={onClose} busy={busy}>
      <input name="a" />
      <DialogActions>
        <Button kind="primary">Do it</Button>
      </DialogActions>
    </Dialog>
  );

  it('is a dialog named by its title, with focus inside and one Cancel', async () => {
    const r = await render(<Host onClose={() => {}} />);
    const d = r.container.querySelector('[role="dialog"]')!;
    expect(d.getAttribute('aria-label')).toBe('Pick one');
    expect(d.getAttribute('aria-modal')).toBe('true');
    expect(d.contains(document.activeElement)).toBe(true);
    expect(d.querySelector('.dlg-cancel')!.textContent).toBe(CANCEL);
    expect(CANCEL).toBe('Cancel');
  });

  it('closes on Esc, on Cancel and on a click outside, and marks the key as handled', async () => {
    const onClose = vi.fn();
    const r = await render(<Host onClose={onClose} />);
    let seen: boolean | null = null;
    const behind = (e: KeyboardEvent) => (seen = e.defaultPrevented);
    window.addEventListener('keydown', behind);
    await esc();
    window.removeEventListener('keydown', behind);
    expect(seen).toBe(true);
    await click(r.container.querySelector('.dlg-cancel'));
    await act(async () => {
      r.container.querySelector('.modal-back')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it('while busy, nothing closes it', async () => {
    const onClose = vi.fn();
    const r = await render(<Host busy onClose={onClose} />);
    await esc();
    await act(async () => {
      r.container.querySelector('.modal-back')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    expect((r.container.querySelector('.dlg-cancel') as HTMLButtonElement).disabled).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('keeps forward and reverse Tab inside from programmatically focused status text', async () => {
    const r = await render(
      <Dialog title="Connect" onClose={() => {}}>
        <span tabIndex={-1} role="status">Preparing sign-in…</span>
        <button>First action</button>
        <button>Back to setup</button>
      </Dialog>,
    );
    const dialog = r.container.querySelector('[role="dialog"]')!;
    const status = dialog.querySelector<HTMLElement>('[role="status"]')!;
    const [first, last] = dialog.querySelectorAll('button');
    for (const button of [first, last]) Object.defineProperty(button, 'offsetParent', { value: dialog });
    for (const [shiftKey, target] of [[false, first], [true, last]] as const) {
      await act(async () => {
        status.focus();
        status.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey, bubbles: true, cancelable: true }));
      });
      expect(document.activeElement).toBe(target);
    }
  });

  it('a dialog opened over another closes alone on Esc, and focus goes back', async () => {
    const Two: React.FC = () => {
      const [outer, setOuter] = useState(true);
      const [inner, setInner] = useState(false);
      return (
        <>
          {outer && (
            <Dialog title="Outer" onClose={() => setOuter(false)}>
              <button className="open-inner" onClick={() => setInner(true)}>
                open
              </button>
              {inner && (
                <Dialog title="Inner" onClose={() => setInner(false)}>
                  <DialogActions />
                </Dialog>
              )}
            </Dialog>
          )}
        </>
      );
    };
    const r = await render(<Two />);
    const opener = r.container.querySelector('.open-inner') as HTMLButtonElement;
    opener.focus();
    await click(opener);
    expect(r.container.querySelector('[aria-label="Inner"]')).not.toBeNull();
    await esc();
    expect(r.container.querySelector('[aria-label="Inner"]')).toBeNull();
    expect(r.container.querySelector('[aria-label="Outer"]')).not.toBeNull();
    expect(document.activeElement).toBe(opener);
  });
});

describe('ConfirmDialog', () => {
  it('asks with one line, focuses Cancel, and shows a refusal in its words', async () => {
    const onClose = vi.fn();
    let answer: string | void = 'A turn is still running.';
    const r = await render(
      <ConfirmDialog
        title="Remove box?"
        line="It gets no more work."
        warn="2 files not applied"
        action="Remove"
        busyAction="Removing…"
        onConfirm={async () => answer}
        onClose={onClose}
      />,
    );
    const d = r.container.querySelector('[role="alertdialog"]')!;
    expect(d.querySelector('.nd-title')!.textContent).toBe('Remove box?');
    expect(d.querySelector('.form-warn')!.textContent).toBe('2 files not applied');
    expect(document.activeElement).toBe(d.querySelector('.dlg-cancel'));
    await click(d.querySelector('.confirm-go'));
    await flush();
    expect(d.querySelector('.confirm-refused')!.textContent).toBe('A turn is still running.');
    expect(onClose).not.toHaveBeenCalled();
    answer = undefined;
    await click(d.querySelector('.confirm-go'));
    await flush();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('Notice, Loading and the words', () => {
  it('draws an error red and a warning amber, by class', async () => {
    const r = await render(
      <>
        <Notice kind="error">no</Notice>
        <Notice kind="warn" inline>
          careful
        </Notice>
      </>,
    );
    expect(r.container.querySelector('div.form-error')!.textContent).toBe('no');
    expect(r.container.querySelector('span.form-warn')!.textContent).toBe('careful');
  });

  it('shows a command as code, never with backticks', async () => {
    const r = await render(<WithCode text="Run `agentbus up` again." />);
    expect(r.container.textContent).toBe('Run agentbus up again.');
    expect(r.container.querySelector('code')!.textContent).toBe('agentbus up');
  });

  it('says loading one way', async () => {
    const r = await render(<Loading />);
    expect(r.container.textContent).toBe('Loading…');
    expect(LOADING).toBe('Loading…');
  });

  it('names a harness by its product, the service label first', () => {
    expect(harnessName('claude')).toBe('Claude Code');
    expect(harnessName('codex')).toBe('Codex');
    expect(harnessName('agy')).toBe('Antigravity');
    expect(harnessName('claude', 'Claude Code (beta)')).toBe('Claude Code (beta)');
    expect(harnessName('pi')).toBe('pi');
  });

  it('says every state in one lowercase word', () => {
    expect(stateLabel({ state: 'failed' })).toBe('failed');
    expect(stateLabel({ state: 'running' })).toBe('running');
    expect(stateLabel({ state: 'finished', stopped: true })).toBe('stopped');
    expect(stateLabel({ state: 'finished' })).toBe('finished');
    for (const w of Object.values(STATE)) expect(w).toBe(w.toLowerCase());
    expect(toolStateLabel({ tool_error: false })).toBe('ok');
    expect(toolStateLabel({ tool_error: true })).toBe('failed');
    expect(toolStateLabel(undefined, true)).toBe('running');
    expect(toolStateLabel(undefined)).toBe('no result');
  });

  it('prints every duration one way', () => {
    expect(formatDuration(640)).toBe('640ms');
    expect(formatDuration(1658)).toBe('1.7s');
    expect(formatDuration(11240)).toBe('11.2s');
  });
});
