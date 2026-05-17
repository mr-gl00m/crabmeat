/**
 * Framed input box. The visual centerpiece of the Ink port: top and
 * bottom horizontal borders sandwich the prompt symbol + input text,
 * matching Claude Code's PromptInput pattern. No left/right borders so
 * the box reads as a horizontal "input lane" rather than a closed
 * rectangle.
 *
 * Single-line input with cursor-position editing: arrow keys (left/right/
 * home/end) move the cursor, backspace deletes before it, and printable
 * input inserts at the cursor position. Up/down history and multi-line
 * are still follow-ups.
 */

import { Box, Text, useInput } from "ink";
import { useEffect, useState } from "react";

export interface PromptInputProps {
  value: string;
  onChange: (next: string) => void;
  onSubmit: (value: string) => void;
  /** True when a turn is in flight — switches the prompt glyph and
   *  signals "your line will be queued, not interrupt." */
  busy: boolean;
  /** Disable input entirely (e.g. while a slash-command response is
   *  being awaited from the gateway). */
  disabled?: boolean;
}

export function PromptInput({
  value,
  onChange,
  onSubmit,
  busy,
  disabled = false,
}: PromptInputProps) {
  const [cursor, setCursor] = useState<number>(value.length);

  // Clamp cursor when value length changes from the outside (parent
  // resets after submit, slash command rewrites the buffer, etc.). The
  // common case is value going to "" after Enter, which moves cursor
  // to 0 here.
  useEffect(() => {
    if (cursor > value.length) {
      setCursor(value.length);
    }
  }, [value.length, cursor]);

  useInput(
    (input, key) => {
      if (disabled) return;

      if (key.return) {
        onSubmit(value);
        return;
      }

      if (key.leftArrow) {
        setCursor((c) => Math.max(0, c - 1));
        return;
      }
      if (key.rightArrow) {
        setCursor((c) => Math.min(value.length, c + 1));
        return;
      }
      // Home / End. Ink does not expose these as named keys — they
      // arrive as raw escape sequences. Different terminals emit
      // different bytes (xterm vs vt100 vs Windows Terminal), so we
      // accept all common variants. Also keep ctrl-a / ctrl-e (readline
      // bindings) so muscle memory works without depending on key
      // detection.
      const HOME_SEQS = ["\x1b[H", "\x1b[1~", "\x1b[7~", "\x1bOH"];
      const END_SEQS = ["\x1b[F", "\x1b[4~", "\x1b[8~", "\x1bOF"];
      if (HOME_SEQS.includes(input)) {
        setCursor(0);
        return;
      }
      if (END_SEQS.includes(input)) {
        setCursor(value.length);
        return;
      }
      if (key.ctrl && input === "a") {
        setCursor(0);
        return;
      }
      if (key.ctrl && input === "e") {
        setCursor(value.length);
        return;
      }

      // Forward-delete (the dedicated "Del" key on Windows, fn+delete
      // on Mac) emits a specific escape sequence. Detect by raw input
      // because Ink's `key.delete` flag *also* fires for the Backspace
      // key on Windows (Backspace sends \x7f, which Ink classifies as
      // delete). Conflating the two would make Backspace stop working.
      const FORWARD_DEL_SEQS = ["\x1b[3~", "\x1b[P"];
      if (FORWARD_DEL_SEQS.includes(input)) {
        if (cursor < value.length) {
          onChange(value.slice(0, cursor) + value.slice(cursor + 1));
          // cursor stays put — character ahead of it is gone
        }
        return;
      }
      // Backward-delete: covers Backspace (key.backspace) and the BS
      // character variant (\x7f) that Ink reports as key.delete on
      // Windows. Together these handle every "remove the character
      // before the cursor" key across platforms.
      if (key.backspace || key.delete) {
        if (cursor > 0) {
          onChange(value.slice(0, cursor - 1) + value.slice(cursor));
          setCursor((c) => Math.max(0, c - 1));
        }
        return;
      }

      // Filter out non-printable inputs. Ink delivers control sequences
      // with various flags set; we only insert when none of them are.
      if (
        input &&
        !key.ctrl &&
        !key.meta &&
        !key.tab &&
        !key.escape &&
        !key.upArrow &&
        !key.downArrow &&
        !key.pageUp &&
        !key.pageDown
      ) {
        const next = value.slice(0, cursor) + input + value.slice(cursor);
        onChange(next);
        setCursor((c) => c + input.length);
      }
    },
    { isActive: !disabled },
  );

  const symbol = busy ? "▸" : "❯";
  const before = value.slice(0, cursor);
  const atCursor = value.slice(cursor, cursor + 1);
  const after = value.slice(cursor + 1);

  // Render the prompt + content as a SINGLE <Text> with nested style
  // overrides for the cursor. The previous version put each segment in
  // its own <Text> inside a flex <Box>, which made Ink treat them as
  // separate inline blocks and reflow weirdly when the value wrapped to
  // a second line — left-arrowing into wrapped content would jumble the
  // visual layout. A single Text keeps the run continuous and lets the
  // terminal's natural wrap behave normally.
  return (
    <Box
      borderStyle="round"
      borderLeft={false}
      borderRight={false}
      paddingX={1}
    >
      <Text>
        <Text bold color="cyan">{symbol}</Text>
        <Text> </Text>
        <Text>{before}</Text>
        {atCursor.length > 0 ? (
          <Text inverse>{atCursor}</Text>
        ) : (
          <Text color="cyan">▌</Text>
        )}
        <Text>{after}</Text>
      </Text>
    </Box>
  );
}
