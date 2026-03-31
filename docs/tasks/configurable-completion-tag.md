# Rendre le tag de complétion configurable

## 1. Contexte & Discussion (Narratif)
> *L'utilisateur souhaite pouvoir relier dynamiquement Gemini Sync et Project Memory.*
- Jusqu'à présent, Gemini Sync utilisait un tag hardcodé `#projet-fini` (ou juste `projet-fini` dans le frontmatter) pour détecter la complétion d'un projet localement et valider la tâche sur Google Tasks.
- L'approche retenue pour garder le maximum de souplesse sans refactoriser tout l'écosystème avec un type de donnée natif (`done: true`), est de simplement exposer cette chaîne de caractères dans les paramètres du plugin Gemini Sync sous forme de `completionTag`.
- L'utilisateur pourra alors configurer le même `completionTag` dans `ProjectMemory` (champ `archiveTag`) et dans `GeminiSync`, garantissant la liaison entre les deux outils.

## 2. Fichiers Concernés
- `src/main.ts` (Ajout du SettingsUI et définition par défaut)
- `src/sync/projectManager.ts` (Usage de `this.settings.completionTag` à la place de "projet-fini")
- `README.md` (Manuel et Roadmap)

## 3. Objectifs (Definition of Done)
- L'utilisateur peut spécifier librement dans les paramètres de Gemini Sync le "Tag de complétion".
- Gemini Sync identifie qu'un projet local est terminé si ce paramètre configuré est présent parmi ses tags (en plus de `status: completed`).
- La flexibilité permet au développeur ou à l'utilisateur de synchroniser ce tag entre différents plugins.
