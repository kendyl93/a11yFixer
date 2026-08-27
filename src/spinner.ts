const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const INTERVAL_MS = 80;
const HIDE_CURSOR = "\x1B[?25l";
const SHOW_CURSOR = "\x1B[?25h";
const CLEAR_LINE = "\r\x1B[2K";

export type Spinner = {
  /** Replace the animation with a final line. Safe to call twice. */
  stop(finalIcon?: string, finalText?: string): void;
};

let active: Spinner | null = null;

export function formatDuration(ms: number): string {
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h${String(m).padStart(2, "0")}m`;
  return m > 0 ? `${m}m${String(s).padStart(2, "0")}s` : `${s}s`;
}

const elapsed = (startedAt: number): string => formatDuration(Date.now() - startedAt);

const line = (icon: string, text: string, suffix = ""): string => `   ${icon}  ${text}${suffix}`;

/**
 * Show a spinner while a long step runs. Interactive terminals get an animation with a
 * live elapsed timer; piped output gets one plain line so logs stay readable.
 */
export function spin(icon: string, text: string): Spinner {
  active?.stop();
  const startedAt = Date.now();

  if (!process.stdout.isTTY) {
    console.log(line(icon, text));
    const quiet: Spinner = {
      stop(finalIcon, finalText) {
        if (active !== quiet) return;
        active = null;
        // Only re-print when the outcome differs from what was announced.
        if (finalIcon || finalText) console.log(line(finalIcon ?? icon, finalText ?? text));
      },
    };
    active = quiet;
    return quiet;
  }

  let frame = 0;
  process.stdout.write(HIDE_CURSOR);
  const render = (): void => {
    process.stdout.write(
      `${CLEAR_LINE}${line(FRAMES[frame % FRAMES.length] as string, text, `   ${elapsed(startedAt)}`)}`,
    );
    frame++;
  };
  render();
  const timer = setInterval(render, INTERVAL_MS);
  timer.unref();

  const spinner: Spinner = {
    stop(finalIcon, finalText) {
      if (active !== spinner) return;
      active = null;
      clearInterval(timer);
      process.stdout.write(
        `${CLEAR_LINE}${line(finalIcon ?? icon, finalText ?? text, `   ${elapsed(startedAt)}`)}\n${SHOW_CURSOR}`,
      );
    },
  };
  active = spinner;
  return spinner;
}

/** Stop whatever is spinning. Used on the error paths so a throw never leaves a live animation. */
export function stopSpinner(icon?: string, text?: string): void {
  active?.stop(icon, text);
}

if (process.stdout.isTTY) {
  process.on("exit", () => process.stdout.write(SHOW_CURSOR));
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      stopSpinner("🛑", "interrupted");
      process.exit(130);
    });
  }
}
