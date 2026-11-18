export type CliValue = string | string[] | boolean;
export type CliArgs = Record<string, CliValue>;

export function getString(args: CliArgs, key: string): string | undefined {
  const value = args[key];
  if (Array.isArray(value)) {
    return value.at(-1);
  }
  return typeof value === "string" ? value : undefined;
}

export function getStrings(args: CliArgs, key: string): string[] {
  const value = args[key];
  if (Array.isArray(value)) {
    return value;
  }
  return typeof value === "string" ? [value] : [];
}

export function getBoolean(args: CliArgs, key: string): boolean {
  return args[key] === true;
}
