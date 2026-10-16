export type CommandWords = readonly string[];

// Alphabetic Bash control words; time is handled as a command wrapper by the guard.
const CONTROL_WORDS = new Set([
  "if",
  "then",
  "else",
  "elif",
  "fi",
  "for",
  "while",
  "until",
  "do",
  "done",
  "case",
  "esac",
  "function",
  "select",
  "in",
  "coproc",
]);

/** Deliberately small grammar: never infer auto-approval for expansions or shell programs. */
export function parseCommands(command: string): CommandWords[] | undefined {
  const commands: string[][] = [];
  let words: string[] = [];
  let word = "";
  let wordStarted = false;
  let quote: "'" | '"' | undefined;
  const finishWord = () => {
    if (wordStarted) words.push(word);
    word = "";
    wordStarted = false;
  };
  const finishCommand = (): boolean => {
    finishWord();
    const executable = words[0];
    if (!executable || !/^[a-zA-Z0-9_./-]+$/.test(executable) || CONTROL_WORDS.has(executable)) {
      return false;
    }
    commands.push(words);
    words = [];
    return true;
  };
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (character === undefined) break;
    if (quote !== undefined) {
      if (character === quote) {
        quote = undefined;
      } else {
        if (quote === '"' && /[$`\\]/.test(character)) return undefined;
        word += character;
      }
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      wordStarted = true;
    } else if (character === " " || character === "\t") {
      finishWord();
    } else if (character === ";" || character === "\n" || character === "|" || character === "&") {
      if (character === "&" && command[index + 1] !== "&") return undefined;
      if (!finishCommand()) return undefined;
      if ((character === "&" || character === "|") && command[index + 1] === character) index += 1;
    } else {
      if (!/[a-zA-Z0-9_./:=,@%+-]/.test(character)) return undefined;
      wordStarted = true;
      word += character;
    }
  }
  if (quote !== undefined || !finishCommand()) return undefined;
  return commands;
}

/** Backend-provided prefixes use the same literal grammar as execution decisions. */
export function isSingleCommandPrefix(command: string): boolean {
  const parsed = parseCommands(command);
  return parsed !== undefined && parsed.length === 1;
}
