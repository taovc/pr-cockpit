<div align="center">
  <img src="public/logo.svg" width="64" height="64" alt="PR Cockpit" />
  <h1>PR Cockpit</h1>
  <p><b>Passez en revue toute la file de PR d'un dépôt avec Claude ou Codex — en local.</b><br />
  Votre code ne quitte jamais votre machine, tout tourne sur votre propre abonnement Claude/Codex,<br />
  et rien n'est publié sur GitHub tant que vous n'avez pas coché la case.</p>
</div>

<p align="center">
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-555" alt="Plateformes : macOS, Windows, Linux" />
  <img src="https://img.shields.io/badge/providers-Claude%20%C2%B7%20Codex-D97757?logo=anthropic&logoColor=white" alt="Providers : Claude et Codex" />
  <a href="https://nuxt.com"><img src="https://img.shields.io/badge/Nuxt-4-00DC82?logo=nuxt&logoColor=white" alt="Nuxt 4" /></a>
  <a href="https://www.typescriptlang.org"><img src="https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white" alt="TypeScript 5" /></a>
  <a href="https://github.com/taovc/pr-cockpit/actions/workflows/desktop-release.yml"><img src="https://img.shields.io/github/actions/workflow/status/taovc/pr-cockpit/desktop-release.yml?branch=main&label=desktop%20build" alt="Statut du build desktop" /></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-22c55e" alt="Licence : MIT" /></a>
</p>

<div align="center">

[English](README.md) · [中文](README.zh.md) · **Français**

</div>

<div align="center">
  <img src="docs/media/demo.gif" width="900" alt="Importer la file de PR d'un dépôt, la faire auditer par l'IA dans un worktree isolé, valider les findings, les publier sur GitHub en inline comments" />
</div>

## Téléchargement

Le plus rapide pour essayer : une version desktop — pas de clone, pas de chaîne d'outils.

**[⬇ Télécharger un build](https://github.com/taovc/pr-cockpit/releases)** — les builds sont pour l'instant publiés sous forme de pré-version `nightly` glissante, reconstruite à chaque push sur `main`.

| Plateforme | Fichier |
|---|---|
| macOS (Apple Silicon) | `pr-cockpit-<version>-arm64.dmg` |
| Windows (x64) | `pr-cockpit-<version>-x64.exe` |
| Linux (x86_64) | `pr-cockpit-<version>-x86_64.AppImage` |

Les Mac Intel n'ont pas encore de paquet précompilé — passez par la [compilation depuis les sources](#compilation-depuis-les-sources).

**Aucun des paquets n'est signé** : les trois plateformes affichent un avertissement au premier lancement.

- **macOS** signale une application endommagée ou d'un développeur non identifié. Retirez l'attribut de quarantaine une fois :
  ```bash
  xattr -dr com.apple.quarantine "/Applications/PR Cockpit.app"
  ```
  Ou clic droit sur l'application dans le Finder → **Ouvrir** → **Ouvrir** dans la boîte de dialogue.
- **Windows** affiche la boîte SmartScreen « Windows a protégé votre ordinateur ». Cliquez sur **Informations complémentaires** → **Exécuter quand même**.
- **Linux** exige que l'AppImage soit exécutable avant de démarrer :
  ```bash
  chmod +x pr-cockpit-*-x86_64.AppImage
  ```

Dans tous les cas, il faut encore `gh auth login` et une connexion Claude ou Codex pour que l'application serve à quelque chose — voir [Prérequis](#prérequis).

## Comment ça marche

Fini la revue des PR une par une dans le terminal, et fini les corrections dispersées entre plusieurs shells. On importe les PR d'un dépôt → l'IA audite, recheck, corrige ou développe dans des worktrees isolés → vous validez les findings, conversations, diffs, pushs et créations de PR dans le web → GitHub reste la couche externe partagée. Chaque projet peut choisir Claude ou Codex avec son modèle, son effort et sa méthodologie.

## Fonctionnalités

**Atelier PR et revue**
- Import direct de la liste des PR via `gh` / GraphQL, avec filtres par auteur, état PR, état de revue, état de correction et état de worktree ; la liste se rafraîchit automatiquement par polling tant que la page est visible.
- Le drawer de droite affiche revue IA, correction, timeline et diff ; descriptions et commentaires sont rendus en markdown.
- L'IA audite en lecture seule dans un git worktree isolé et produit des findings structurés — sévérité, `path:line`, problème, détail et piste de correction — ainsi qu'un résumé en langage clair de ce que vise la PR et le chemin de test manuel le plus court.
- La re-revue guidée conserve vos coches/notes ; le recheck après push de l'auteur relit les derniers commits et juge chaque finding.

**Contrôle humain + publication**
- Coche par finding « publier en commentaire de PR » + ajout d'une note (la note sert d'instruction d'édition intégrée au commentaire, elle n'est pas divulguée telle quelle).
- Aperçu avant publication (dry-run, pouvant être mis en cache / régénéré) ; les findings rédigés dans n'importe quelle langue de travail sont réécrits en anglais professionnel pour GitHub.
- Les findings dont le `path:line` tombe sur une ligne réellement modifiée par la PR sont publiés en commentaires inline ; les autres sont regroupés dans une section de synthèse au lieu d'être perdus.
- La publication passe par `gh api .../reviews`, avec claim `posting` et auto-réparation des pending reviews résiduels, ce qui évite les publications concurrentes en double.

**Correction de PR**
- Le tab de correction est un chat persistant : l'agent modifie le worktree de la PR, mais ne commit/push pas par défaut.
- « Commit and upload » affiche d'abord le diff et un message de commit conventionnel éditable ; la confirmation seule lance `git add/commit/push`.
- Stop/reprise, logs d'exécution dépliables, cartes de décision, un interrupteur ultracode qui pousse le tour vers un effort de raisonnement supérieur, et un interrupteur de commandes dangereuses sont pris en charge.

**Assistant de projet : chat dans le dossier et développement de feature**
- L'assistant de projet (bouton en bas à droite d'une page projet) démarre une session dans le dossier du projet ou dans un worktree de feature isolé sur une nouvelle branche (« Nouvelle branche »), et laisse l'agent développer dans une boucle de chat native.
- Les vrais points de décision sont rendus en cartes `ask-user`. L'ouverture de PR est une action explicite qui autorise commit, push et `gh pr create` pour ce tour ; les messages de commit et le titre/corps de la PR sont toujours rédigés en anglais.
- L'assistant global en bas à droite hérite du provider/cwd du projet quand c'est possible et prend en charge `/cd`, `/resume`, `/clear`, pour le diagnostic ponctuel et les opérations one-off.

**Configuration par projet**
- Chaque projet choisit Claude ou Codex. Revue, correction, recheck, génération de skill et réécriture de publication suivent ce provider sans mélanger sessions ni modèles.
- Les modèles Claude viennent du `claude` local ; Codex utilise des modèles prédéfinis/par défaut. Effort, Codex Fast/service tier et méthodologie sont configurables par projet.
- Plusieurs skills de revue, une seule active à la fois ; la génération IA lit les docs et l'architecture du dépôt local, crée un candidat et permet une comparaison diff avant activation — l'activation n'écrase jamais la skill courante.

**Sécurité & cohérence**
- Les agents de revue restent en lecture seule : blocage outil des écritures git, edits de fichiers, accès réseau et commandes dangereuses, avec contrat d'opération et lint de skill.
- Les chemins capables d'écrire tournent dans des worktrees isolés ; push, création de PR et commandes dangereuses exigent une action UI ou un interrupteur explicite.
- Les opérations git d'un même dépôt sont sérialisées ; les findings sont transactionnels ; les tâches supprimées nettoient leurs worktrees ; le redémarrage récupère ou stoppe les travaux interrompus.
- L'automatisation PR est risquée et désactivée par défaut ; activée, elle réutilise les endpoints review/post/fix/push depuis un poller serveur.

## Stack technique

Nuxt 4 + @nuxt/ui (Tailwind v4) · better-sqlite3 + drizzle · `@anthropic-ai/claude-agent-sdk` · `@openai/codex-sdk` · `gh` CLI local · packaging Electron qui lance Nitro via le mode Node d'Electron.

## Prérequis

Nécessaires quelle que soit la méthode d'installation :

- `gh auth login` effectué — toutes les lectures et écritures GitHub passent par la CLI GitHub
- Provider Claude : `claude` connecté localement ou `ANTHROPIC_API_KEY`
- Provider Codex : connexion Codex locale ou `OPENAI_API_KEY`

Nécessaires uniquement pour compiler depuis les sources :

- Node ≥ 22, pnpm 9

## Compilation depuis les sources

Guide pas-à-pas pour une première mise en route depuis les sources. Si vous voulez simplement utiliser l'application, [téléchargez une version desktop](#téléchargement) : aucune chaîne d'outils requise. Voir « Démarrage » plus bas pour la version condensée.

**1. Vérifier les prérequis**

```bash
node -v      # ≥ 22
pnpm -v      # 9.x  (sinon : corepack enable && corepack prepare pnpm@9 --activate)
gh --version
gh auth status   # doit indiquer « Logged in » ; sinon : gh auth login
```

Vérifier aussi que le provider prévu est disponible : Claude nécessite une connexion `claude` locale ou `ANTHROPIC_API_KEY` ; Codex nécessite une connexion Codex locale ou `OPENAI_API_KEY`.

**2. Récupérer le projet**

```bash
git clone https://github.com/taovc/pr-cockpit.git
cd pr-cockpit
```

**3. Configurer l'environnement**

```bash
cp .env.example .env
```

Toutes les variables ont des valeurs par défaut raisonnables ; en pratique vous n'ajustez que :

| Variable | Quand la modifier |
|---|---|
| `PORT` | Si `3001` est déjà occupé |
| `INFERENCE_PROVIDER` | `claude` (par défaut) ou `codex` |
| `ANTHROPIC_API_KEY` | Optionnel pour le chemin Claude ; à utiliser si la connexion locale `claude` n'est pas disponible |
| `OPENAI_API_KEY` | Si la connexion locale Codex n'est pas disponible et que vous voulez utiliser une clé OpenAI |

Le détail de toutes les variables est dans la section [Configuration (.env)](#configuration-env).

**4. Installer les dépendances**

```bash
pnpm install
```

Le `postinstall` lance automatiquement `nuxt prepare` (génération des types Nuxt).

**5. Premier lancement**

```bash
pnpm dev      # http://localhost:3001
```

Au premier démarrage, **la base SQLite (`./data/cockpit.db`) est créée automatiquement**. Par défaut, les worktrees sont placés dans `.pr-cockpit-worktrees/` à l'intérieur de chaque clone local de projet, afin que l'IDE puisse les détecter comme des worktrees locaux classiques (VS Code exige `git.repositoryScanMaxDepth` à `2` ou `-1` ; la valeur par défaut 1 ne scanne qu'un niveau). Ce répertoire est ajouté au `.git/info/exclude` du projet, ce qui garde propre le `git status` du dépôt principal. La récupération au démarrage déplace les anciens worktrees persistants depuis `./data/worktrees` quand ils existent encore. Aucune migration manuelle à lancer. Le schéma Drizzle est monté à la volée (`ensureSchema()` / `ensureColumns()` dans `core/db/client.ts`).

**6. Build de production (optionnel)**

```bash
pnpm build
pnpm preview
```

Prévisualisation / packaging Electron :

```bash
pnpm electron:preview
pnpm electron:dist
```

**Dépannage**

- **Port déjà utilisé** → changer `PORT` dans `.env`.
- **`gh` non authentifié** → `gh auth login` (les lectures/écritures GitHub en dépendent).
- **Inspecter la base** → `pnpm db:studio` (ouvre Drizzle Studio).

## Démarrage

```bash
cp .env.example .env      # ajuster au besoin PORT / modèle / chemins
pnpm install
pnpm dev                  # par défaut http://localhost:3001
```

Une fois dedans, clique sur le « ＋ » à gauche pour créer un projet (renseigne `owner/repo` + le chemin du clone local), configure provider/model/effort et génère une skill de revue. Utilise ensuite « Toutes les PR » pour revue/correction, ou l'assistant de projet (en bas à droite) pour un chat dans le dossier ou une nouvelle branche de feature.

## Configuration (.env)

Voir `.env.example` ; éléments clés :

| Variable | Exemple | Description |
|---|---|---|
| `PORT` | `3001` | Port |
| `INFERENCE_PROVIDER` | `claude` | `claude` / `codex` |
| `ANTHROPIC_MODEL` | `sonnet` | Modèle de revue par défaut (surchargeable par projet) |
| `CODEX_MODEL` |  | Modèle par défaut des projets Codex ; vide = défaut Codex |
| `CODEX_SERVICE_TIER` |  | Optionnel, niveau de vitesse Codex/OpenAI par défaut global ; le bouton Fast au niveau projet le remplace. Pour désactiver fast globalement, laissez vide/supprimez-le et retirez aussi `service_tier` de `~/.codex/config.toml` s'il est défini globalement |
| `CODEX_PROJECT_DOC_FALLBACK_FILENAMES` | `CLAUDE.md,.claude/CLAUDE.md` | Fichiers projet lus par Codex si `AGENTS.md` est absent |
| `OPENAI_API_KEY` | `sk-...` | Optionnel si la connexion locale Codex n'est pas disponible |
| `TRANSLATE_MODEL` | (vide) | Modèle pour réécrire les commentaires GitHub en anglais et pour les messages de commit / titres ; vide = le modèle du projet en effort bas (projets Claude uniquement) |
| `ANTHROPIC_API_KEY` | `sk-ant-...` | Optionnel pour le chemin Claude si la connexion locale n'est pas disponible |
| `DEFAULT_REPO` | `owner/repo` | Optionnel, dépôt par défaut quand on colle un numéro de PR brut |
| `DB_PATH` | `./data/cockpit.db` | Chemin SQLite |
| `WORKTREE_LOCATION` | `repo` | `repo` = `.pr-cockpit-worktrees/` visible par l'IDE dans chaque clone local ; `central` = utiliser `REPOS_DIR` |
| `REPOS_DIR` | `./data/worktrees` | Racine des worktrees en mode `central` ; source de migration legacy en mode `repo` |
| `MAX_CONCURRENCY` | `3` | Nombre maximum de revues en parallèle |

### Messages de log Codex

- `Not inside a trusted directory and --skip-git-repo-check was not specified` : Codex a démarré depuis un répertoire non-git. L'assistant global de la page projet privilégie le chemin local du projet comme répertoire de travail ; si vous faites `/cd` à la main vers un répertoire non-git, le runner saute automatiquement la vérification du dépôt git.
- `CodexWarning failed to parse plugin hooks config .../claude-plugins-official/.../hooks.json` : Codex a détecté la config de hooks d'un plugin Claude sans reconnaître ce format. Ce warning signifie en général que le hook a simplement été ignoré — pas que la tâche en cours a échoué.

## Arborescence

```
core/      Moteur : db / github / git(worktree) / agent(review·fix·feature·global·codex·skillgen) / automation / pipeline / events
server/    API Nuxt : projects / reviews / fixes / features / global sessions / skills / SSE / plugin de reprise au démarrage
app/       UI : navigation projets ; page projet (Toutes les PR / Configuration + tiroir de l'assistant de projet) ; drawer PR (Revue IA / Correction / Timeline / Modifs)
electron/  Shell desktop : démarre Nitro et charge l'UI HTTP locale
docs/      ARCHITECTURE.md — objectifs de design + invariants + mécanismes de sécurité
data/      SQLite + source de migration des anciens worktrees centralisés (ignorés par git)
```

Objectifs de design, invariants et défenses de sécurité détaillés dans [docs/ARCHITECTURE.fr.md](docs/ARCHITECTURE.fr.md).
