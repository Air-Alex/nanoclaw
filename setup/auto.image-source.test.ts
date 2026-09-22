import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The sandbox-image question is asked once, at the container step, and the
 * Echo perk reminder later in the run re-offers the same thing. The reminder
 * is only for runs that never reached the question — and a resumed run
 * (fail()'s retry, the sg-docker re-exec) rebuilds NANOCLAW_SKIP from what the
 * setup log recorded, so the answer has to be recorded there, not only in the
 * wizard's in-memory skip set.
 *
 * Each phase below is one wizard process: the driver is imported fresh, and it
 * stops at the cli-agent step, which is made to fail.
 */
const fixture = vi.hoisted(() => ({
  fail: vi.fn(),
  runQuietStep: vi.fn(),
  runWindowedStep: vi.fn(),
  runImagePortal: vi.fn(),
  offerPortalReminder: vi.fn(),
  portalEnabled: vi.fn(() => true),
  brightSelect: vi.fn(),
  runInheritScript: vi.fn(),
  loginScript: true,
  /** The persisted `.env` answer: '' = not asked yet, 'true' = hardened, 'false' = local. */
  imageSource: '' as '' | 'true' | 'false',
  completed: new Set<string>(),
}));
vi.mock('./providers/index.js', () => ({}));
vi.mock('./providers/registry.js', () => ({ getSetupProvider: () => undefined, listSetupProviders: () => [] }));
vi.mock('./providers/install.js', () => ({ applyProviderSkill: vi.fn() }));
vi.mock('./lib/bright-select.js', () => ({ brightSelect: fixture.brightSelect }));
vi.mock('./lib/inherit-script.js', () => ({ runInheritScript: fixture.runInheritScript }));
vi.mock('./portal.js', () => ({
  portalEnabled: fixture.portalEnabled,
  runImagePortal: fixture.runImagePortal,
  offerPortalReminder: fixture.offerPortalReminder,
}));
vi.mock('./lib/registry-state.js', async (original) => ({
  ...(await original<typeof import('./lib/registry-state.js')>()),
  readAgentImagePin: () => 'reg.example.test/nanoclaw/agent@sha256:abc',
  loginScriptAvailable: () => fixture.loginScript,
  imageSourceDecided: () => fixture.imageSource !== '',
  readImageSource: () => (fixture.imageSource === 'true' ? 'hardened' : 'local'),
  writeImageSource: (source: 'hardened' | 'local') => {
    fixture.imageSource = source === 'hardened' ? 'true' : 'false';
  },
}));
vi.mock('./lib/setup-config-parse.js', () => ({
  parseFlags: () => ({ help: false, errors: [], values: {} }),
  readFromEnv: () => ({}),
  applyToEnv: vi.fn(),
}));
vi.mock('./environment.js', () => ({
  readEnvKey: () => undefined,
  detectRegisteredGroups: async () => false,
  detectExistingDisplayName: async () => undefined,
}));
// The completion set is doubled so the file-writing entries can be too; `step`
// keeps the real module's completion rule. The real `decided` is checked below.
vi.mock('./logs.js', async (original) => ({
  ...(await original<typeof import('./logs.js')>()),
  userInput: vi.fn(),
  reset: vi.fn(),
  header: vi.fn(),
  abort: vi.fn(),
  step: (name: string, status: string) => {
    if (status === 'success' || status === 'skipped') fixture.completed.add(name);
  },
  completedStepNames: () => [...fixture.completed],
  decided: (name: string) => {
    fixture.completed.add(name);
  },
}));
vi.mock('./lib/diagnostics.js', () => ({ emit: vi.fn() }));
vi.mock('./lib/runner.js', async (original) => ({
  ...(await original<typeof import('./lib/runner.js')>()),
  fail: fixture.fail,
  runQuietStep: fixture.runQuietStep,
}));
vi.mock('./lib/windowed-runner.js', () => ({ runWindowedStep: fixture.runWindowedStep }));
vi.mock('./set-env.js', () => ({ upsertEnvVar: vi.fn() }));
vi.mock('@clack/prompts', () => ({
  intro: vi.fn(),
  cancel: vi.fn(),
  confirm: vi.fn(async () => true),
  isCancel: (value: unknown) => typeof value === 'symbol',
  spinner: () => ({ start: vi.fn(), stop: vi.fn() }),
  log: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), message: vi.fn(), step: vi.fn(), success: vi.fn() },
}));

/** Every step but the container step and the terminating cli-agent step. */
const SKIP_AROUND_CONTAINER = 'environment,onecli,auth,mounts,service,first-chat,timezone,channel,verify';

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  fixture.completed.clear();
  fixture.imageSource = '';
  fixture.loginScript = true;
  fixture.portalEnabled.mockReturnValue(true);
  vi.stubEnv('PATH', process.env.PATH);
  vi.stubEnv('NANOCLAW_REEXEC_SG', '1');
  vi.stubEnv('NANOCLAW_BOOTSTRAPPED', '1');
  vi.stubEnv('NANOCLAW_AGENT_PROVIDER', 'claude');
  vi.stubEnv('NANOCLAW_DISPLAY_NAME', 'Operator');
  vi.stubEnv('NANOCLAW_SKIP', SKIP_AROUND_CONTAINER);
  fixture.fail.mockRejectedValue(new Error('failure assistance finished'));
  fixture.runQuietStep.mockResolvedValue({ ok: false });
  fixture.runWindowedStep.mockImplementation(async (name: string) => {
    const log = await import('./logs.js');
    log.step(name, 'success', 0, {});
    return { ok: true };
  });
  fixture.offerPortalReminder.mockResolvedValue(false);
  // The browser handoff was declined: the portal writes `local` and says so.
  fixture.runImagePortal.mockImplementation(async () => {
    fixture.imageSource = 'false';
    return 'local';
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

/** One wizard process, from the top until the cli-agent step aborts it. */
async function runWizardUntilExit(): Promise<void> {
  let finish!: () => void;
  const exited = new Promise<void>((resolve) => {
    finish = resolve;
  });
  vi.spyOn(process, 'exit').mockImplementation((() => {
    finish();
  }) as typeof process.exit);
  await import('./auto.js');
  await exited;
  expect(fixture.fail).toHaveBeenCalledWith('cli-agent', expect.any(String), expect.any(String));
}

/** What fail()'s retry and the sg-docker re-exec hand the next process. */
function resumeSkipList(): string {
  const existing = (process.env.NANOCLAW_SKIP ?? '').split(',').filter(Boolean);
  return [...new Set([...existing, ...fixture.completed])].join(',');
}

it('the setup log lists an answered question with the completed steps', async () => {
  const real = await vi.importActual<typeof import('./logs.js')>('./logs.js');
  real.decided('echo-reminder');
  expect(real.completedStepNames()).toContain('echo-reminder');
});

describe('the sandbox-image question and the Echo perk reminder', () => {
  it('does not re-offer Echo after a resume once the operator declined it at the container step', async () => {
    await runWizardUntilExit();
    expect(fixture.runImagePortal).toHaveBeenCalledOnce();
    expect(fixture.offerPortalReminder).not.toHaveBeenCalled();
    // The answer is recorded where the resume paths read from, not only in memory.
    const carried = resumeSkipList();
    expect(carried.split(',')).toEqual(expect.arrayContaining(['container', 'echo-reminder']));

    // The resumed process: the container step is complete, `.env` says local.
    vi.resetModules();
    vi.clearAllMocks();
    fixture.completed.clear();
    fixture.fail.mockRejectedValue(new Error('failure assistance finished'));
    fixture.runQuietStep.mockResolvedValue({ ok: false });
    fixture.offerPortalReminder.mockResolvedValue(false);
    vi.stubEnv('NANOCLAW_SKIP', carried);
    await runWizardUntilExit();
    expect(fixture.runImagePortal).not.toHaveBeenCalled();
    expect(fixture.offerPortalReminder).not.toHaveBeenCalled();
  });

  it('still offers Echo to a run that never reached the question', async () => {
    vi.stubEnv('NANOCLAW_SKIP', `${SKIP_AROUND_CONTAINER},container`);
    await runWizardUntilExit();
    expect(fixture.runImagePortal).not.toHaveBeenCalled();
    expect(fixture.offerPortalReminder).toHaveBeenCalledExactlyOnceWith('echo', expect.any(Function));
  });

  it('leaves a reminder it could not make (or that was accepted) to the portal journal, not the resume skip list', async () => {
    vi.stubEnv('NANOCLAW_SKIP', `${SKIP_AROUND_CONTAINER},container`);
    fixture.offerPortalReminder.mockResolvedValue(false);
    await runWizardUntilExit();
    expect(fixture.offerPortalReminder).toHaveBeenCalledOnce();
    expect(fixture.completed).not.toContain('echo-reminder');
  });

  describe('without the browser handoff, the terminal select and the device sign-in', () => {
    beforeEach(() => {
      fixture.portalEnabled.mockReturnValue(false);
      fixture.brightSelect.mockResolvedValue('hardened');
    });

    it('treats a deliberately skipped sign-in as an answer and falls back to a local build', async () => {
      fixture.runInheritScript.mockResolvedValue(2);
      await runWizardUntilExit();
      expect(fixture.brightSelect).toHaveBeenCalledWith(
        expect.objectContaining({ message: "Where should your assistant's sandbox image come from?" }),
      );
      expect(fixture.runInheritScript).toHaveBeenCalledOnce();
      expect(fixture.imageSource).toBe('false');
      expect(fixture.completed).toContain('echo-reminder');
    });

    it('treats a sign-in that did not finish as an answer too', async () => {
      fixture.runInheritScript.mockResolvedValue(1);
      await runWizardUntilExit();
      expect(fixture.imageSource).toBe('false');
      expect(fixture.completed).toContain('echo-reminder');
    });

    it('treats a copy with no sign-in script as an answer: there is nothing to re-offer', async () => {
      fixture.loginScript = false;
      await runWizardUntilExit();
      expect(fixture.runInheritScript).not.toHaveBeenCalled();
      expect(fixture.imageSource).toBe('false');
      expect(fixture.completed).toContain('echo-reminder');
    });

    it('records "build it here" as an answer', async () => {
      fixture.brightSelect.mockResolvedValue('local');
      await runWizardUntilExit();
      expect(fixture.runInheritScript).not.toHaveBeenCalled();
      expect(fixture.imageSource).toBe('false');
      expect(fixture.completed).toContain('echo-reminder');
    });
  });
});
