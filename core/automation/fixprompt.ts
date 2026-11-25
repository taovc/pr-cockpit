import { pickByLang } from '../agent/lang'
import { reviewFindingStats } from './findings'

// The default instruction auto-fix hands the agent: list this review's findings that still need action
// (the definition lives in findings.ts) and have it edit them inside the worktree (no commit — the fix
// pipeline handles that). The language follows this review's working language — this text goes straight
// into the agent's conversation and is also shown in the UI as a user message, so all three languages get
// their own copy; do not use an "English or else Chinese" binary.
const FIX_MESSAGE = {
  zh: {
    header: '请逐条处理下面这些代码审核发现的问题，直接修改 worktree 里的文件（不要 commit，由上传流程统一提交）。修完后简述每条怎么改的。结束前运行仓库自己的检查（按仓库文档里写的测试 / 类型检查 / lint），贴出实际执行的命令和输出；跑不了的检查要说明原因。不要只说「已修复」。',
    problem: '问题',
    fix: '建议',
  },
  en: {
    header: 'Address each of the following code-review findings by editing the files in the worktree (do NOT commit — the upload step handles that). After fixing, briefly explain what you changed for each. Before you finish, run the repository\'s own checks (tests / typecheck / lint, as the repository documents them) and paste the exact commands and their output; if a check cannot run, say why. Never just claim it is fixed.',
    problem: 'Problem',
    fix: 'Suggested fix',
  },
  fr: {
    header: 'Traite chacun des points de revue ci-dessous en modifiant les fichiers du worktree (ne fais PAS de commit — l’étape d’envoi s’en charge). Une fois corrigé, explique brièvement ce que tu as changé pour chacun. Avant de terminer, lance les vérifications du dépôt (tests / typecheck / lint, comme le dépôt les documente) et colle les commandes exactes et leur sortie ; si une vérification ne peut pas tourner, dis pourquoi. Ne te contente jamais d’affirmer que c’est corrigé.',
    problem: 'Problème',
    fix: 'Correction suggérée',
  },
}

export function buildAutoFixMessage(db: any, schema: any, reviewId: string, lang: string): string | null {
  const todo = reviewFindingStats(db, schema, reviewId).actionableFindings
  if (!todo.length) return null

  const t = pickByLang(lang, FIX_MESSAGE)
  const lines = todo.map((f) => {
    const loc = f.location ? ` (${f.location})` : ''
    const prob = f.problem ? `\n  - ${t.problem}: ${f.problem}` : ''
    const fix = f.fix ? `\n  - ${t.fix}: ${f.fix}` : ''
    return `${f.fid} [${f.severity}] ${f.title}${loc}${prob}${fix}`
  })
  return `${t.header}\n\n${lines.join('\n\n')}`
}
