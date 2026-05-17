/**
 * CrabMeat Terminal UI
 *
 * Zero-dependency terminal styling. Raw ANSI escape codes.
 * Butter-yellow aesthetic with box drawing and spinners.
 */

// ── ANSI Color Codes ──────────────────────────────────────

export const c = {
  // Reset
  reset: "\x1b[0m",

  // Styles
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  italic: "\x1b[3m",
  underline: "\x1b[4m",
  blink: "\x1b[5m",
  inverse: "\x1b[7m",
  strikethrough: "\x1b[9m",

  // Foreground
  black: "\x1b[30m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
  gray: "\x1b[90m",

  // Bright foreground
  brightGreen: "\x1b[92m",
  brightYellow: "\x1b[93m",
  brightCyan: "\x1b[96m",
  brightWhite: "\x1b[97m",

  // Background
  bgBlack: "\x1b[40m",
  bgRed: "\x1b[41m",
  bgGreen: "\x1b[42m",
  bgYellow: "\x1b[43m",

  // Cursor
  hideCursor: "\x1b[?25l",
  showCursor: "\x1b[?25h",
  clearLine: "\x1b[2K",
  moveToCol0: "\r",
} as const;

// ── Detect color support ──────────────────────────────────

function supportsColor(): boolean {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR) return true;
  if (!process.stdout.isTTY) return false;
  return true;
}

const COLOR_ENABLED = supportsColor();

/** Strip ANSI codes when color is disabled. */
export function style(text: string): string {
  if (COLOR_ENABLED) return text;
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

// ── Theme ─────────────────────────────────────────────────

export const theme = {
  // Primary: bright yellow (butter)
  primary: (s: string) => style(`${c.brightYellow}${s}${c.reset}`),
  // Accent: cyan for highlights
  accent: (s: string) => style(`${c.cyan}${s}${c.reset}`),
  // Dim: for secondary info
  dim: (s: string) => style(`${c.dim}${s}${c.reset}`),
  // Error: red
  error: (s: string) => style(`${c.red}${s}${c.reset}`),
  // Warning: yellow
  warn: (s: string) => style(`${c.yellow}${s}${c.reset}`),
  // Success: green
  success: (s: string) => style(`${c.green}${s}${c.reset}`),
  // Bold primary
  heading: (s: string) => style(`${c.bold}${c.brightYellow}${s}${c.reset}`),
  // User input prompt
  prompt: (s: string) => style(`${c.bold}${c.cyan}${s}${c.reset}`),
  // Agent/bot response
  agent: (s: string) => style(`${c.yellow}${s}${c.reset}`),
  // Tool execution
  tool: (s: string) => style(`${c.yellow}${s}${c.reset}`),
  // Kill/danger
  danger: (s: string) => style(`${c.bold}${c.red}${s}${c.reset}`),
  // Muted text
  muted: (s: string) => style(`${c.gray}${s}${c.reset}`),
  // Key/value pair
  kv: (key: string, val: string) =>
    style(`${c.dim}${key}:${c.reset} ${c.brightYellow}${val}${c.reset}`),
} as const;

// ── Box Drawing ───────────────────────────────────────────

const BOX = {
  topLeft: "╔",
  topRight: "╗",
  bottomLeft: "╚",
  bottomRight: "╝",
  horizontal: "═",
  vertical: "║",
  teeRight: "╠",
  teeLeft: "╣",
  cross: "╬",
  lightH: "─",
  lightV: "│",
  lightTL: "┌",
  lightTR: "┐",
  lightBL: "└",
  lightBR: "┘",
  roundTL: "╭",
  roundTR: "╮",
  roundBL: "╰",
  roundBR: "╯",
  teeDown: "┬",
} as const;

/** Draw a box around text lines. */
export function box(lines: string[], width?: number): string {
  const maxLen = width ?? Math.max(...lines.map((l) => stripAnsi(l).length));
  const pad = (s: string) => {
    const visible = stripAnsi(s).length;
    return s + " ".repeat(Math.max(0, maxLen - visible));
  };

  const top = `${c.yellow}${BOX.topLeft}${BOX.horizontal.repeat(maxLen + 2)}${BOX.topRight}${c.reset}`;
  const bottom = `${c.yellow}${BOX.bottomLeft}${BOX.horizontal.repeat(maxLen + 2)}${BOX.bottomRight}${c.reset}`;
  const middle = lines
    .map((l) => `${c.yellow}${BOX.vertical}${c.reset} ${pad(l)} ${c.yellow}${BOX.vertical}${c.reset}`)
    .join("\n");

  return `${top}\n${middle}\n${bottom}`;
}

/** Draw a lighter box (single-line borders). */
export function lightBox(lines: string[], width?: number): string {
  const maxLen = width ?? Math.max(...lines.map((l) => stripAnsi(l).length));
  const pad = (s: string) => {
    const visible = stripAnsi(s).length;
    return s + " ".repeat(Math.max(0, maxLen - visible));
  };

  const top = `${c.dim}${BOX.lightTL}${BOX.lightH.repeat(maxLen + 2)}${BOX.lightTR}${c.reset}`;
  const bottom = `${c.dim}${BOX.lightBL}${BOX.lightH.repeat(maxLen + 2)}${BOX.lightBR}${c.reset}`;
  const middle = lines
    .map((l) => `${c.dim}${BOX.lightV}${c.reset} ${pad(l)} ${c.dim}${BOX.lightV}${c.reset}`)
    .join("\n");

  return `${top}\n${middle}\n${bottom}`;
}

// ── Separator ─────────────────────────────────────────────

export function separator(char = "─", width = 60): string {
  return style(`${c.dim}${char.repeat(width)}${c.reset}`);
}

// ── Shimmer (animated text highlight) ─────────────────────

const SHIMMER_WIDTH = 6;

/**
 * Render `text` with a sliding "highlight window" effect — characters
 * inside the window are bright, the rest are dim. Call repeatedly with
 * an incrementing `tick` to animate the highlight sweeping across the
 * text. Nicer than a one-character spinner because it draws the eye
 * without being noisy.
 *
 * Tick math: pos cycles through [0, text.length + SHIMMER_WIDTH), so
 * the window enters from the left edge, fully traverses the text, and
 * exits cleanly off the right before wrapping. Adding SHIMMER_WIDTH to
 * the modulus gives a brief "all dim" frame between cycles, which
 * looks intentional rather than glitchy.
 */
export function shimmerText(text: string, tick: number): string {
  if (!COLOR_ENABLED) return text;
  const len = text.length;
  if (len === 0) return "";
  const pos = ((tick % (len + SHIMMER_WIDTH)) + (len + SHIMMER_WIDTH)) % (len + SHIMMER_WIDTH);
  const start = Math.max(0, pos - SHIMMER_WIDTH);
  const end = Math.min(len - 1, pos);
  let out = "";
  for (let i = 0; i < len; i++) {
    const ch = text[i] ?? "";
    if (i >= start && i <= end) {
      out += `${c.bold}${c.brightYellow}${ch}${c.reset}`;
    } else {
      out += `${c.dim}${c.yellow}${ch}${c.reset}`;
    }
  }
  return out;
}

/**
 * Format an elapsed-time delta as "3s" under a minute, "1m 5s" over.
 */
export function formatElapsed(startMs: number): string {
  const total = Math.max(0, Math.floor((Date.now() - startMs) / 1000));
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}m ${s}s`;
}

// ── Spinner ───────────────────────────────────────────────

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export interface Spinner {
  start(text: string): void;
  update(text: string): void;
  succeed(text: string): void;
  fail(text: string): void;
  stop(): void;
}

export function createSpinner(): Spinner {
  let interval: ReturnType<typeof setInterval> | null = null;
  let frameIndex = 0;
  let currentText = "";

  function render() {
    const frame = SPINNER_FRAMES[frameIndex % SPINNER_FRAMES.length];
    process.stdout.write(
      `${c.moveToCol0}${c.clearLine}${c.yellow}${frame}${c.reset} ${currentText}`,
    );
    frameIndex++;
  }

  return {
    start(text: string) {
      currentText = text;
      frameIndex = 0;
      if (!process.stdout.isTTY) {
        process.stdout.write(`  ${text}\n`);
        return;
      }
      process.stdout.write(c.hideCursor);
      interval = setInterval(render, 80);
      render();
    },

    update(text: string) {
      currentText = text;
    },

    succeed(text: string) {
      this.stop();
      process.stdout.write(
        `${c.moveToCol0}${c.clearLine}${c.brightYellow}[ok]${c.reset} ${text}\n`,
      );
    },

    fail(text: string) {
      this.stop();
      process.stdout.write(
        `${c.moveToCol0}${c.clearLine}${c.red}[fail]${c.reset} ${text}\n`,
      );
    },

    stop() {
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
      if (process.stdout.isTTY) {
        process.stdout.write(`${c.moveToCol0}${c.clearLine}${c.showCursor}`);
      }
    },
  };
}

// ── Status Line ───────────────────────────────────────────

export function statusLine(items: Array<{ label: string; value: string }>): string {
  return items
    .map(({ label, value }) => `${c.dim}${label}${c.reset} ${c.brightYellow}${value}${c.reset}`)
    .join(style(`${c.dim}  │  ${c.reset}`));
}

// ── Helpers ───────────────────────────────────────────────

export function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
}

/** Print to stdout. */
export function print(text: string): void {
  process.stdout.write(style(text) + "\n");
}

/** Print blank line. */
export function blank(): void {
  process.stdout.write("\n");
}

// ── ASCII Art Banner ──────────────────────────────────────

export const BANNER_LINES = [
  `${c.brightYellow}${c.bold}   ██████╗██████╗  █████╗ ██████╗ ${c.reset}${c.yellow}███╗   ███╗███████╗ █████╗ ████████╗${c.reset}`,
  `${c.brightYellow}${c.bold}  ██╔════╝██╔══██╗██╔══██╗██╔══██╗${c.reset}${c.yellow}████╗ ████║██╔════╝██╔══██╗╚══██╔══╝${c.reset}`,
  `${c.brightYellow}${c.bold}  ██║     ██████╔╝███████║██████╔╝${c.reset}${c.yellow}██╔████╔██║█████╗  ███████║   ██║   ${c.reset}`,
  `${c.brightYellow}${c.bold}  ██║     ██╔══██╗██╔══██║██╔══██╗${c.reset}${c.yellow}██║╚██╔╝██║██╔══╝  ██╔══██║   ██║   ${c.reset}`,
  `${c.brightYellow}${c.bold}  ╚██████╗██║  ██║██║  ██║██████╔╝${c.reset}${c.yellow}██║ ╚═╝ ██║███████╗██║  ██║   ██║   ${c.reset}`,
  `${c.brightYellow}${c.bold}   ╚═════╝╚═╝  ╚═╝╚═╝  ╚═╝╚═════╝ ${c.reset}${c.yellow}╚═╝     ╚═╝╚══════╝╚═╝  ╚═╝   ╚═╝   ${c.reset}`,
  `${c.dim}  Natural Language Computing Framework${c.reset}`,
];

export const BANNER = "\n" + BANNER_LINES.join("\n");

/**
 * Banner glyphs without ANSI escapes, split per row into the brightYellow
 * "CRAB" half and the plain-yellow "MEAT" half. Consumed by Ink-based UIs
 * that handle color via component props rather than raw escape codes.
 */
export const BANNER_RAW_LINES: ReadonlyArray<{ left: string; right: string }> = [
  { left: "   ██████╗██████╗  █████╗ ██████╗ ", right: "███╗   ███╗███████╗ █████╗ ████████╗" },
  { left: "  ██╔════╝██╔══██╗██╔══██╗██╔══██╗", right: "████╗ ████║██╔════╝██╔══██╗╚══██╔══╝" },
  { left: "  ██║     ██████╔╝███████║██████╔╝", right: "██╔████╔██║█████╗  ███████║   ██║   " },
  { left: "  ██║     ██╔══██╗██╔══██║██╔══██╗", right: "██║╚██╔╝██║██╔══╝  ██╔══██║   ██║   " },
  { left: "  ╚██████╗██║  ██║██║  ██║██████╔╝", right: "██║ ╚═╝ ██║███████╗██║  ██║   ██║   " },
  { left: "   ╚═════╝╚═╝  ╚═╝╚═╝  ╚═╝╚═════╝ ", right: "╚═╝     ╚═╝╚══════╝╚═╝  ╚═╝   ╚═╝   " },
];

export const BANNER_TAGLINE = "Natural Language Computing Framework";

/** Compact banner for chat mode. */
export const BANNER_COMPACT = `${c.bold}${c.brightYellow}CRABMEAT${c.reset} ${c.dim}v0.1.0${c.reset}`;

// ── Welcome Screen ───────────────────────────────────────

export interface WelcomeInfo {
  agent: string;
  provider: string;
  model: string;
  arbiter: string;
  auth: string;
  tools: number;
  sessions: string;
}

const VERSION = "v0.1.0";

/**
 * Build a Claude-Code-style welcome box with the ASCII banner
 * spanning full width and a two-column info/tips section below.
 */
export function welcomeScreen(address: string, info?: WelcomeInfo): string {
  const INNER = 108;
  const LEFT_W = 54;
  const RIGHT_W = INNER - LEFT_W - 1; // 53, the 1 is the │ divider

  const b = c.dim; // border color

  // Pad an ANSI string to exact visible width
  const padTo = (s: string, w: number) => {
    const vis = stripAnsi(s).length;
    return vis >= w ? s : s + " ".repeat(w - vis);
  };

  const fullRow = (content: string) =>
    `${b}${BOX.lightV}${c.reset} ${padTo(content, INNER)} ${b}${BOX.lightV}${c.reset}`;

  const emptyRow = fullRow("");

  const twoCol = (left: string, right: string) =>
    `${b}${BOX.lightV}${c.reset} ${padTo(left, LEFT_W - 1)}${b}${BOX.lightV}${c.reset} ${padTo(right, RIGHT_W)} ${b}${BOX.lightV}${c.reset}`;

  // Top border with title
  const title = ` CrabMeat ${VERSION} `;
  const topLine = `${b}${BOX.roundTL}${BOX.lightH}${BOX.lightH}${BOX.lightH}${c.reset}${theme.heading(title)}${b}${BOX.lightH.repeat(INNER - title.length - 1)}${BOX.roundTR}${c.reset}`;

  // Banner rows
  const bannerRows = BANNER_LINES.map((l) => fullRow(l));

  // Horizontal divider with tee
  const midDiv = `${b}${BOX.lightV} ${BOX.lightH.repeat(LEFT_W - 1)}${BOX.teeDown}${BOX.lightH.repeat(RIGHT_W + 2)}${BOX.lightV}${c.reset}`;

  // Build left column lines
  const leftLines: string[] = [];
  if (info) {
    leftLines.push(`  ${theme.kv("agent  ", info.agent)}`);
    leftLines.push(`  ${theme.kv("model  ", `${info.model} (${info.provider})`)}`);
    leftLines.push(`  ${theme.kv("arbiter", info.arbiter)}`);
    leftLines.push(`  ${theme.kv("tools  ", String(info.tools))}  ${theme.dim("·")}  ${theme.kv("auth", info.auth)}  ${theme.dim("·")}  ${theme.kv("sessions", info.sessions)}`);
    leftLines.push(`  ${theme.kv("address", address)}`);
  } else {
    leftLines.push(`  ${theme.kv("address", address)}`);
  }

  // Build right column lines
  const rightLines: string[] = [];
  rightLines.push(theme.heading("Tips"));
  rightLines.push(`${theme.dim("Type")} ${theme.accent("/help")} ${theme.dim("for available commands")}`);
  rightLines.push(`${theme.dim("Type")} ${theme.accent("/quit")} ${theme.dim("to disconnect")}`);

  // Pad columns to same height
  const maxRows = Math.max(leftLines.length, rightLines.length) + 2; // +2 for top/bottom padding
  const paddedLeft: string[] = ["", ...leftLines];
  const paddedRight: string[] = ["", ...rightLines];
  while (paddedLeft.length < maxRows) paddedLeft.push("");
  while (paddedRight.length < maxRows) paddedRight.push("");

  const infoRows = paddedLeft.map((l, i) => twoCol(l, paddedRight[i] ?? ""));

  // Bottom border
  const bottomLine = `${b}${BOX.roundBL}${BOX.lightH.repeat(INNER + 2)}${BOX.roundBR}${c.reset}`;

  return [
    topLine,
    emptyRow,
    ...bannerRows,
    midDiv,
    ...infoRows,
    bottomLine,
  ].join("\n");
}
