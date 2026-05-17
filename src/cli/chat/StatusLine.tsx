/**
 * Live status indicator: shimmer animation + elapsed clock. Renders
 * when the agent is busy and no streaming assistant message is active.
 *
 * Mounts only while agentBusy is true; unmounts cleanly on TURN_DONE.
 * Animation is driven by a local 120ms tick.
 *
 * Shimmer is a wave pulse: bright section grows left-to-right until it
 * fills the whole label, then drains left-to-right, then restarts. No
 * "everything dim" gap frames between cycles — every frame has visible
 * motion across the label, so the animation reads as a continuous pulse
 * rather than a sweep that freezes mid-word.
 */

import { Box, Text } from "ink";
import { useEffect, useState } from "react";
import { formatElapsed } from "../ui.js";

export interface StatusLineProps {
  /** Base label (without the leading "* "). Reducer feeds either
   *  "thinking" or the active tool name. */
  label: string;
  /** ms-since-epoch the turn started. Drives the elapsed display. */
  startMs: number;
  /** Token count to surface alongside elapsed time. */
  tokens: number;
}

export function StatusLine({ label, startMs, tokens }: StatusLineProps) {
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 120);
    return () => clearInterval(id);
  }, []);

  const text = `* ${label}`;
  const len = text.length;
  // Wave pulse. Phase 1 (grow): bright section spans [0, i+1] for
  // i in [0, len-1]. At i=len-1 the entire label is bright. Phase 2
  // (drain): bright section spans [i+1, len] for i in [0, len-1]. At
  // i=len-1 only the last char remains bright, then the cycle wraps
  // to phase 1 with bright=text[0..1] — continuous motion, no gap.
  const total = Math.max(2, len * 2);
  const pos = tick % total;
  const isGrow = pos < len;
  const i = isGrow ? pos : pos - len;
  const brightStart = isGrow ? 0 : i + 1;
  const brightEnd = isGrow ? i + 1 : len;

  const before = text.slice(0, brightStart);
  const bright = text.slice(brightStart, brightEnd);
  const after = text.slice(brightEnd);

  const elapsed = formatElapsed(startMs);
  const tokPart = tokens > 0 ? ` · ${tokens} tok` : "";

  // Single nested <Text> rather than three siblings inside a flex
  // <Box>. Sibling Text elements get treated as separate inline blocks
  // by Ink and reflow weirdly when the line is near terminal width;
  // a single Text with nested style overrides keeps the run continuous.
  return (
    <Box paddingX={2}>
      <Text>
        <Text dimColor color="yellow">{before}</Text>
        <Text bold color="yellowBright">{bright}</Text>
        <Text dimColor color="yellow">{after}</Text>
        <Text dimColor>{` • ${elapsed}${tokPart}`}</Text>
      </Text>
    </Box>
  );
}
