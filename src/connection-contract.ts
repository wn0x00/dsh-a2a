import type { TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import type { z as Zod } from 'zod'

/** Shared strict contract; the browser uses the Host's Zod module. */
export function connectionContribution(
  z: typeof Zod,
): TypertRemoteContribution {
  const snapshot = z.strictObject({
    phase: z.enum([
      'starting',
      'configuration_required',
      'disconnected',
      'authorizing',
      'connecting',
      'connected',
      'reconnecting',
      'authorization_required',
      'error',
      'updating',
      'stopped',
    ]),
    notice: z.enum([
      'none',
      'authorization_denied',
      'authorization_timeout',
      'authorization_failed',
      'registration_failed',
    ]),
    gatewayUrl: z.string(),
    deviceId: z.string(),
    deviceName: z.string(),
    activeTasks: z.number().int().nonnegative(),
    pendingExpiresAt: z.number().nullable(),
    lastConnectedAt: z.number().nullable(),
    lastContactAt: z.number().nullable(),
    canConnect: z.boolean(),
    canReauthorize: z.boolean(),
    canCancelAuthorization: z.boolean(),
  })
  const updateSnapshot = z.strictObject({
    phase: z.enum([
      'idle', 'checking', 'available', 'current', 'downloading', 'installing',
      'restart_required', 'updated', 'outcome_unknown', 'error',
    ]),
    currentVersion: z.string().min(1).max(80),
    latestVersion: z.string().min(1).max(80).nullable(),
    checkedAt: z.number().finite().nonnegative().nullable(),
    error: z.enum([
      'network', 'invalid_manifest', 'integrity', 'invalid_package', 'busy',
      'host_unavailable', 'host_refused', 'installation_failed',
      'installation_unknown', 'storage', 'update_changed',
    ]).nullable(),
    restartReason: z.string().max(80).nullable(),
    canInstall: z.boolean(),
  })
  const packageName = '@guanzhu.me/dsh-a2a'
  const version = z.string().max(80).regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u)
  const versionCodec = {
    mode: 'strict' as const,
    typeSymbol: `${packageName}#ExpectedPluginVersion`,
    create: () => version,
    jsonSchema: z.toJSONSchema(version),
  }
  return {
    package: packageName,
    descriptors: [
      'status',
      'connect',
      'reauthorize',
      'cancelAuthorization',
      'updateStatus',
      'checkUpdate',
      'installUpdate',
    ].map((method) => {
      const updates = ['updateStatus', 'checkUpdate', 'installUpdate'].includes(method)
      const result = updates ? updateSnapshot : snapshot
      return {
        id: `${packageName}#dshA2a/${method}`,
        service: 'dshA2a',
        namespace: 'dshA2a',
        method,
        invocation: { kind: 'direct' },
        parameters: method === 'installUpdate' ? [{
          name: 'expectedVersion', wire: 'expectedVersion', source: 'json' as const,
          codec: versionCodec, strictCodec: versionCodec,
        }] : [],
        ...(method === 'status' || method === 'updateStatus'
          ? { cancellation: { parameter: 'signal' as const } }
          : {}),
        result: {
          mode: 'strict',
          typeSymbol: `${packageName}#${updates ? 'PluginUpdateSnapshot' : 'ConnectionSnapshot'}`,
          create: () => result,
          encode: (value) => result.parse(value),
          decode: (value) => result.parse(value),
          jsonSchema: z.toJSONSchema(result),
        },
      }
    }),
  }
}
