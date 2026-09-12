export class NotConfiguredError extends Error {
  constructor(
    public service: string,
    public envVars: string[],
  ) {
    super(`${service} no está configurado. Define: ${envVars.join(", ")}`);
    this.name = "NotConfiguredError";
  }
}
