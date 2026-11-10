import type { TaskDiagnostic } from './types.js'

/** Only allowlisted diagnostic fields leave the host. Never serialize task input,
 * commands, stdout, headers, arbitrary metadata, or a native event wholesale. */
export function diagnosticText(value: string, limit = 2000): string {
  return value
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gu, '[redacted]')
    .replace(/\b(?:sk-|xa2a_)[A-Za-z0-9_-]+/gu, '[redacted]')
    .replace(/\bBearer\s+[^\s,;"'}]+/giu, 'Bearer [redacted]')
    .replace(/\b(?:eyJ[A-Za-z0-9_-]+\.){2}[A-Za-z0-9_-]+/gu, '[redacted]')
    .replace(/\b(api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|authorization)\b(["']?\s*[:=]\s*["']?)[^\s,"';&}]+/giu, '$1$2[redacted]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/giu, '$1[redacted]@')
    .replace(/[\r\n\t]+/gu, ' ')
    .slice(0, limit)
}

export function safeDiagnostic(input: TaskDiagnostic): TaskDiagnostic {
  const result: TaskDiagnostic = { kind: input.kind }
  for (const key of ['stage', 'at', 'client_version', 'executor', 'local_session_id', 'local_turn_id', 'tool_name', 'error_code', 'provider', 'model'] as const) {
    if (typeof input[key] === 'string') result[key] = diagnosticText(input[key], key.startsWith('local_') ? 256 : 128)
  }
  for (const key of ['elapsed_ms', 'duration_ms'] as const) {
    const value = input[key]
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) result[key] = Math.round(value)
  }
  if (input.summary) result.summary = diagnosticText(input.summary)
  if (input.changes) result.changes = input.changes
  if (input.selection_source) result.selection_source = input.selection_source
  return result
}
