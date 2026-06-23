export function trimTerminalPunct(s: string): string {
  return s.replace(/[.,;!?]+$/, "");
}
