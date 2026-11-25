import assert from 'node:assert/strict'
import { computeFixNextStatus, interruptedPushLanded } from '../core/fix/status'

// has unpushed changes → ready (regardless of the current status)
assert.equal(computeFixNextStatus({ dirty: true, ahead: false, currentStatus: 'open' }), 'ready')
assert.equal(computeFixNextStatus({ dirty: false, ahead: true, currentStatus: 'pushed' }), 'ready')
assert.equal(computeFixNextStatus({ dirty: true, ahead: true, currentStatus: 'error' }), 'ready')

// no changes: already pushed before → stay pushed
assert.equal(computeFixNextStatus({ dirty: false, ahead: false, currentStatus: 'pushed' }), 'pushed')

// no changes + not pushed (including null/unknown) → fall back to open
assert.equal(computeFixNextStatus({ dirty: false, ahead: false, currentStatus: 'open' }), 'open')
assert.equal(computeFixNextStatus({ dirty: false, ahead: false, currentStatus: 'error' }), 'open')
assert.equal(computeFixNextStatus({ dirty: false, ahead: false, currentStatus: null }), 'open')
assert.equal(computeFixNextStatus({ dirty: false, ahead: false }), 'open')

// startup recovery of an upload cut off while busy_action = pushing
assert.equal(interruptedPushLanded({ localHead: 'a1', remoteHead: 'a1', dirty: false }), true, 'committed and pushed')
assert.equal(interruptedPushLanded({ localHead: 'a1', remoteHead: 'a1', dirty: true }), false, 'cut off before the commit (pre-upload check): nothing was pushed')
assert.equal(interruptedPushLanded({ localHead: 'b2', remoteHead: 'a1', dirty: false }), false, 'committed, not pushed')
assert.equal(interruptedPushLanded({ localHead: 'a1', remoteHead: 'a1', dirty: null }), false, 'worktree state unknown')
assert.equal(interruptedPushLanded({ localHead: 'a1', remoteHead: null, dirty: false }), false, 'remote unreachable')

console.log('fix-next-status: ok')
