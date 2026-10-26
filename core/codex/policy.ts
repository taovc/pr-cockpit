import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk'
import { isForbiddenRemoteOrGitMutation } from '../agent/commandGuard'

// What each run kind is allowed to do on the Codex side, expressed in app-server terms (sandbox + approval policy) plus,
// for unattended kinds, the host-side decider that answers approval requests before the command runs.

export type SandboxPolicy =
  | { type: 'readOnly'; networkAccess: boolean }
  | { type: 'workspaceWrite'; writableRoots: string[]; networkAccess: boolean; excludeTmpdirEnvVar: boolean; excludeSlashTmp: boolean }
  | { type: 'dangerFullAccess' }
export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'
export type ApprovalPolicy = 'untrusted' | 'on-request' | 'never'
export type AutoDecision = 'accept' | 'decline'

export type CodexPolicy = {
  sandbox: SandboxPolicy
  sandboxMode: SandboxMode // thread/start takes the string form; turn/start the full policy
  approval: ApprovalPolicy
  // Unattended kinds answer approval requests themselves; null = a human answers through the permission bridge.
  autoDecide: ((command: string) => AutoDecision) | null
  ephemeral: boolean
}

export function sandboxModeOf(s: SandboxPolicy): SandboxMode {
  return s.type === 'readOnly' ? 'read-only' : s.type === 'workspaceWrite' ? 'workspace-write' : 'danger-full-access'
}

// Review family: physically read-only, network only for `gh` reads, and EVERY command is submitted for approval
// (`untrusted`) so git/GitHub mutations are declined before they run instead of detected afterwards.
export function reviewPolicy(o: { allowNetwork: boolean }): CodexPolicy {
  const sandbox: SandboxPolicy = { type: 'readOnly', networkAccess: o.allowNetwork }
  return { sandbox, sandboxMode: sandboxModeOf(sandbox), approval: 'untrusted', autoDecide: (cmd) => (isForbiddenRemoteOrGitMutation(cmd) ? 'decline' : 'accept'), ephemeral: true }
}

// One-shot helpers (commit message, title, comment rewrite): read-only, no network, nothing to approve.
export function helperPolicy(): CodexPolicy {
  const sandbox: SandboxPolicy = { type: 'readOnly', networkAccess: false }
  return { sandbox, sandboxMode: 'read-only', approval: 'never', autoDecide: () => 'decline', ephemeral: true }
}

// Interactive sessions. The permission mode maps onto Codex's approval policy; the danger switch opens the sandbox
// and the network (that is what "allow dangerous commands" means here: push / gh writes become physically possible).
//   plan              → read-only sandbox (the model can investigate but not edit), approvals on request
//   default/acceptEdits → workspace-write, network off, approvals on request (a network/escalation need becomes a card)
//   bypassPermissions → workspace-write, network off, no approvals (sandbox denials simply fail)
export function sessionPolicy(o: { cwd: string; permissionMode?: PermissionMode | null; allowDanger?: boolean }): CodexPolicy {
  const mode = o.permissionMode ?? 'default'
  const danger = !!o.allowDanger
  let sandbox: SandboxPolicy
  if (mode === 'plan') sandbox = { type: 'readOnly', networkAccess: danger }
  else if (danger) sandbox = { type: 'dangerFullAccess' }
  else sandbox = { type: 'workspaceWrite', writableRoots: [o.cwd], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false }
  const approval: ApprovalPolicy = mode === 'bypassPermissions' ? 'never' : 'on-request'
  return { sandbox, sandboxMode: sandboxModeOf(sandbox), approval, autoDecide: null, ephemeral: false }
}
