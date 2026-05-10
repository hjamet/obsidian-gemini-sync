# Refonte de la Synchronisation Google Tasks

## 1. Contexte & Discussion (Narratif)

Le plugin `gemini-sync` possède un pont vers Google Tasks (`projectManager.ts`) qui fonctionne actuellement en mode **aspiration destructive** : il récupère les tâches, crée des fichiers Markdown, puis marque les tâches comme "completed" dans Google Tasks (ce qui les fait disparaître de la liste active).

L'utilisateur souhaite un modèle de **synchronisation vivante** :
- Les tâches restent actives des deux côtés tant qu'elles ne sont pas terminées.
- La complétion est bidirectionnelle : terminer dans Obsidian → termine dans Google Tasks (et vice-versa).
- Les tâches sont importées quel que soit leur statut temporel (Anticipation Globale).
- Un champ `due` est écrit dans le frontmatter des notes pour refléter l'échéance Google Tasks.
- Le filtre `[PROJET]` est abandonné : toutes les tâches de la liste par défaut sont éligibles.

L'API Google Tasks v1 n'expose qu'un seul champ de date (`due`). Ce champ est désormais extrait et injecté dans le frontmatter Obsidian sous la clé `due: "YYYY-MM-DD"`.

## 2. Fichiers Concernés
- `src/sync/projectManager.ts` — Logique principale de synchronisation
- `src/drive/tasksClient.ts` — Client API Google Tasks
- `src/main.ts` — Interface settings (`deleteTaskAfterSync`, UI)
- `README.md` — Documentation du comportement

## 3. Objectifs (Definition of Done)

* La tâche Google Tasks **reste active** après import dans Obsidian (pas de complétion automatique).
* Quand une note locale avec `googleTaskId` passe en `status: completed` (ou reçoit le tag `projet-fini`), le plugin appelle l'API pour **compléter la tâche** dans Google Tasks.
* La synchro inverse (Google → Obsidian, déjà en place) continue de fonctionner.
* **Toutes les tâches** sont importées, y compris celles dont le champ `due` est dans le futur (Anticipation Globale).
* Le champ `due` est **ajouté au frontmatter** des notes créées (format `YYYY-MM-DD`).
* Le setting `deleteTaskAfterSync` est **supprimé** de l'interface et du code.
* Le README reflète le nouveau comportement.
