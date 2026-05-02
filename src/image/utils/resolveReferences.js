// c:\Users\jihad\Desktop\open art\apiOpenArt\src\image\utils\resolveReferences.js

/**
 * resolveOneReference — fetch media + character for one media ID
 */
async function resolveOneReference(db, mediaId, { isBase = false } = {}) {
  // 1. Fetch primary media directly by ID
  let media = await db.media.findById(mediaId)

  if (!media?.url) {
    console.warn(`[resolveReferences] No media found for ID: ${mediaId}`)
    return null
  }

  // Use the actual workflow_id from the media
  const actualWorkflowId = media.workflow_id || mediaId

  // 2. Try to fetch character DNA (optional — never throws)
  let label = null
  let type  = "reference"
  let dna = null

  try {
    // DB method: db.characters.getByWorkflowId(workflow_id)
    const character = await db.characters.getByWorkflowId(actualWorkflowId)
    console.log(`[resolveReferences] Character found for workflow ${actualWorkflowId}:`, character)
    if (character) {
      // ── Character found — enrich reference ──────────────────
      label = character.character_name || null
      type = "character"

      // Use character description if available
      dna = character.description
        ? { description: character.description }
        : null

      console.log(`[resolveReferences] ✅ Character found for workflow ${actualWorkflowId}: ${label}`)
    } else {
      console.log(`[resolveReferences] ℹ️ No character for workflow ${actualWorkflowId} — using as visual reference`)
    }
  } catch (err) {
    // DB method missing or failed — continue without DNA
    console.warn(`[resolveReferences] ⚠️ Character fetch failed for ${actualWorkflowId}: ${err.message}`)
  }

  // 3. Fetch aspect_ratio from config (optional)
  let aspect_ratio = null
  if (media.generation_config_id) {
    try {
      const config = await db.configs.findById(media.generation_config_id)
      aspect_ratio = config?.aspect_ratio || null
    } catch (err) {
      console.warn(`[resolveReferences] Failed to fetch config for ratio: ${err.message}`)
    }
  }

  // 4. Return enriched reference
  return {
    url:      media.url,
    media_id: media.id,
    role:     isBase ? "source" : "reference",
    is_base:  isBase,
    id:       media.id,   // for processPrompt <MediaAsset:id> matching
    label,
    type,
    dna,
    aspect_ratio,
  }
}

/**
 * resolveReferences — main export
 * 
 * @param db              — db instance with media + workflows + characters
 * @param baseMediaId     — the media ID being edited (source/base image)
 * @param referenceMediaIds — array of media IDs to resolve as references
 */
export async function resolveReferences(db, {
  baseMediaId   = null,
  baseWorkflowId = null, // fallback
  referenceMediaIds = [],
  referenceWorkflowIds = [], // fallback
}) {
  const references = []
  const seenUrls   = new Set()

  const finalRefIds = (referenceMediaIds?.length ? referenceMediaIds : referenceWorkflowIds) || [];

  // ── 1. Base image (source) — always first ──────────────────
  if (baseMediaId) {
    const base = await resolveOneReference(db, baseMediaId, { isBase: true })
    if (base) {
      references.push(base)
      seenUrls.add(base.url)
      console.log(`[resolveReferences] 🖼️ Base image resolved: ${base.url}`)
    }
  } else if (baseWorkflowId) {
    // Legacy support: explicitly resolve base workflow to its primary media
    const baseMedia = await db.workflows.getPrimaryMedia(baseWorkflowId);
    if (baseMedia?.id) {
      const base = await resolveOneReference(db, baseMedia.id, { isBase: true })
      if (base) {
        references.push(base)
        seenUrls.add(base.url)
        console.log(`[resolveReferences] 🖼️ Base image resolved from workflow: ${base.url}`)
      }
    }
  }

  // ── 2. Reference images ────────────────────────────────────
  for (const refId of finalRefIds) {
    const ref = await resolveOneReference(db, refId, { isBase: false })
    if (!ref) continue

    // Dedup by URL
    if (seenUrls.has(ref.url)) {
      console.log(`[resolveReferences] ⚠️ Duplicate URL skipped: ${ref.url}`)
      continue
    }

    references.push(ref)
    seenUrls.add(ref.url)
  }

  console.log(`[resolveReferences] ✅ Resolved ${references.length} references`, {
    base:       references.filter(r => r.is_base).length,
    refs:       references.filter(r => !r.is_base).length,
    withDna:    references.filter(r => r.dna).length,
    characters: references.filter(r => r.type === "character").length,
  })

  return references
}
