export function restoreEnvironment(
  snapshot: Readonly<Record<string, string | undefined>>,
  environment: NodeJS.ProcessEnv = process.env
): void {
  for (const [name, value] of Object.entries(snapshot)) {
    if (value === undefined) {
      delete environment[name];
    } else {
      environment[name] = value;
    }
  }
}
