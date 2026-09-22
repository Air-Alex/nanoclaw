import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The sandbox-image question is asked once, at the container step; the Echo
 * perk reminder later in the run re-offers the same thing and is only for a
 * run that never reached the question. The answer is persisted to `.env`, and
 * the reminder must read it from there: a resumed run (fail()'s retry, the
 * sg-docker re-exec) and a plain re-run are both fresh processes that skip the
 * question, so nothing kept in memory reaches them.
 *
 * Each case drives the wizard as one process: the driver is imported fresh and
 * stops at the cli-agent step, which is made to fail.
 */
const fixture = vi.hoisted(() => ({
  fail: vi.fn(),
  runQuietStep: vi.fn(),
  runImagePortal: vi.fn(),
  offerPortalReminder: vi.fn(),
  /** The persisted `.env` answer: '' = not asked yet, 'true' = hardened, 'false' = local. */
  imageSource: '' as '' | 'true' | 'false',
}));
vi.mock('./providers/index.js', () => ({}));
vi.mock('./providers/registry.js', () => ({ getSetupProvider: () => undefined, listSetupProviders: () => [] }));
vi.mock('./providers/install.js', () => ({ applyProviderSkill: vi.fn() }));
vi.mock('./lib/bright-select.js', () => ({ brightSelect: vi.fn() }));
vi.mock('./portal.js', () => ({
  portalEnabled: () => true,
  runImagePortal: fixture.runImagePortal,
  offerPortalReminder: fixture.offerPortalReminder,
}));
vi.mock('./lib/registry-state.js', async (original) => ({
  ...(await original<typeof import('./lib/registry-state.js')>()),
  readAgentImagePin: () => 'reg.example.test/nanoclaw/agent@sha256:abc',
  imageSourceDecided: () => fixture.imageSource !== '',
  readImageSource: () => (fixture.imageSource === 'true' ? 'hardened' : 'local'),
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
vi.mock('./logs.js', () => ({ userInput: vi.fn(), step: vi.fn(), completedStepNames: () => [] }));
vi.mock('./lib/diagnostics.js', () => ({ emit: vi.fn() }));
vi.mock('./lib/runner.js', async (original) => ({
  ...(await original<typeof import('./lib/runner.js')>()),
  fail: fixture.fail,
  runQuietStep: fixture.runQuietStep,
}));
vi.mock('./lib/windowed-runner.js', () => ({ runWindowedStep: vi.fn(async () => ({ ok: true })) }));
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
  fixture.imageSource = '';
  vi.stubEnv('PATH', process.env.PATH);
  vi.stubEnv('NANOCLAW_REEXEC_SG', '1');
  vi.stubEnv('NANOCLAW_BOOTSTRAPPED', '1');
  vi.stubEnv('NANOCLAW_AGENT_PROVIDER', 'claude');
  vi.stubEnv('NANOCLAW_DISPLAY_NAME', 'Operator');
  vi.stubEnv('NANOCLAW_SKIP', SKIP_AROUND_CONTAINER);
  fixture.fail.mockRejectedValue(new Error('failure assistance finished'));
  fixture.runQuietStep.mockResolvedValue({ ok: false });
  fixture.offerPortalReminder.mockResolvedValue(false);
  // The browser handoff was declined: the portal writes `local` to `.env`.
  fixture.runImagePortal.mockImplementation(async () => {
    fixture.imageSource = 'false';
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

describe('the sandbox-image question and the Echo perk reminder', () => {
  it('does not re-offer Echo in the run where the operator declined it at the container step', async () => {
    await runWizardUntilExit();
    expect(fixture.runImagePortal).toHaveBeenCalledOnce();
    expect(fixture.offerPortalReminder).not.toHaveBeenCalled();
  });

  it('does not re-offer Echo on a resumed run that skips the completed container step', async () => {
    fixture.imageSource = 'false';
    vi.stubEnv('NANOCLAW_SKIP', `${SKIP_AROUND_CONTAINER},container`);
    await runWizardUntilExit();
    expect(fixture.offerPortalReminder).not.toHaveBeenCalled();
  });

  it('does not re-offer Echo on a plain re-run, where the container step finds the question answered', async () => {
    fixture.imageSource = 'false';
    await runWizardUntilExit();
    expect(fixture.runImagePortal).not.toHaveBeenCalled();
    expect(fixture.offerPortalReminder).not.toHaveBeenCalled();
  });

  it('still offers Echo to a run that never reached the question', async () => {
    vi.stubEnv('NANOCLAW_SKIP', `${SKIP_AROUND_CONTAINER},container`);
    await runWizardUntilExit();
    expect(fixture.offerPortalReminder).toHaveBeenCalledExactlyOnceWith('echo', expect.any(Function));
  });
});
