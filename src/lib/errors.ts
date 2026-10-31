/** An error whose message is meant for the user (validation, "not found", "can't apply"). Anything else is internal. */
export class RequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RequestError";
  }
}

/** Remove credentials from text before it is logged or stored (connection strings, SMTP URLs, API keys). */
export function redact(text: string): string {
  let out = text.replace(/([a-z][a-z0-9+.-]*:\/\/)([^:/@\s]+):([^@\s]+)@/gi, "$1$2:***@").replace(/sk-ant-[A-Za-z0-9_-]+/g, "sk-ant-***");
  for (const name of ["DATABASE_URL", "SMTP_URL", "ANTHROPIC_API_KEY", "MONITOR_CRON_SECRET"]) {
    const v = process.env[name];
    if (v && v.length >= 6) out = out.split(v).join(`[${name}]`);
  }
  return out;
}

/** The response for an unexpected error: logged (redacted) on the server, generic for the client. */
export function internalError(err: unknown, where: string): Response {
  console.error(`[${where}] ${redact(err instanceof Error ? `${err.name}: ${err.message}` : String(err))}`);
  return Response.json({ errors: ["Something went wrong on the server. Nothing was changed. Please try again."] }, { status: 500 });
}
