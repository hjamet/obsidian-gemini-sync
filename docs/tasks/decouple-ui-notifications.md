# Découplage des Notifications UI (Separation of Concerns)

## 1. Contexte & Discussion (Narratif)
Lors d'une revue architecturale post-nettoyage TypeScript, l'agent Architect a identifié un couplage fort entre les couches d'infrastructure (API Google Drive, logique de synchronisation) et l'interface utilisateur Obsidian. Concrètement, 32 appels directs à `new Notice(...)` sont éparpillés dans des classes qui ne devraient pas connaître l'existence de l'UI.
Ce couplage empêche toute testabilité unitaire en dehors d'Obsidian et viole le principe de séparation des préoccupations (Separation of Concerns).
L'utilisateur a validé la proposition d'ajouter cette tâche à la roadmap.

## 2. Fichiers Concernés
- `src/drive/driveClient.ts` (3 appels `new Notice`)
- `src/sync/syncManager.ts` (11+ appels `new Notice`)
- `src/sync/projectManager.ts` (3 appels `new Notice`)
- `src/main.ts` (point d'entrée UI, 10+ appels `new Notice` — ceux-ci sont légitimes)
- `src/ui/setupWizard.ts` (4 appels — légitimes car c'est de l'UI pure)

## 3. Objectifs (Definition of Done)
*   **Aucun `new Notice()` dans les couches basses** : `driveClient.ts`, `syncManager.ts`, `projectManager.ts` ne doivent plus importer ni instancier `Notice` directement.
*   **Mécanisme de notification découplé** : Soit un `NotificationService` injectable, soit un pattern EventEmitter, soit des exceptions structurées remontées et catchées dans les points d'entrée UI (`main.ts`).
*   **Conservation du comportement utilisateur** : L'utilisateur doit toujours voir les mêmes notifications Obsidian qu'avant (messages, timing). Seul le chemin d'appel change.
*   **Build TypeScript** : `npm run build` sans erreur.
