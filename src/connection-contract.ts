import type { TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import type { z as Zod } from 'zod'

/** Shared strict contract; the browser uses the Host's Zod module. */
export function connectionContribution(
  z: typeof Zod,
): TypertRemoteContribution {
  const snapshot = z.strictObject({
    phase: z.enum([
      'starting',
      'disconnected',
      'authorizing',
      'connecting',
      'connected',
      'reconnecting',
      'authorization_required',
      'error',
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
  const packageName = '@xbot/deepseek-harness-a2a'
  return {
    package: packageName,
    descriptors: [
      'status',
      'connect',
      'reauthorize',
      'cancelAuthorization',
    ].map((method) => ({
      id: `${packageName}#xbotA2a/${method}`,
      service: 'xbotA2a',
      namespace: 'xbotA2a',
      method,
      invocation: { kind: 'direct' },
      parameters: [],
      result: {
        mode: 'strict',
        typeSymbol: `${packageName}#ConnectionSnapshot`,
        create: () => snapshot,
        jsonSchema: z.toJSONSchema(snapshot),
      },
    })),
  }
}
