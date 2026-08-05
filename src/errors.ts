/**
 * The one error shape the gateway returns: Iceberg REST's `ErrorModel`
 * envelope (SPEC §15). Clients key on `code`; `type` is a free-form string
 * they surface in exception messages.
 */
export function errorResponse(code: number, type: string, message: string): Response {
  return Response.json({ error: { message, type, code } }, { status: code });
}
