import './mock-backend'

const params = new URLSearchParams(location.search)
const path = params.get('path') ?? '/'
// expert=1 / expert=0 opens the preview with expert mode on or off.
const expert = params.get('expert')
if (expert !== null) localStorage.setItem('origami.expertMode', expert)
history.replaceState(null, '', path)

void import('../../main')
