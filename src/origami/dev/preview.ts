import './mock-backend'

const params = new URLSearchParams(location.search)
const path = params.get('path') ?? '/'
// expert=1 / expert=0 opens the preview with expert mode on or off.
const expert = params.get('expert')
if (expert !== null) localStorage.setItem('origami.expertMode', expert)
// focus=<group name> opens the Servers tab on that service, as the home server plate does.
const focus = params.get('focus')
history.replaceState(
  focus ? { usr: { origamiFocusGroup: focus }, key: 'preview', idx: 0 } : null,
  '',
  path,
)

void import('../../main')
