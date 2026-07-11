# MORAJA - Architecture V2 Edit Media (Compréhension)

## Ce que j'ai compris

### 1. GENERATE (Création)
- **Input** : prompt + references (optionnel)
- **Références** : Images d'inspiration, le modèle les voit mais crée quelque chose de NOUVEAU
- **Résultat** : Nouveau media lié à un nouveau workflow
- **Métaphore** : "Dessine-moi quelque chose comme ça"

```
prompt + [ref1, ref2] → NEW media + NEW workflow
```

### 2. EDIT (Modification)
- **Input** : prompt + source_media (OBLIGATOIRE)
- **Source** : Le media principal à modifier (la cible)
- **Références** : Peut aussi avoir des références supplémentaires (style, etc.)
- **Résultat** : Media modifié lié au même workflow (ou nouveau workflow)
- **Métaphore** : "Prends CETTE image et change-lui le fond"

```
prompt + source_media + [ref1, ref2] → EDITED media
```

## Les 2 Options pour EDIT

### Option A : "Même Workflow" (Versioning)
```
Workflow A (original)
├── media_1 : cat.png (v1) ← primary
│
▼ edit "remove background"
│
Workflow A (même ID)
├── media_1 : cat.png (v1) ← plus primary
├── media_2 : cat_no_bg.png (v2) ← NEW primary
│
▼ edit "add cyberpunk style"
│
Workflow A (même ID)
├── media_1 : cat.png (v1)
├── media_2 : cat_no_bg.png (v2)
├── media_3 : cat_cyberpunk.png (v3) ← NEW primary
```
- **Avantage** : Tout regroupé, historique visible, workflow unique
- **Dans DB** : media ont workflow_id identique, primary_media_id mis à jour
- **UI** : User voit toutes les versions dans le même workflow

### Option B : "Nouveau Workflow" (Séparation)
```
Workflow A (original)
└── media_1 : cat.png

▼ edit "remove background"

Workflow B (NOUVEAU) ← edit!
└── media_2 : cat_no_bg.png
    (parent : media_1 via generation_config_reference)

▼ edit "add cyberpunk style"

Workflow C (NOUVEAU) ← autre edit!
└── media_3 : cat_cyberpunk.png
    (parent : media_2 via generation_config_reference)
```
- **Avantage** : Plus simple, chaque edit est un workflow indépendant
- **Dans DB** : Nouveau workflow + nouveau media à chaque edit
- **UI** : User voit des workflows séparés (comme V1 actuellement)
- **Lien** : Via generation_config_reference (ref_media_id → media parent)

## Ce que je dois implémenter

### Prompt Builder (pour Edit)
- Prend source_media en input
- Construit un prompt qui mentionne explicitement la source :
  ```
  "remove background of [a fluffy orange cat sitting on a couch]"
  ```
- Le provider reçoit :
  ```json
  {
    "prompt": "remove background of a fluffy orange cat...",
    "image": "https://.../cat.png"
  }
  ```

### Media Transform Node
- **Input** : prompt, source_asset, mode, references (optionnel)
- **Modes** : image_edit, image_to_image, video_to_video, image_variation
- **Output** : asset (nouveau media modifié)
- **Différence avec Generate** : OBLIGATOIRE d'avoir source_asset + passe image au provider

### Workflow Edit
```yaml
# edit-image-v1.yaml
input_schema:
  required: [prompt, source_media]
  properties:
    prompt: { type: string }
    source_media: { type: object }
    references: { type: array }
    model: { type: string }
    mode: { type: string }

nodes:
  build_prompt:
    type: prompt-builder
    user_inputs:
      prompt: "${input.prompt}"
      source_asset: "${input.source_media}"
      references: "${input.references}"

  transform:
    type: media-transform
    depends_on: [build_prompt]
    inputs:
      prompt: "${build_prompt.output.finalPrompt}"
      source_asset: "${input.source_media}"
      references: "${input.references}"
      mode: "${input.mode}"
      model: "${input.model}"
```

## Questions pour toi

### 1. Quelle option pour le stockage ?
- A : Même workflow, nouveau media (versioning)
- B : Nouveau workflow à chaque edit
- C : Les DEUX (selon le workflow YAML)

### 2. Le source_media dans Edit :
- a) Doit être un media existant de la DB (avec media_id)
- b) Ou peut être une URL externe aussi

### 3. Références dans Edit :
- a) Edit peut aussi prendre des références (images d'inspiration supplémentaires)
- b) Ou juste source_media + prompt

### 4. Billing :
- Generate image : 1 crédit
- Edit image : 0.5 ou 1 crédit
- Generate vidéo : 10 crédits
- Edit vidéo : 5 crédits

### 5. Node type :
- a) 1 node media-transform avec paramètre mode
- b) 2 nodes séparés : image-edit + video-edit

## Résumé

| | Generate | Edit |
|---|---|---|
| Source | Pas de source (from scratch) | Source obligatoire (media à modifier) |
| Références | Inspiration (optionnel) | Inspiration + source (optionnel) |
| Résultat | Nouveau workflow + media | Nouveau media (même workflow ou nouveau) |
| Prompt | "a cat in space" | "remove background of [a fluffy orange cat]" |
| Provider | generate(prompt, image=null) | generate(prompt, image=source_url) |
| Billing | 1 crédit | 0.5 ou 1 crédit |
| Node V2 | image-generation | media-transform (mode: image_edit) |
