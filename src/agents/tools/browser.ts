/**
 * Browser automation tool powered by Playwright.
 *
 * Provides a persistent browser session that the agent can drive
 * across multiple tool calls: navigate, click, type, extract text,
 * scroll, and take screenshots.
 *
 * Isolation:
 * - Each session gets its own BrowserContext (separate cookies,
 *   localStorage, cache). Contexts share a single Browser process
 *   for efficiency but are fully isolated from each other.
 *
 * Security:
 * - Headless by default (no visible window unless configured)
 * - URL navigation checked against SSRF patterns
 * - No file:// or data: URLs allowed
 * - Download directory sandboxed to workspace
 * - JavaScript eval is NOT exposed (prevents sandbox escape)
 * - Screenshot output jailed to workspace
 * - Auto-closes after idle timeout (per session)
 */

import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { join, relative } from "node:path";
import { mkdir } from "node:fs/promises";
import { registerToolHandler } from "./handlers.js";
import { registerPromptFragment } from "../prompt-fragments.js";
import { getWorkspaceRoot } from "./builtins.js";
import { isSafeBaseUrl } from "../../config/schema.js";
import { logger } from "../../infra/logger.js";
import { formatErrorMessage } from "../../infra/errors.js";
import type { ToolExecutionContext } from "./types.js";

// ── Per-session browser state ────────────────────────────

interface BrowserSession {
  context: BrowserContext;
  page: Page;
  idleTimer: ReturnType<typeof setTimeout>;
}

/** Shared browser process — contexts provide isolation, not separate processes. */
let browser: Browser | null = null;

/** Map of session key → isolated browser context + page. */
const sessions = new Map<string, BrowserSession>();

const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // Close context after 5 min idle
const NAV_TIMEOUT_MS = 30_000;
const ACTION_TIMEOUT_MS = 10_000;
const MAX_TEXT_LENGTH = 50_000;
const SCREENSHOT_DIR = ".crabmeat/screenshots";

/** Fallback key when no session context is provided (e.g. Layer 0). */
const DEFAULT_SESSION_KEY = "__default__";

// ── Lifecycle ────────────────────────────────────────────

/** Ensure the shared browser process is running. */
async function ensureBrowser(): Promise<Browser> {
  if (browser?.isConnected()) return browser;

  logger.info("Launching headless Chromium for browser tool...");
  browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--disable-extensions",
    ],
  });

  return browser;
}

/** Reset the idle timer for a session. */
function touchIdle(key: string): void {
  const session = sessions.get(key);
  if (!session) return;

  clearTimeout(session.idleTimer);
  session.idleTimer = setTimeout(() => {
    void closeSession(key);
    logger.info({ sessionKey: key }, "Browser context closed due to idle timeout");
  }, IDLE_TIMEOUT_MS);
}

/** Get or create an isolated browser context + page for a session. */
async function ensurePage(key: string): Promise<Page> {
  const existing = sessions.get(key);
  if (existing && !existing.page.isClosed()) {
    touchIdle(key);
    return existing.page;
  }

  // Clean up stale entry if page was closed externally
  if (existing) {
    await closeSession(key);
  }

  const b = await ensureBrowser();

  const context = await b.newContext({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 800 },
    acceptDownloads: false,
  });

  const page = await context.newPage();
  page.setDefaultTimeout(ACTION_TIMEOUT_MS);

  const idleTimer = setTimeout(() => {
    void closeSession(key);
    logger.info({ sessionKey: key }, "Browser context closed due to idle timeout");
  }, IDLE_TIMEOUT_MS);

  sessions.set(key, { context, page, idleTimer });
  logger.info({ sessionKey: key, activeSessions: sessions.size }, "Browser context created");

  return page;
}

/** Close and clean up a single session's browser context. */
async function closeSession(key: string): Promise<void> {
  const session = sessions.get(key);
  if (!session) return;

  clearTimeout(session.idleTimer);
  sessions.delete(key);

  try { await session.page.close(); } catch { /* ignore */ }
  try { await session.context.close(); } catch { /* ignore */ }

  logger.info({ sessionKey: key, activeSessions: sessions.size }, "Browser context closed");

  // If no sessions remain, close the browser process to free memory
  if (sessions.size === 0 && browser) {
    try { await browser.close(); } catch { /* ignore */ }
    browser = null;
    logger.info("Browser process closed (no active sessions)");
  }
}

// ── URL safety check ─────────────────────────────────────

function isSafeNavUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    // Block dangerous schemes
    if (!["http:", "https:"].includes(parsed.protocol)) return false;
    // Reuse gateway SSRF checks (block private IPs, metadata endpoints)
    // Allow localhost if the user has allowLocalProviders — but for browsing
    // we're stricter: no localhost browsing (nothing useful there for agents)
    return isSafeBaseUrl(url, false);
  } catch {
    return false;
  }
}

// ── Action handlers ──────────────────────────────────────

async function actionNavigate(p: Page, url: string): Promise<string> {
  if (!isSafeNavUrl(url)) {
    return `[ERROR] URL blocked by security policy: ${url}. Only public http/https URLs are allowed.`;
  }

  try {
    const response = await p.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: NAV_TIMEOUT_MS,
    });

    const status = response?.status() ?? 0;
    const title = await p.title();

    // Auto-extract page text so the model gets useful content in one call
    let pageText = "";
    try {
      pageText = await p.evaluate(() => {
        function extractText(el: Element): string {
          if (["SCRIPT", "STYLE", "NOSCRIPT", "HEAD"].includes(el.tagName)) return "";
          const style = window.getComputedStyle(el);
          if (style.display === "none" || style.visibility === "hidden") return "";
          let result = "";
          for (const child of el.childNodes) {
            if (child.nodeType === Node.TEXT_NODE) {
              const t = child.textContent?.trim();
              if (t) result += t + " ";
            } else if (child.nodeType === Node.ELEMENT_NODE) {
              result += extractText(child as Element);
            }
          }
          return result;
        }
        return extractText(document.body).replace(/\s+/g, " ").trim();
      });
      if (pageText.length > 8000) {
        pageText = pageText.slice(0, 8000) + "\n... (truncated — use get_text with a selector for more)";
      }
    } catch {
      pageText = "(could not extract page text)";
    }

    return `Navigated to: ${p.url()}\nStatus: ${status}\nTitle: ${title}\n\n--- Page Content ---\n${pageText || "(no text content)"}`;
  } catch (err: unknown) {
    const msg = formatErrorMessage(err);
    return `[ERROR] Navigation failed: ${msg}`;
  }
}

async function actionClick(p: Page, selector: string): Promise<string> {
  try {
    await p.click(selector, { timeout: ACTION_TIMEOUT_MS });
    // Wait for any navigation or dynamic content
    await p.waitForTimeout(1000);
    const title = await p.title();
    return `Clicked: ${selector}\nCurrent page: ${p.url()}\nTitle: ${title}`;
  } catch (err: unknown) {
    const msg = formatErrorMessage(err);
    return `[ERROR] Click failed on '${selector}': ${msg}`;
  }
}

async function actionType(p: Page, selector: string, text: string): Promise<string> {
  try {
    await p.fill(selector, text, { timeout: ACTION_TIMEOUT_MS });
    return `Typed "${text.length > 100 ? text.slice(0, 100) + "..." : text}" into ${selector}`;
  } catch (err: unknown) {
    // fill() might not work on all elements, try type() as fallback
    try {
      await p.click(selector, { timeout: ACTION_TIMEOUT_MS });
      await p.keyboard.type(text, { delay: 20 });
      return `Typed "${text.length > 100 ? text.slice(0, 100) + "..." : text}" into ${selector}`;
    } catch (err2: unknown) {
      const msg = formatErrorMessage(err2);
      return `[ERROR] Type failed on '${selector}': ${msg}`;
    }
  }
}

async function actionPressKey(p: Page, key: string): Promise<string> {
  try {
    await p.keyboard.press(key);
    await p.waitForTimeout(1000);
    return `Pressed key: ${key}\nCurrent page: ${p.url()}`;
  } catch (err: unknown) {
    const msg = formatErrorMessage(err);
    return `[ERROR] Key press failed: ${msg}`;
  }
}

async function actionGetText(p: Page, selector?: string): Promise<string> {
  try {
    let text: string;
    if (selector) {
      text = await p.locator(selector).first().innerText({ timeout: ACTION_TIMEOUT_MS });
    } else {
      // Get visible text from the entire page body
      text = await p.evaluate(() => {
        // Extract text content, skipping script/style/hidden elements
        function extractText(el: Element): string {
          if (el.tagName === "SCRIPT" || el.tagName === "STYLE" || el.tagName === "NOSCRIPT") return "";
          const style = window.getComputedStyle(el);
          if (style.display === "none" || style.visibility === "hidden") return "";

          let result = "";
          for (const child of el.childNodes) {
            if (child.nodeType === Node.TEXT_NODE) {
              const t = child.textContent?.trim();
              if (t) result += t + " ";
            } else if (child.nodeType === Node.ELEMENT_NODE) {
              result += extractText(child as Element);
            }
          }
          return result;
        }
        return extractText(document.body).replace(/\s+/g, " ").trim();
      });
    }

    if (text.length > MAX_TEXT_LENGTH) {
      text = text.slice(0, MAX_TEXT_LENGTH) + "\n... (truncated)";
    }

    return text || "(no text content found)";
  } catch (err: unknown) {
    const msg = formatErrorMessage(err);
    return `[ERROR] getText failed${selector ? ` on '${selector}'` : ""}: ${msg}`;
  }
}

async function actionGetLinks(p: Page, selector?: string): Promise<string> {
  try {
    const links = await p.evaluate((sel) => {
      const container = sel ? document.querySelector(sel) ?? document.body : document.body;
      const anchors = container.querySelectorAll("a[href]");
      const results: Array<{ text: string; href: string }> = [];
      for (const a of anchors) {
        const text = (a as HTMLAnchorElement).innerText?.trim().slice(0, 120);
        const href = (a as HTMLAnchorElement).href;
        if (text && href && !href.startsWith("javascript:")) {
          results.push({ text, href });
        }
        if (results.length >= 50) break;
      }
      return results;
    }, selector ?? null);

    if (links.length === 0) return "(no links found)";

    return links.map((l, i) => `${i + 1}. [${l.text}](${l.href})`).join("\n");
  } catch (err: unknown) {
    const msg = formatErrorMessage(err);
    return `[ERROR] getLinks failed: ${msg}`;
  }
}

async function actionScroll(p: Page, direction: string): Promise<string> {
  try {
    const amount = direction === "up" ? -600 : 600;
    await p.evaluate((dy) => window.scrollBy(0, dy), amount);
    await p.waitForTimeout(500);

    const position = await p.evaluate(() => ({
      scrollY: Math.round(window.scrollY),
      scrollHeight: document.documentElement.scrollHeight,
      viewportHeight: window.innerHeight,
    }));

    return `Scrolled ${direction}. Position: ${position.scrollY}px / ${position.scrollHeight}px (viewport: ${position.viewportHeight}px)`;
  } catch (err: unknown) {
    const msg = formatErrorMessage(err);
    return `[ERROR] Scroll failed: ${msg}`;
  }
}

async function actionScreenshot(p: Page, fullPage: boolean): Promise<string> {
  try {
    const workspace = getWorkspaceRoot();
    const screenshotDir = join(workspace, SCREENSHOT_DIR);
    await mkdir(screenshotDir, { recursive: true });

    const filename = `screenshot-${Date.now()}.png`;
    const filePath = join(screenshotDir, filename);

    await p.screenshot({
      path: filePath,
      fullPage,
      type: "png",
    });

    const relPath = relative(workspace, filePath);
    return `Screenshot saved: ${relPath}\nPage: ${p.url()}\nTitle: ${await p.title()}`;
  } catch (err: unknown) {
    const msg = formatErrorMessage(err);
    return `[ERROR] Screenshot failed: ${msg}`;
  }
}

async function actionWaitForSelector(p: Page, selector: string): Promise<string> {
  try {
    await p.waitForSelector(selector, { timeout: ACTION_TIMEOUT_MS, state: "visible" });
    return `Element is visible: ${selector}`;
  } catch (err: unknown) {
    const msg = formatErrorMessage(err);
    return `[ERROR] Wait for '${selector}' timed out: ${msg}`;
  }
}

// ── Main handler ─────────────────────────────────────────

async function handleBrowser(
  params: Record<string, unknown>,
  _signal?: AbortSignal,
  context?: ToolExecutionContext,
): Promise<{ content: string; isError?: boolean }> {
  const action = params.action as string;
  const url = params.url as string | undefined;
  const selector = params.selector as string | undefined;
  const text = params.text as string | undefined;
  const key = params.key as string | undefined;
  const direction = params.direction as string | undefined;
  const fullPage = (params.fullPage as boolean | undefined) ?? false;

  const sessionKey = context?.sessionKey ?? DEFAULT_SESSION_KEY;

  // Special case: close (tear down this session's context)
  if (action === "close") {
    await closeSession(sessionKey);
    return { content: "Browser closed." };
  }

  const p = await ensurePage(sessionKey);

  let result: string;

  switch (action) {
    case "navigate":
      if (!url) return { content: "Missing required parameter: url", isError: true };
      result = await actionNavigate(p, url);
      break;

    case "click":
      if (!selector) return { content: "Missing required parameter: selector", isError: true };
      result = await actionClick(p, selector);
      break;

    case "type":
      if (!selector || !text) return { content: "Missing required parameters: selector, text", isError: true };
      result = await actionType(p, selector, text);
      break;

    case "press_key":
      if (!key) return { content: "Missing required parameter: key", isError: true };
      result = await actionPressKey(p, key);
      break;

    case "get_text":
      result = await actionGetText(p, selector);
      break;

    case "get_links":
      result = await actionGetLinks(p, selector);
      break;

    case "scroll":
      result = await actionScroll(p, direction ?? "down");
      break;

    case "screenshot":
      result = await actionScreenshot(p, fullPage);
      break;

    case "wait_for":
      if (!selector) return { content: "Missing required parameter: selector", isError: true };
      result = await actionWaitForSelector(p, selector);
      break;

    default:
      return { content: `Unknown browser action: '${action}'. Available: navigate, click, type, press_key, get_text, get_links, scroll, screenshot, wait_for, close`, isError: true };
  }

  const isError = result.startsWith("[ERROR]");
  return { content: result, isError };
}

// ── Registration ─────────────────────────────────────────

export function registerBrowserTool(): void {
  registerToolHandler("browser", handleBrowser);
  registerPromptFragment({
    id: "tool:browser",
    category: "tool",
    predicate: (ctx) => ctx.tools.includes("browser"),
    order: 50,
    content: [
      "BROWSER USAGE: For ANY modern website (YouTube, Google, social media, web",
      "apps), use the browser tool — not web_fetch. Navigate to the page first,",
      "wait for content to load if needed (wait_for), use get_text or get_links to",
      "read what's on the page, and click/type/press_key to interact. Be proactive:",
      "if the user asks you to find YouTube videos, actually navigate to YouTube,",
      "search, and read the results — don't guess or hallucinate from training data.",
    ].join("\n"),
  });
  logger.info("Browser tool handler registered (Playwright/Chromium)");
}

/** Shutdown hook — call on gateway close. Tears down all sessions + browser. */
export async function shutdownBrowser(): Promise<void> {
  // Close all session contexts
  const keys = [...sessions.keys()];
  await Promise.all(keys.map((k) => closeSession(k)));

  // Final browser cleanup (closeSession handles this when last session closes,
  // but belt-and-suspenders for direct shutdown calls)
  if (browser) {
    try { await browser.close(); } catch { /* ignore */ }
    browser = null;
  }
}
