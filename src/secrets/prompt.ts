/**
 * The one-shot NO-ECHO terminal prompt — the single sanctioned interactive read (a token capture), never a
 * crawl-blocking read. It writes the prompt to stderr (so stdout stays clean for a piped `--json`), reads
 * the line from the TTY in raw mode with echo OFF (nothing the user types is shown), and returns it. Enter
 * ends the line; Ctrl-C aborts (empty string, which the caller rejects as empty). Backspace edits.
 *
 * Effectful edge (like `readStdin`): pure terminal I/O, no fs/network/SDK, so no boundary/door seam. The
 * value is returned to the caller and never logged here.
 */

const ENTER = new Set(["\n", "\r"]);
const BACKSPACE = new Set(["\u007f", "\b"]);
const CTRL_C = "\u0003";

/**
 * Prompt on stderr and read a line from the TTY with echo disabled.
 *
 * @param prompt the prompt text (written to stderr, not stdout)
 * @returns the entered line (without the trailing newline); empty string on Ctrl-C/EOF
 */
export async function promptSecretNoEcho({ prompt }: { prompt: string }): Promise<string> {
  const stdin = process.stdin;
  process.stderr.write(prompt);
  return new Promise((resolve) => {
    let buffer = "";
    const finish = (value: string): void => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener("data", onData);
      process.stderr.write("\n");
      resolve(value);
    };
    const onData = (chunk: Buffer): void => {
      for (const ch of chunk.toString("utf8")) {
        if (ENTER.has(ch)) {
          finish(buffer);
          return;
        }
        if (ch === CTRL_C) {
          finish(""); // abort with an empty value (rejected upstream as empty)
          return;
        }
        buffer = BACKSPACE.has(ch) ? buffer.slice(0, -1) : buffer + ch;
      }
    };
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
  });
}
