# Nettoyage des Types `any` (TypeScript Strictness)

## 1. Contexte & Discussion (Narratif)
Lors d'une revue architecturale post-refonte de la synchronisation Google Tasks, l'agent Architect a détecté une dette technique silencieuse dans la couche d'infrastructure : l'utilisation répétée et permissive du type `any` dans `driveClient.ts` et `markdownToDocs.ts`.
L'utilisateur a validé l'idée de corriger cette dette rapidement. Ce nettoyage a pour but de sécuriser les manipulations de métadonnées de l'API Google Drive et de fiabiliser la gestion des erreurs réseau en empêchant la perte d'informations de typage.

## 2. Fichiers Concernés
- `src/drive/driveClient.ts`
- `src/convert/markdownToDocs.ts`

## 3. Objectifs (Definition of Done)
*   **Sécurité des Métadonnées** : Plus de `const fileMetadata: any = {}`. Utilisation d'interfaces définies explicitement pour les requêtes à l'API Google Drive.
*   **Typage des Erreurs** : Remplacement des `catch (error: any)` par `catch (error: unknown)` avec vérification des cast/instances d'erreurs (ou exploitation des types d'erreurs d'Axios/googleapis).
*   **Fonctions Fortes** : Remplacement de `content: any` dans les signatures (ex: `uploadFile`) par une union stricte (`Buffer | string | Record<string, unknown>`).
*   **Retours API** : Remplacement de `any[]` dans le retour de `convertToGoogleDocs` par les schémas natifs de `googleapis` (`docs_v1.Schema$Request[]`) ou équivalent.
*   Le build TypeScript (`npm run build`) doit passer sans introduire de nouveaux avertissements.
