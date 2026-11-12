import { describe, expect, it } from 'vitest'

import { routeExcludeForSave } from './tun-route-exclude'

describe('routeExcludeForSave', () => {
  it('leaves an untouched list to whoever owns it', () => {
    expect(
      routeExcludeForSave(
        ['10.0.0.0/8', '192.168.0.0/16'],
        ['10.0.0.0/8', '192.168.0.0/16'],
      ),
    ).toEqual({})
  })

  it('saves a list that was edited, including an emptied one', () => {
    expect(
      routeExcludeForSave(['10.0.0.0/8'], ['10.0.0.0/8', '1.1.1.1/32']),
    ).toEqual({
      'route-exclude-address': ['10.0.0.0/8', '1.1.1.1/32'],
    })
    expect(routeExcludeForSave(['10.0.0.0/8'], [])).toEqual({
      'route-exclude-address': [],
    })
  })
})
