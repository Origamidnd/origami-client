import { describe, expect, it } from 'vitest'

import { explainSubscriptionError } from './errors'

describe('explainSubscriptionError', () => {
  it.each([
    [
      'failed to fetch remote profile with status 404 Not Found',
      'origami.errors.notFound',
    ],
    [
      {
        code: 'PROFILE_IMPORT_FAILED',
        detail: 'failed to fetch remote profile with status 403 Forbidden',
      },
      'origami.errors.forbidden',
    ],
    [
      'failed to fetch remote profile with status 429 Too Many Requests',
      'origami.errors.tooMany',
    ],
    [
      'failed to fetch remote profile with status 502 Bad Gateway',
      'origami.errors.server',
    ],
    ['the remote profile data is invalid yaml', 'origami.errors.badFormat'],
    [
      'failed to fetch remote profile: error sending request: operation timed out',
      'origami.errors.network',
    ],
  ])('%s', (error, key) => {
    expect(explainSubscriptionError(error)).toBe(key)
  })

  it('leaves unknown and TLS errors to the stock message', () => {
    expect(explainSubscriptionError('something odd')).toBeNull()
    expect(
      explainSubscriptionError(
        'Subscription server uses legacy TLS; TLS 1.0/1.1 is insecure, connection refused',
      ),
    ).toBeNull()
  })
})
