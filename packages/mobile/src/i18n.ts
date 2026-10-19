// Copy is data (ADR 0016 rule 11): whole sentences with named placeholders,
// keyed, so each can be translated into Swahili as written. A missing key or
// an unfilled placeholder throws, so a test fails instead of a screen showing
// a key or a "{amount}".

export type Messages = Readonly<Record<string, string>>;
export type Translate = (key: string, values?: Readonly<Record<string, string>>) => string;

export function translator(messages: Messages): Translate {
  return (key, values = {}) => {
    const text = messages[key];
    if (text === undefined) throw new Error(`No text for message "${key}"`);
    return text.replace(/\{([a-z_]+)\}/g, (_match, name: string) => {
      const value = values[name];
      if (value === undefined) throw new Error(`Message "${key}" needs a value for {${name}}`);
      return value;
    });
  };
}
