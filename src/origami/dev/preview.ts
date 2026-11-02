import './mock-backend'

const path = new URLSearchParams(location.search).get('path') ?? '/'
history.replaceState(null, '', path)

void import('../../main')
